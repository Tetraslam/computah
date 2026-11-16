import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { changedFiles, commitFiles, excludeLocally, GitError, repoRoot, restore, revertCommit, run, snapshot } from "./git.js";
import { buildPrompt } from "./prompt.js";
import type { Agent, Job, JobContext, JobEvent, JobEventBody } from "./types.js";

export interface ComputahOptions {
  /** The repository the agent works in. */
  cwd: string;
  agent: Agent;
  /** Commit each finished change. Skipped for a job that touches files with uncommitted edits. Default true. */
  commit?: boolean;
  /** Stop a job that runs longer than this. Default 15 minutes. */
  timeoutMs?: number;
  /** Longest request accepted, in characters. Default 4000. */
  maxLength?: number;
}

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
  private ready: Promise<void> | null = null;
  private jobs = new Map<string, Job>();
  private events = new Map<string, JobEvent[]>();
  private listeners = new Map<string, Set<Listener>>();
  private queue: string[] = [];
  private current: { id: string; child: ChildProcess | null; cancelled: boolean } | null = null;

  constructor(private options: ComputahOptions) {
    this.agentName = options.agent.name;
  }

  /** Resolve the repo, make the data directory, and load earlier jobs. */
  init(): Promise<void> {
    this.ready ??= (async () => {
      this.root = await repoRoot(this.options.cwd);
      await mkdir(join(this.root, DATA_DIR, "jobs"), { recursive: true });
      await excludeLocally(this.root, `${DATA_DIR}/`);
      for (const name of await readdir(join(this.root, DATA_DIR, "jobs"))) {
        if (!name.endsWith(".json")) continue;
        try {
          const job = JSON.parse(await readFile(join(this.root, DATA_DIR, "jobs", name), "utf8")) as Job;
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

  async submit(text: string, context: JobContext = {}): Promise<Job> {
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
    };
    this.jobs.set(job.id, job);
    this.events.set(job.id, []);
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
    }
    return job;
  }

  async undo(id: string): Promise<Job> {
    const job = this.require(id);
    if (job.state !== "done") throw new RequestError("Only a finished change can be undone.", 409);
    if (this.current) throw new RequestError("Wait for the change in progress to finish first.", 409);
    try {
      if (job.commit) await revertCommit(this.root, job.commit);
      else if (job.before && job.after) await restore(this.root, job.before, job.after);
    } catch (error) {
      throw new RequestError(error instanceof GitError ? error.message : "The change couldn't be undone.", 409);
    }
    await this.finish(job, "undone");
    return job;
  }

  // ---------- internals ----------

  private require(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new RequestError("No such request.", 404);
    return job;
  }

  private eventsPath(id: string) {
    return join(this.root, DATA_DIR, "jobs", `${id}.jsonl`);
  }

  private async save(job: Job) {
    await writeFile(join(this.root, DATA_DIR, "jobs", `${job.id}.json`), JSON.stringify(job, null, 2));
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
      await this.work(job);
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error);
      await this.emit(job.id, { type: "error", message: job.error });
      await this.finish(job, "failed");
    } finally {
      this.current = null;
      void this.drain();
    }
  }

  private async work(job: Job) {
    const current = this.current;
    if (!current) return;
    job.state = "working";
    job.startedAt = Date.now();
    job.before = await snapshot(this.root);
    const dirtyBefore = new Set(
      (await run("git", ["status", "--porcelain", "-z", "--no-renames"], { cwd: this.root }))
        .split("\0")
        .filter(Boolean)
        .map((entry) => entry.slice(3)),
    );
    await this.save(job);
    await this.emit(job.id, { type: "state", state: "working" });

    const { command, args, stdin } = this.options.agent.command(buildPrompt(job.text, job.context), this.root);
    const outcome = await this.runAgent(job, current, command, args, stdin);

    job.after = await snapshot(this.root);
    const files = (await changedFiles(this.root, job.before, job.after)).filter((file) => !file.startsWith(`${DATA_DIR}/`));

    if (current.cancelled || outcome.failed) {
      // Leave the app as it was: a stopped or failed job keeps none of its edits.
      if (files.length) await restore(this.root, job.before, job.after).catch(() => {});
      if (!current.cancelled) {
        job.error = outcome.failed;
        await this.emit(job.id, { type: "error", message: outcome.failed ?? "The agent failed." });
      }
      await this.finish(job, current.cancelled ? "cancelled" : "failed");
      return;
    }

    job.files = files;
    job.summary = outcome.summary || (files.length ? "Done." : "Nothing was changed.");
    const touchesDirty = files.some((file) => dirtyBefore.has(file));
    if (files.length && (this.options.commit ?? true) && !touchesDirty) {
      const subject = job.text.replace(/\s+/g, " ").slice(0, 68);
      job.commit = await commitFiles(this.root, files, `computah: ${subject}\n\n${job.text}\n\nRequested through the improvements box.`).catch(
        () => undefined,
      );
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
        child = spawn(command, args, { cwd: this.root, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      } catch {
        return done(`Couldn't start ${command}.`);
      }
      current.child = child;
      const timer = setTimeout(() => {
        agentError = "It took too long and was stopped.";
        killTree(child);
      }, this.options.timeoutMs ?? 15 * 60_000);

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
        for (const event of this.options.agent.parse(line)) {
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
