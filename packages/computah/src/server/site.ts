import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AppCommands, AppError, AppProcess, appDir, runStep } from "./app.js";
import { excludeLocally, repoRoot, run } from "./git.js";
import type { Host } from "./hosts.js";
import { type Identity, type Level, levelOf, type Person, slugFor, type Trust } from "./identity.js";
import { Computah, RequestError } from "./jobs.js";
import type { Agent, Job, JobContext } from "./types.js";

export interface SiteOptions {
  /** The app's repository. */
  cwd: string;
  agent: Agent;
  app: AppCommands;
  identity: Identity;
  trust: Trust;
  /** Stop a personal copy nobody has used for this long. Default 20 minutes. */
  idleMs?: number;
  /** Stop a job that runs longer than this. Default 15 minutes. */
  timeoutMs?: number;
  /** Extra environment for the agent. */
  agentEnv?: NodeJS.ProcessEnv;
  /** How many times the agent may try to fix a change that doesn't build. Default 3. */
  repairs?: number;
  /** How long a replaced copy keeps running for pages that are still open on it. Default 2 minutes. */
  lingerMs?: number;
  /**
   * How a change reaches people. Default: build it and swap it in on this machine, which also serves the app.
   * With `push`, the runner pushes each change to a git remote and the app's host builds and serves it.
   */
  release?: { push: PushOptions };
}

export interface PushOptions {
  /** Default "origin". */
  remote?: string;
  /** The branch the host serves to everyone. Default "main". */
  branch?: string;
  /** Who builds what is pushed. Without one, a change counts as live once the push lands. */
  host?: Host;
  /** Run `app.build` on the runner before pushing, to catch a broken build early. Default true when `app.build` is set. */
  check?: boolean;
}

interface Release {
  sha: string;
  dir: string;
  process: AppProcess;
}

/** One line of the app's history that someone is served: everyone's ("main"), or one person's own. */
interface Version {
  id: string;
  branch: string;
  person?: Person;
  workDir: string;
  lane: Computah;
  release?: Release;
  building?: Promise<void>;
  /** A hot-reloading copy the person who asked watches while their change is made. */
  live?: { process: AppProcess; for: string; usedAt: number };
  usedAt: number;
  /** Where the host serves this version, in push mode. */
  url?: string;
  /** True when newer changes to everyone's version couldn't be merged in. */
  stale?: boolean;
}

export interface Me {
  person: Person | null;
  level: Level;
  agent: string;
  /** Which version this person is being served. */
  version: "main" | "mine";
  /** Whether they have a version of their own at all. */
  hasOwn: boolean;
  /** Whether they're on the hot-reloading copy right now. */
  live: boolean;
  stale: boolean;
  /** "swap" when the runner serves the app itself, "push" when a host does. */
  mode: "swap" | "push";
  /** Where their own version is served, when a host serves it at an address of its own. */
  ownUrl?: string;
  /** Other people's versions waiting for the owner, newest first. Owners only. */
  proposals: { id: string; name: string; changes: string[] }[];
}

const DATA = ".computah";
const MAIN = "computah/main";
const GIT_ID = {
  GIT_COMMITTER_NAME: "computah",
  GIT_COMMITTER_EMAIL: "computah@localhost",
  GIT_AUTHOR_NAME: "computah",
  GIT_AUTHOR_EMAIL: "computah@localhost",
};

/** The app as it's served: its versions, who sees which, and how changes reach them. */
export class Site {
  readonly agentName: string;
  private root = "";
  private main!: Version;
  private own = new Map<string, Version>();
  private builds: Promise<unknown> = Promise.resolve();
  private reaper: NodeJS.Timeout | null = null;
  private counts = new Map<string, { day: string; sent: number }>();
  /** Every running copy by a random name, so a page keeps talking to the copy that served it. */
  private copies = new Map<string, AppProcess>();

  constructor(private options: SiteOptions) {
    this.agentName = options.agent.name;
  }

  private git(cwd: string, args: string[]) {
    return run("git", args, { cwd, env: GIT_ID });
  }

