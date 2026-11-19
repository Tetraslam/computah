import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  applyPatch,
  archive,
  changedFiles,
  commitFiles,
  excludeLocally,
  GitError,
  repoRoot,
  restore,
  revertCommit,
  run,
  snapshot,
} from "./git.js";
import { outsidePaths } from "./identity.js";
import { buildPrompt, buildRepairPrompt } from "./prompt.js";
import { runInSandbox, type Sandbox } from "./sandbox.js";
import type { Agent, Job, JobContext, JobEvent, JobEventBody } from "./types.js";

export interface ComputahOptions {
  /** The repository the agent works in. */
  cwd: string;
  agent: Agent;
  /** Commit each finished change. Skipped for a job that touches files with uncommitted edits. Default true. */
  commit?: boolean;
  /** Stop a job that runs longer than this. Default 15 minutes. */
  timeoutMs?: number | ((job: Job) => number | undefined);
  /** Longest request accepted, in characters. Default 4000. */
  maxLength?: number;
  /** How many earlier requests the agent is told about, so a follow-up makes sense. Default 8. */
  remember?: number;
  /** Where job records are kept. Default `.computah/jobs` in the repo. */
  dataDir?: string;
  /** Extra environment for the agent process. */
  env?: NodeJS.ProcessEnv;
  /**
   * Choose the agent for one job, and any environment only that job gets (a person's own
   * credentials, say). Return nothing to use `agent`. Throw a RequestError to fail the job with
   * its message, for example when the person has to sign in again.
   */
  agentFor?: (job: Job) => Promise<{ agent: Agent; env?: Record<string, string> } | undefined>;
  /** Globs a job's changes must stay inside, or undefined for anywhere. A job that strays is rolled back. */
  allowedPaths?: (job: Job) => string[] | undefined;
  /** Rules beyond `allowedPaths`, in plain words, told to the agent. */
  limitsNote?: (job: Job) => string | undefined;
  /**
   * Look at what a job changed and object to it. Given each changed file's new contents (null if
   * it was deleted), return why the change isn't acceptable, or null. An objection rolls the job back.
   */
  check?: (job: Job, files: ChangedFile[]) => string | null | Promise<string | null>;
  /** Wraps every agent run, so a caller can limit how many run at once across checkouts. */
  turn?: <T>(run: () => Promise<T>) => Promise<T>;
  /** Where to run the agent for a job, other than on this machine. Return nothing to run it here. */
  sandbox?: (job: Job) => Sandbox | undefined;
  /** Called when a job starts working. */
  onStart?: (job: Job) => void | Promise<void>;
  /**
   * Check a job's committed change, for example by building it. Return what went wrong, or null if it's fine.
   * On a problem the agent is shown it and asked to fix it; if it can't, the whole change is reverted.
   */
  verify?: (job: Job) => Promise<string | null>;
  /** Called after a change that failed its check has been taken back out. */
  onReverted?: (job: Job) => Promise<void>;
  /** How many times the agent may try to fix a failed check. Default 3. */
  repairs?: number;
}

export interface ChangedFile {
  path: string;
  content: string | null;
}

/** What a chore gets to work with. `ask` runs the agent on a prompt in this checkout. */
export type Chore = (tools: {
  job: Job;
  ask: (prompt: string) => Promise<{ summary: string; failed?: string }>;
  cancelled: () => boolean;
}) => Promise<string>;

export class RequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

type Listener = (event: JobEvent) => void;

const DATA_DIR = ".computah";
const KEEP_JOBS = 200;

export class Computah {
  readonly agentName: string;
  private root = "";
  private dataDir = "";
  private ready: Promise<void> | null = null;
  private jobs = new Map<string, Job>();
  private events = new Map<string, JobEvent[]>();
  private listeners = new Map<string, Set<Listener>>();
  private queue: string[] = [];
  private chores = new Map<string, Chore>();
  private current: {
    id: string;
    child: ChildProcess | null;
    cancelled: boolean;
    /** True while this job holds one of the shared agent slots. */
    inTurn?: boolean;
    /** The agent this job runs with, and the environment only it gets. */
    use?: { agent: Agent; env?: Record<string, string> };
    /** Stops an agent that is running somewhere else. */
    away?: () => Promise<void>;
  } | null = null;