  /** Prepare the repo, start everyone's version, and reopen people's own versions. */
  async init() {
    this.root = await repoRoot(this.options.cwd);
    await mkdir(join(this.root, DATA), { recursive: true });
    await excludeLocally(this.root, `${DATA}/`);
    await this.git(this.root, ["worktree", "prune"]);
    if (!(await this.hasBranch(MAIN))) await this.git(this.root, ["branch", MAIN, "HEAD"]);
    this.main = await this.open("main");
    const saved = JSON.parse(await readFile(join(this.root, DATA, "people.json"), "utf8").catch(() => "{}")) as Record<string, Person>;
    for (const [id, person] of Object.entries(saved)) {
      if (await this.hasBranch(`computah/u/${id}`)) this.own.set(id, await this.open(id, person));
    }
    if (!this.push) await this.ensureRelease(this.main);
    this.reaper = setInterval(() => this.reap(), 30_000);
    this.reaper.unref();
  }

  /** True when a host serves the app and this runner only makes changes. */
  get pushes(): boolean {
    return !!this.push;
  }

  get repo() {
    return this.root;
  }

  identify(request: Parameters<Identity>[0]) {
    return this.options.identity(request);
  }

  level(person: Person | null): Level {
    return levelOf(person, this.options.trust);
  }

  // ---------- who sees what ----------

  private versionFor(person: Person | null, wantsMain: boolean): Version {
    if (!person || wantsMain) return this.main;
    return this.own.get(slugFor(person)) ?? this.main;
  }

  private isLive(version: Version, person: Person | null): boolean {
    const live = version.live;
    if (!live || live.process.exited || !person || live.for !== person.id) return false;
    // Stay on the live copy until the built one has caught up with it.
    return version.lane.busy || !!version.building;
  }

  private name(process: AppProcess): string {
    for (const [name, known] of this.copies) if (known === process) return name;
    const name = randomBytes(6).toString("hex");
    this.copies.set(name, process);
    return name;
  }

  /** A copy by name, if it's still running, and whether it's a hot-reloading one. */
  copy(name: string | undefined): { port: number; live: boolean } | null {
    const process = name ? this.copies.get(name) : undefined;
    if (!process || process.exited) {
      if (name) this.copies.delete(name);
      return null;
    }
    const live = [this.main, ...this.own.values()].some((version) => version.live?.process === process);
    return { port: process.port, live };
  }

  /** The copy that should answer this person, starting one if needed. */
  async target(person: Person | null, wantsMain = false): Promise<{ port: number; live: boolean; copy: string }> {
    if (this.push) throw new RequestError("This runner doesn't serve the app. Its host does.", 404);
    const version = this.versionFor(person, wantsMain);
    version.usedAt = Date.now();
    if (this.isLive(version, person) && version.live) {
      version.live.usedAt = Date.now();
      return { port: version.live.process.port, live: true, copy: this.name(version.live.process) };
    }
    if (!version.release || version.release.process.exited) {
      try {
        await this.ensureRelease(version);
      } catch {
        // A person's own version that won't start falls back to everyone's.
        if (version !== this.main) return this.target(null);
        throw new RequestError("The app isn't running.", 503);
      }
    }
    const release = version.release;
    if (!release) throw new RequestError("The app isn't running.", 503);
    return { port: release.process.port, live: false, copy: this.name(release.process) };
  }

  async me(person: Person | null, wantsMain = false): Promise<Me> {
    const level = this.level(person);
    const mine = person ? this.own.get(slugFor(person)) : undefined;
    const version = this.versionFor(person, wantsMain);
    const proposals: Me["proposals"] = [];
    if (level === "owner") {
      for (const other of this.own.values()) {
        if (other === mine) continue;
        const changes = other.lane
          .list()
          .filter((job) => job.state === "done" && (job.files?.length ?? 0) > 0)
          .map((job) => job.text);
        if (changes.length) proposals.push({ id: other.id, name: other.person?.name ?? other.id, changes });
      }
    }
    return {
      person,
      level,
      agent: this.agentName,
      version: version === this.main ? "main" : "mine",
      hasOwn: !!mine,
      live: this.isLive(version, person),
      stale: !!mine?.stale,
      mode: this.push ? "push" : "swap",
      ownUrl: mine?.url,
      proposals,
    };
  }

  // ---------- requests ----------