  constructor(private options: ComputahOptions) {
    this.agentName = options.agent.name;
  }

  /** Resolve the repo, make the data directory, and load earlier jobs. */
  init(): Promise<void> {
    this.ready ??= (async () => {
      this.root = await repoRoot(this.options.cwd);
      this.dataDir = this.options.dataDir ?? join(this.root, DATA_DIR, "jobs");
      await mkdir(this.dataDir, { recursive: true });
      await excludeLocally(this.root, `${DATA_DIR}/`);
      for (const name of await readdir(this.dataDir)) {
        if (!name.endsWith(".json")) continue;
        try {
          const job = JSON.parse(await readFile(join(this.dataDir, name), "utf8")) as Job;
          // A job that was running when the runner stopped never finished.
          if (job.state === "queued" || job.state === "working") {
            job.state = "failed";
            job.error = "The runner stopped before this finished.";
            job.finishedAt ??= Date.now();
          }
          this.jobs.set(job.id, job);
        } catch {
          // An unreadable record is skipped, not fatal.
        }
      }
    })();
    return this.ready;
  }

  get repo(): string {
    return this.root;
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, KEEP_JOBS);
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  async history(id: string): Promise<JobEvent[]> {
    const live = this.events.get(id);
    if (live) return live;
    const raw = await readFile(this.eventsPath(id), "utf8").catch(() => "");
    const events = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JobEvent);
    this.events.set(id, events);
    return events;
  }

  subscribe(id: string, listener: Listener): () => void {
    const set = this.listeners.get(id) ?? new Set();
    this.listeners.set(id, set);
    set.add(listener);
    return () => set.delete(listener);
  }

  async submit(text: string, context: JobContext = {}, extra: Pick<Job, "by" | "version"> = {}): Promise<Job> {
    await this.init();
    const trimmed = text.trim();
    if (!trimmed) throw new RequestError("Say what should change.");
    if (trimmed.length > (this.options.maxLength ?? 4000)) throw new RequestError("That request is too long.");
    const job: Job = {
      id: `${Date.now().toString(36)}${randomBytes(4).toString("hex")}`,
      text: trimmed,
      context,
      state: "queued",
      agent: this.agentName,
      createdAt: Date.now(),
      ...extra,
    };
    this.jobs.set(job.id, job);
    this.events.set(job.id, []);
    await this.save(job);
    await this.emit(job.id, { type: "state", state: "queued" });
    this.queue.push(job.id);
    void this.drain();
    return job;
  }

  /**
   * Queue a chore: work the runner itself needs done in this checkout, such as bringing in someone
   * else's changes. It waits its turn behind requests, can use the agent, and shows up in the box.
   * Throw from it to fail it; what it returns is its summary.
   */
  async chore(text: string, extra: Pick<Job, "by" | "version">, chore: Chore): Promise<Job> {
    await this.init();
    const job: Job = {
      id: `${Date.now().toString(36)}${randomBytes(4).toString("hex")}`,
      text,
      context: {},
      state: "queued",
      agent: this.agentName,
      createdAt: Date.now(),
      chore: true,
      ...extra,
    };
    this.jobs.set(job.id, job);
    this.events.set(job.id, []);
    this.chores.set(job.id, chore);
    await this.save(job);
    await this.emit(job.id, { type: "state", state: "queued" });
    this.queue.push(job.id);
    void this.drain();
    return job;
  }

  async cancel(id: string): Promise<Job> {
    const job = this.require(id);
    if (job.state === "queued") {
      this.queue = this.queue.filter((queued) => queued !== id);
      await this.finish(job, "cancelled");
    } else if (job.state === "working" && this.current?.id === id) {
      this.current.cancelled = true;
      killTree(this.current.child);
      void this.current.away?.();
    }
    return job;
  }

  async undo(id: string): Promise<Job> {
    const job = this.require(id);
    if (job.state !== "done") throw new RequestError("Only a finished change can be undone.", 409);
    // A job says it's done a moment before it has put everything away. Someone quick enough to
    // undo in that moment is waited for, not refused.
    for (
      let tries = 0;
      tries < 150 && this.current && !["queued", "working"].includes(this.jobs.get(this.current.id)?.state ?? "");
      tries++
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    if (this.current) throw new RequestError("Wait for the change in progress to finish first.", 409);
    try {
      const commits = job.commits ?? (job.commit ? [job.commit] : []);
      for (const commit of [...commits].reverse()) await revertCommit(this.root, commit);
      if (commits.length) {
        // Reverted above.
      } else if (job.before && job.after) await restore(this.root, job.before, job.after);
    } catch (error) {
      throw new RequestError(error instanceof GitError ? error.message : "The change couldn't be undone.", 409);
    }
    await this.finish(job, "undone");
    return job;
  }

  /**
   * The last few requests made in this checkout before `job`, oldest first. Each request runs a
   * fresh agent, so this is what lets a follow-up ("no, bigger") mean something.
   */
  private earlier(job: Job) {
    return [...this.jobs.values()]
      .filter(
        (other) => other.id !== job.id && !other.chore && other.createdAt <= job.createdAt && !["queued", "working"].includes(other.state),
      )
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-(this.options.remember ?? 8))
      .map((other) => ({
        text: other.text,
        state: other.state,
        summary: other.summary ?? other.error,
        commit: other.state === "done" ? other.commit : undefined,
        mine: !job.by || !other.by || other.by.id === job.by.id,
      }));
  }

  private async objection(job: Job, files: string[]): Promise<string | null> {
    const changed = await Promise.all(
      files.map(async (path) => ({ path, content: await readFile(join(this.root, path), "utf8").catch(() => null) })),
    );
    return (await this.options.check?.(job, changed)) ?? null;
  }

  /** Settle which agent this job runs with. Asked once per job, so every step of it uses the same one. */
  private async choose(job: Job, current: NonNullable<Computah["current"]>) {
    if (current.use) return;
    current.use = (await this.options.agentFor?.(job)) ?? { agent: this.options.agent };
    if (current.use.agent.name !== job.agent) {
      job.agent = current.use.agent.name;
      await this.save(job);
    }
  }

  private agentOf(current: NonNullable<Computah["current"]>): Agent {
    return current.use?.agent ?? this.options.agent;
  }

  private timeoutFor(job: Job): number {
    const { timeoutMs } = this.options;
    return (typeof timeoutMs === "function" ? timeoutMs(job) : timeoutMs) ?? 15 * 60_000;
  }

  /** Record where a finished job's change is on its way to being served. */
  async noteRelease(id: string, state: NonNullable<Job["release"]>, message?: string) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.release = state;
    job.releaseError = state === "failed" ? message : undefined;
    await this.save(job);
    await this.emit(id, { type: "release", state, message, ...(state === "live" && job.inPlace ? { inPlace: true } : {}) });
  }

  /** Mark a job undone without touching files, for a caller that reverted it itself. */
  async markUndone(id: string) {
    const job = this.jobs.get(id);
    if (job) await this.finish(job, "undone");
  }

  get busy(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  // ---------- internals ----------

  private require(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new RequestError("No such request.", 404);
    return job;
  }

  private eventsPath(id: string) {
    return join(this.dataDir, `${id}.jsonl`);
  }

  private async save(job: Job) {
    await writeFile(join(this.dataDir, `${job.id}.json`), JSON.stringify(job, null, 2));
  }

  private async emit(id: string, body: JobEventBody) {
    const list = this.events.get(id) ?? [];
    this.events.set(id, list);
    const event = { ...body, seq: list.length, at: Date.now() } as JobEvent;
    list.push(event);
    for (const listener of this.listeners.get(id) ?? []) listener(event);
    await appendFile(this.eventsPath(id), `${JSON.stringify(event)}\n`).catch(() => {});
  }

  private async finish(job: Job, state: Job["state"]) {
    job.state = state;
    job.finishedAt = Date.now();
    await this.save(job);
    await this.emit(job.id, { type: "state", state });
  }

  private async drain() {
    if (this.current) return;
    const id = this.queue.shift();
    if (!id) return;
    const job = this.jobs.get(id);
    if (!job) return void this.drain();
    this.current = { id, child: null, cancelled: false };
    try {
      const chore = this.chores.get(id);
      this.chores.delete(id);
      if (chore) await this.runChore(job, chore);
      else await this.work(job);
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error);
      await this.emit(job.id, { type: "error", message: job.error });
      await this.finish(job, "failed");
    } finally {
      this.current = null;
      void this.drain();
    }
  }

  /** A chore: the runner's own piece of work, done in turn like a request and shown the same way. */
  private async runChore(job: Job, chore: Chore) {
    const current = this.current;
    if (!current) return;
    job.state = "working";
    job.startedAt = Date.now();
    await this.save(job);
    await this.emit(job.id, { type: "state", state: "working" });
    job.summary = await chore({
      job,
      ask: async (prompt) => {
        try {
          await this.choose(job, current);
        } catch (error) {
          return { summary: "", failed: error instanceof Error ? error.message : "Couldn't start the agent." };
        }
        const { command, args, stdin } = this.agentOf(current).command(prompt, this.root);
        return this.runAgent(job, current, command, args, stdin);
      },
      cancelled: () => current.cancelled,
    });
    await this.finish(job, current.cancelled ? "cancelled" : "done");
  }

  private async work(job: Job) {
    const current = this.current;
    if (!current) return;
    job.state = "working";
    job.startedAt = Date.now();
    job.before = await snapshot(this.root);
    const dirtyBefore = new Set(
      (
        await run("git", ["status", "--porcelain", "-z", "--no-renames"], {
          cwd: this.root,
        })
      )
        .split("\0")
        .filter(Boolean)
        .map((entry) => entry.slice(3)),
    );
    await this.save(job);
    await this.emit(job.id, { type: "state", state: "working" });
    await this.options.onStart?.(job);

    let refused = "";
    await this.choose(job, current).catch((error: unknown) => {
      refused = error instanceof Error ? error.message : "Couldn't start the agent.";
    });
    const { command, args, stdin } = this.agentOf(current).command(
      buildPrompt(
        job.text,
        job.context,
        { paths: this.options.allowedPaths?.(job), note: this.options.limitsNote?.(job) },
        this.earlier(job),
      ),
      this.root,
    );
    const outcome = refused ? { summary: "", failed: refused } : await this.runAgent(job, current, command, args, stdin);

    job.after = await snapshot(this.root);
    const files = (await changedFiles(this.root, job.before, job.after)).filter((file) => !file.startsWith(`${DATA_DIR}/`));

    if (current.cancelled || outcome.failed) {
      // Leave the app as it was: a stopped or failed job keeps none of its edits.
      if (files.length) await restore(this.root, job.before, job.after).catch(() => {});
      if (!current.cancelled) {
        job.error = outcome.failed;
        await this.emit(job.id, {
          type: "error",
          message: outcome.failed ?? "The agent failed.",
        });
      }
      await this.finish(job, current.cancelled ? "cancelled" : "failed");
      return;
    }

    const stray = outsidePaths(files, this.options.allowedPaths?.(job));
    if (stray.length) {
      await restore(this.root, job.before, job.after).catch(() => {});
      job.error = `That would change parts of the app you can't change here (${stray.slice(0, 3).join(", ")}).`;
      await this.emit(job.id, { type: "error", message: job.error });
      await this.finish(job, "failed");
      return;
    }

    const objection = files.length && this.options.check ? await this.objection(job, files) : null;
    if (objection) {
      await restore(this.root, job.before, job.after).catch(() => {});
      job.error = objection;
      await this.emit(job.id, { type: "error", message: job.error });
      await this.finish(job, "failed");
      return;
    }

    job.files = files;
    job.summary = outcome.summary || (files.length ? "Done." : "Nothing was changed.");
    const touchesDirty = files.some((file) => dirtyBefore.has(file));
    if (files.length && (this.options.commit ?? true) && !touchesDirty) {
      const subject = job.text.replace(/\s+/g, " ").slice(0, 68);
      job.commit = await commitFiles(
        this.root,
        files,
        `computah: ${subject}\n\n${job.text}\n\nRequested through the improvements box${job.by ? ` by ${job.by.name ?? job.by.id}` : ""}.`,
        job.by?.name ?? job.by?.id,
      ).catch(() => undefined);
    }
    if (job.commit) job.commits = [job.commit];
    if (files.length && this.options.verify) {
      // Check the change. If the check fails, show the agent what went wrong and let it fix it, a few times.
      // A check that throws has hit something the agent can't fix: the change comes out without a repair attempt.
      let fatal = "";
      const check = () =>
        this.options.verify?.(job).catch((error: unknown) => {
          fatal = error instanceof Error ? error.message : String(error);
          return fatal;
        }) ?? Promise.resolve(null);
      let problem = await check();
      for (let attempt = 1; problem && !fatal && attempt <= (this.options.repairs ?? 3) && !current.cancelled; attempt++) {
        await this.emit(job.id, { type: "text", text: `It didn't build. Fixing it (try ${attempt}).` });
        const fix = this.agentOf(current).command(buildRepairPrompt(job.text, problem), this.root);
        const repaired = await this.runAgent(job, current, fix.command, fix.args, fix.stdin);
        if (current.cancelled || repaired.failed) break;
        if (repaired.summary) job.summary = repaired.summary;
        const now = await snapshot(this.root);
        const fixed = (await changedFiles(this.root, job.after, now)).filter((file) => !file.startsWith(`${DATA_DIR}/`));
        if (!fixed.length) break;
        // A fix is held to the same limits as the change it fixes. One that breaks them is dropped
        // before anything else happens, so the commits underneath can be reverted cleanly.
        if (outsidePaths(fixed, this.options.allowedPaths?.(job)).length || (this.options.check && (await this.objection(job, fixed)))) {
          await restore(this.root, job.after, now).catch(() => {});
          break;
        }
        job.after = now;
        job.files = [...new Set([...job.files, ...fixed])];
        const commit = await commitFiles(
          this.root,
          fixed,
          `computah: fix the build for "${job.text.replace(/\s+/g, " ").slice(0, 50)}"`,
          job.by?.name ?? job.by?.id,
        ).catch(() => undefined);
        if (commit) job.commits = [...(job.commits ?? []), commit];
        problem = await check();
      }
      if (problem || current.cancelled) {
        // Still broken: take the whole change back out, so the app stays as it was.
        for (const commit of [...(job.commits ?? [])].reverse()) await revertCommit(this.root, commit).catch(() => {});
        if (!job.commits?.length) await restore(this.root, job.before, job.after).catch(() => {});
        await this.options.onReverted?.(job)?.catch(() => {});
        if (current.cancelled) return void (await this.finish(job, "cancelled"));
        job.error = fatal
          ? `${fatal} Nothing changed.`
          : `It still didn't build after trying to fix it, so nothing changed. ${lastLine(problem ?? "")}`;
        await this.emit(job.id, { type: "error", message: job.error });
        await this.finish(job, "failed");
        return;
      }
    }
    await this.finish(job, "done");
  }

  private runAgent(
    job: Job,
    current: NonNullable<Computah["current"]>,
    command: string,
    args: string[],
    stdin: string | undefined,
  ): Promise<{ summary: string; failed?: string }> {
    const turn = this.options.turn;
    if (turn && !current.inTurn) {
      // Agents are a shared resource: wait for a free one, and say so if it takes a moment.
      current.inTurn = true;
      const note = setTimeout(() => void this.emit(job.id, { type: "tool", name: "queue", detail: "waiting for a free agent" }), 1500);
      return turn(() => {
        clearTimeout(note);
        return this.runAgent(job, current, command, args, stdin);
      }).finally(() => {
        clearTimeout(note);
        current.inTurn = false;
      });
    }
    const sandbox = this.options.sandbox?.(job);
    if (sandbox) return this.runAway(job, current, sandbox, { command, args, stdin, env: current.use?.env });
    return new Promise((resolve) => {
      let lastText = "";
      let result = "";
      let agentError = "";
      let stderrTail = "";
      let settled = false;
      const done = (failed?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ summary: (result || lastText).trim(), failed });
      };

      let child: ChildProcess;
      try {
        child = spawn(command, args, {
          cwd: this.root,
          env: { ...process.env, ...this.options.env, ...current.use?.env },
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        return done(`Couldn't start ${command}.`);
      }
      current.child = child;
      const timer = setTimeout(() => {
        agentError = "It took too long and was stopped.";
        killTree(child);
      }, this.timeoutFor(job));

      child.on("error", (error: NodeJS.ErrnoException) =>
        done(error.code === "ENOENT" ? `${command} isn't installed or isn't on the PATH.` : `Couldn't start ${command}.`),
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(stdin ?? "");
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-600);
      });
      const lines = createInterface({ input: child.stdout ?? process.stdin });
      lines.on("line", (line) => {
        for (const event of this.agentOf(current).parse(line)) {
          if (event.type === "result") result = event.text;
          else if (event.type === "error") {
            agentError = event.message;
          } else {
            if (event.type === "text") lastText = event.text;
            void this.emit(job.id, event);
          }
        }
      });
      child.on("close", (code) => {
        if (agentError) done(agentError);
        else if (code !== 0 && !current.cancelled) done(stderrTail.trim().split("\n").pop() || `${command} exited with code ${code}.`);
        else done();
      });
    });
  }

  /** Run the agent in a sandbox on a copy of the code, then bring its changes back as a patch. */
  private async runAway(
    job: Job,
    current: NonNullable<Computah["current"]>,
    sandbox: Sandbox,
    agent: { command: string; args: string[]; stdin?: string; env?: Record<string, string> },
  ): Promise<{ summary: string; failed?: string }> {
    let lastText = "";
    let result = "";
    let agentError = "";
    let session: Awaited<ReturnType<Sandbox["open"]>> | null = null;
    const timer = setTimeout(() => {
      agentError = "It took too long and was stopped.";
      void session?.close();
    }, this.timeoutFor(job));
    try {
      await this.emit(job.id, { type: "tool", name: "sandbox", detail: `starting a ${sandbox.name} sandbox` });
      session = await sandbox.open();
      current.away = () => session?.close() ?? Promise.resolve();
      if (current.cancelled) return { summary: "" };
      const tar = await archive(this.root, await snapshot(this.root));
      const outcome = await runInSandbox(session, tar, agent, (line) => {
        for (const event of this.agentOf(current).parse(line)) {
          if (event.type === "result") result = event.text;
          else if (event.type === "error") agentError = event.message;
          else {
            if (event.type === "text") lastText = event.text;
            void this.emit(job.id, event);
          }
        }
      });
      if (current.cancelled) return { summary: "" };
      if (agentError) return { summary: "", failed: agentError };
      if (outcome.code !== 0)
        return { summary: "", failed: outcome.stderr.trim().split("\n").pop() || `${agent.command} exited with code ${outcome.code}.` };
      await applyPatch(this.root, outcome.patch);
      return { summary: (result || lastText).trim() };
    } catch (error) {
      if (current.cancelled) return { summary: "" };
      return { summary: "", failed: agentError || (error instanceof Error ? error.message : "The sandbox failed.") };
    } finally {
      clearTimeout(timer);
      current.away = undefined;
      await session?.close().catch(() => {});
    }
  }
}

/** Stop the agent and everything it started. */
function killTree(child: ChildProcess | null) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    try {
      if (child.pid && child.exitCode === null) process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }, 3000).unref();
}

function lastLine(text: string): string {
  return text.trim().split("\n").filter(Boolean).pop()?.slice(0, 200) ?? "";
}