  async submit(person: Person | null, text: string, context: JobContext, scope: "everyone" | "me" = "everyone"): Promise<Job> {
    const level = this.level(person);
    if (!person || level === "visitor") throw new RequestError("You can't change this app.", 403);
    const personal = level === "member" || scope === "me";
    if (level === "member") this.count(person);
    const version = personal ? await this.ownVersion(person) : this.main;
    return version.lane.submit(text, context, { by: person, version: version.id });
  }

  private count(person: Person) {
    const day = new Date().toISOString().slice(0, 10);
    const entry = this.counts.get(person.id);
    const sent = entry?.day === day ? entry.sent : 0;
    if (sent >= (this.options.trust.memberDailyLimit ?? 20)) throw new RequestError("That's the limit for today. Try again tomorrow.", 429);
    this.counts.set(person.id, { day, sent: sent + 1 });
  }

  /** The requests this person may see: everyone's, their own, and for owners all of them. */
  jobs(person: Person | null): Job[] {
    const level = this.level(person);
    if (!person || level === "visitor") return [];
    const versions = level === "owner" ? [this.main, ...this.own.values()] : [this.main, this.own.get(slugFor(person))];
    return versions
      .flatMap((version) => version?.lane.list() ?? [])
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 100);
  }

  /** Find a job this person may act on. Owners may act on any; others on their own. */
  find(person: Person | null, id: string, toChange = false): { version: Version; job: Job } {
    for (const version of [this.main, ...this.own.values()]) {
      const job = version.lane.get(id);
      if (!job) continue;
      const level = this.level(person);
      const theirs = !!person && job.by?.id === person.id;
      const visible = level === "owner" || theirs || (version === this.main && level !== "visitor");
      if (!visible || (toChange && level !== "owner" && !theirs)) break;
      return { version, job };
    }
    throw new RequestError("No such request.", 404);
  }

  async cancel(person: Person | null, id: string) {
    const { version } = this.find(person, id, true);
    return version.lane.cancel(id);
  }

  async undo(person: Person | null, id: string) {
    const { version, job } = this.find(person, id, true);
    if (version.lane.busy || version.building) throw new RequestError("Wait for the change in progress to finish first.", 409);
    const undone = await version.lane.undo(id);
    await this.release(version, job.id).catch(() => {});
    if (version === this.main) void this.spread();
    return undone;
  }

  // ---------- people's own versions ----------

  private async ownVersion(person: Person): Promise<Version> {
    const id = slugFor(person);
    const existing = this.own.get(id);
    if (existing) return existing;
    const version = await this.open(id, person);
    this.own.set(id, version);
    await this.savePeople();
    return version;
  }

  private async savePeople() {
    const people = Object.fromEntries([...this.own].map(([id, version]) => [id, version.person]));
    await writeFile(join(this.root, DATA, "people.json"), JSON.stringify(people, null, 2));
  }

  /** Make a person's version everyone's. Owners only. */
  async promote(person: Person | null, id: string) {
    if (this.level(person) !== "owner") throw new RequestError("Only an owner can do that.", 403);
    const version = this.own.get(id);
    if (!version) throw new RequestError("No such version.", 404);
    if (this.main.lane.busy || this.main.building || version.lane.busy)
      throw new RequestError("Wait for the change in progress to finish first.", 409);
    const before = await this.head(this.main);
    try {
      await this.git(this.main.workDir, ["merge", "--no-edit", "--no-gpg-sign", version.branch]);
    } catch {
      await this.git(this.main.workDir, ["merge", "--abort"]).catch(() => "");
      throw new RequestError("It conflicts with newer changes. Ask them to send the request again.", 409);
    }
    try {
      await this.release(this.main);
    } catch (error) {
      await this.git(this.main.workDir, ["reset", "--hard", before]);
      throw new RequestError(`It didn't build, so nothing changed. ${firstLine(error)}`, 409);
    }
    await this.remove(version);
    void this.spread();
  }

  /** Throw a person's version away. The owner, or the person themselves. */
  async discard(person: Person | null, id: string) {
    const version = this.own.get(id);
    if (!version) throw new RequestError("No such version.", 404);
    if (this.level(person) !== "owner" && version.person?.id !== person?.id) throw new RequestError("That isn't yours.", 403);
    if (version.lane.busy) throw new RequestError("Wait for the change in progress to finish first.", 409);
    await this.remove(version);
  }

  private async remove(version: Version) {
    this.own.delete(version.id);
    version.live?.process.stop();
    version.release?.process.stop();
    if (version.release) await this.git(this.root, ["worktree", "remove", "--force", version.release.dir]).catch(() => "");
    await this.git(this.root, ["worktree", "remove", "--force", version.workDir]).catch(() => "");
    await this.git(this.root, ["branch", "-D", version.branch]).catch(() => "");
    if (this.push) await this.git(this.root, ["push", this.push.remote ?? "origin", "--delete", version.branch]).catch(() => "");
    await this.savePeople();
  }

  /** Bring everyone's latest into each person's own version, where it merges cleanly. */
  private async spread() {
    for (const version of this.own.values()) {
      if (version.lane.busy || version.building) continue;
      try {
        await this.git(version.workDir, ["merge", "--no-edit", "--no-gpg-sign", MAIN]);
        version.stale = false;
        if (this.push ? !!version.url : version.release && !version.release.process.exited) void this.release(version).catch(() => {});
      } catch {
        await this.git(version.workDir, ["merge", "--abort"]).catch(() => "");
        version.stale = true;
      }
    }
  }

  // ---------- building and serving ----------

  private async hasBranch(branch: string) {
    return this.git(this.root, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]).then(
      () => true,
      () => false,
    );
  }

  private async head(version: Version) {
    return (await this.git(version.workDir, ["rev-parse", "HEAD"])).trim();
  }

  private async open(id: string, person?: Person): Promise<Version> {
    const branch = id === "main" ? MAIN : `computah/u/${id}`;
    const workDir = join(this.root, DATA, "work", id);
    if (!(await this.hasBranch(branch))) await this.git(this.root, ["branch", branch, MAIN]);
    if (!existsSync(workDir)) await this.git(this.root, ["worktree", "add", workDir, branch]);
    const version = { id, branch, person, workDir, usedAt: Date.now() } as Version;
    version.lane = new Computah({
      cwd: workDir,
      agent: this.options.agent,
      commit: true,
      timeoutMs: this.options.timeoutMs,
      env: this.options.agentEnv,
      dataDir: join(this.root, DATA, "jobs", id),
      allowedPaths: (job) => (this.level(job.by ?? null) === "member" ? this.options.trust.memberPaths : undefined),
      onStart: (job) => void this.startLive(version, job),
      verify: (job) => this.afterChange(version, job),
      repairs: this.options.repairs,
    });
    await version.lane.init();
    return version;
  }

  /** While a change is being made, run a hot-reloading copy for the person who asked. */
  private async startLive(version: Version, job: Job) {
    const { app } = this.options;
    // A live copy is reached through the runner's front door, which push mode doesn't have.
    if (!app.dev || !job.by || this.push) return;
    if (version.live && !version.live.process.exited) {
      version.live.for = job.by.id;
      version.live.usedAt = Date.now();
      return;
    }
    try {
      await this.install(version.workDir);
      const process = await AppProcess.start(app.dev, appDir(version.workDir, app), app);
      version.live = { process, for: job.by.id, usedAt: Date.now() };
    } catch {
      // No live copy: they'll see the change when the build is ready instead.
    }
  }

  private async install(dir: string) {
    const { app } = this.options;
    const marker = join(dir, ".computah-installed");
    if (!app.install || existsSync(marker)) return;
    await runStep(app.install, dir, app.env);
    await writeFile(marker, "");
    await excludeLocally(dir, ".computah-installed");
    await excludeLocally(dir, ".computah-built");
  }

  /** A change was committed: build it and swap it in. Returns the build's error if it didn't build. */
  private async afterChange(version: Version, job: Job): Promise<string | null> {
    if (!job.commit) return "The change couldn't be saved.";
    await version.lane.noteRelease(job.id, "building");
    try {
      await this.release(version);
    } catch (error) {
      await version.lane.noteRelease(job.id, "failed", firstLine(error));
      return error instanceof Error ? error.message : String(error);
    }
    job.url = version === this.main ? undefined : version.url;
    await version.lane.noteRelease(job.id, "live");
    if (version === this.main) void this.spread();
    return null;
  }

  private ensureRelease(version: Version): Promise<void> {
    if (version.building) return version.building;
    return this.release(version);
  }

  /** Build the version's latest commit and swap it in. One build runs at a time. */
  private release(version: Version, _reason?: string): Promise<void> {
    const building = this.builds
      .then(() => this.build(version))
      .finally(() => {
        if (version.building === building) version.building = undefined;
      });
    version.building = building;
    this.builds = building.catch(() => {});
    return building;
  }

  private get push(): PushOptions | undefined {
    return this.options.release?.push;
  }

  /** Push mode: check the build here if asked, push the branch, and wait for the host to serve it. */
  private async pushOut(version: Version, push: PushOptions) {
    const { app } = this.options;
    const remote = push.remote ?? "origin";
    const production = version === this.main;
    const target = production ? (push.branch ?? "main") : version.branch;
    if ((push.check ?? true) && app.build) {
      await this.install(version.workDir);
      await runStep(app.build, appDir(version.workDir, app), app.env);
    }
    const send = () => this.git(version.workDir, ["push", remote, `HEAD:refs/heads/${target}`]);
    try {
      await send();
    } catch {
      // Someone else pushed in the meantime: take their work in, then try once more.
      await this.git(version.workDir, ["fetch", remote, target]);
      try {
        await this.git(version.workDir, ["merge", "--no-edit", "--no-gpg-sign", "FETCH_HEAD"]);
      } catch {
        await this.git(version.workDir, ["merge", "--abort"]).catch(() => "");
        throw new AppError("The change conflicts with newer work on the remote.");
      }
      await send();
    }
    const sha = await this.head(version);
    const result = await push.host?.deployed({ sha, branch: target, production });
    version.url = result?.url ?? version.url;
  }

  private async build(version: Version) {
    if (this.push) return this.pushOut(version, this.push);
    const { app } = this.options;
    const sha = await this.head(version);
    if (version.release?.sha === sha && !version.release.process.exited) return;
    const dir = join(this.root, DATA, "releases", `${version.id}-${sha.slice(0, 10)}`);
    if (!existsSync(dir)) await this.git(this.root, ["worktree", "add", "--detach", dir, sha]);
    const built = join(dir, ".computah-built");
    if (!existsSync(built)) {
      await this.install(dir);
      if (app.build) await runStep(app.build, appDir(dir, app), app.env);
      await writeFile(built, "");
    }
    const process = await AppProcess.start(app.start, appDir(dir, app), app);
    const old = version.release;
    version.release = { sha, dir, process };
    if (old) {
      // Pages already open were served by the old copy and still fetch from it, so it lingers before stopping.
      setTimeout(() => {
        old.process.stop();
        if (old.dir !== dir) void this.git(this.root, ["worktree", "remove", "--force", old.dir]).catch(() => "");
      }, this.options.lingerMs ?? 120_000).unref();
    }
  }

  /** Stop copies nobody is using. Everyone's version always stays up. */
  private reap() {
    const idle = this.options.idleMs ?? 20 * 60_000;
    const now = Date.now();
    for (const version of [this.main, ...this.own.values()]) {
      if (version.live && !version.lane.busy && !version.building && now - version.live.usedAt > 5 * 60_000) {
        version.live.process.stop();
        version.live = undefined;
      }
      if (version !== this.main && version.release && !version.lane.busy && now - version.usedAt > idle) {
        version.release.process.stop();
      }
    }
  }

  /** Follow a job's events, wherever it lives. */
  lane(person: Person | null, id: string) {
    return this.find(person, id).version.lane;
  }

  stop() {
    if (this.reaper) clearInterval(this.reaper);
    for (const version of [this.main, ...this.own.values()]) {
      version?.live?.process.stop();
      version?.release?.process.stop();
    }
    for (const process of this.copies.values()) process.stop();
  }
}

function firstLine(error: unknown): string {
  const message = error instanceof AppError || error instanceof Error ? error.message : String(error);
  return message.split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 200) ?? "";
}
