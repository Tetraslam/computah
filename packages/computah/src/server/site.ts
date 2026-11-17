import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AppCommands, AppError, AppProcess, appDir, runStep } from "./app.js";
import { excludeLocally, gitIdentity, repoRoot, run } from "./git.js";
import type { Host } from "./hosts.js";
import { GUEST_COOKIE, guestFrom, guestToken, type Identity, type Level, levelOf, type Person, slugFor, type Trust } from "./identity.js";
import { Computah, RequestError } from "./jobs.js";
import { buildMergePrompt } from "./prompt.js";
import type { Sandbox } from "./sandbox.js";
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
  /**
   * Let people who aren't signed in take part, as guests remembered by a signed cookie. A guest
   * is a member like any other, so `trust.members` must be "everyone" for them to do anything.
   * `forgetMs` removes a guest's version once they've been away that long.
   */
  guests?: { secret: string; forgetMs?: number; keep?: number };
  /**
   * The most builds running at once. Default 1. A build uses a few CPUs by itself, so 2 suits a
   * machine with 8 or more, and more than that rarely helps.
   */
  maxBuilds?: number;
  /** The most agents working at once, across everyone. The rest wait their turn. Default 6. */
  maxAgents?: number;
  /** The most personal copies running at once. Starting one more stops the least recently used. Default: no limit. */
  maxCopies?: number;
  /**
   * Run the agent away from this machine, on a copy of the code. `for: "members"` (the default)
   * sandboxes only people who aren't owners or trusted; `"everyone"` sandboxes every request.
   */
  sandbox?: { in: Sandbox; for?: "members" | "everyone" };
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
  /** True while the agent is merging everyone's latest into this version. */
  catching?: boolean;
  /** The commit of everyone's version that catching up was last tried against. */
  gaveUpAt?: string;
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
  /** True while their own version is being built or started and they're being shown everyone's meanwhile. */
  waiting: boolean;
  /** True for someone not signed in who could take part as a guest by asking. */
  canJoin: boolean;
  /** For a member: what they're allowed to change, in the owner's words. */
  note?: string;
  /** "swap" when the runner serves the app itself, "push" when a host does. */
  mode: "swap" | "push";
  /** Where their own version is served, when a host serves it at an address of its own. */
  ownUrl?: string;
  /** Other people's versions waiting for the owner, newest first. Owners only. */
  proposals: { id: string; name: string; changes: string[] }[];
}

const DATA = ".computah";
const MAIN = "computah/main";

/** The app as it's served: its versions, who sees which, and how changes reach them. */
export class Site {
  readonly agentName: string;
  private root = "";
  private main!: Version;
  private own = new Map<string, Version>();
  /** How many builds are running right now, and which are waiting for a place. */
  private builds = { running: 0, waiting: [] as (() => void)[] };
  private reaper: NodeJS.Timeout | null = null;
  private counts = new Map<string, { day: string; sent: number }>();
  /** Every running copy by a random name, so a page keeps talking to the copy that served it. */
  private copies = new Map<string, AppProcess>();
  private identity: Promise<NodeJS.ProcessEnv> | null = null;
  private lingering = new Set<string>();
  private tidying = false;
  /** How many agents are running right now, and who is waiting for a turn. */
  private agents = { running: 0, waiting: [] as (() => void)[] };

  constructor(private options: SiteOptions) {
    this.agentName = options.agent.name;
  }

  private git(cwd: string, args: string[]) {
    this.identity ??= gitIdentity(this.options.cwd).then((identity) => identity.env);
    return this.identity.then((env) => run("git", args, { cwd, env }));
  }

  /** Prepare the repo, start everyone's version, and reopen people's own versions. */
  async init() {
    this.root = await repoRoot(this.options.cwd);
    await mkdir(join(this.root, DATA), { recursive: true });
    await excludeLocally(this.root, `${DATA}/`);
    await this.git(this.root, ["worktree", "prune"]);
    if (!(await this.hasBranch(MAIN))) await this.git(this.root, ["branch", MAIN, "HEAD"]);
    this.main = await this.open("main");
    const saved = JSON.parse(await readFile(join(this.root, DATA, "people.json"), "utf8").catch(() => "{}")) as Record<
      string,
      Person & { url?: string }
    >;
    for (const [id, entry] of Object.entries(saved)) {
      if (!(await this.hasBranch(`computah/u/${id}`))) continue;
      const version = await this.open(id, { id: entry.id, name: entry.name });
      version.url = entry.url;
      this.own.set(id, version);
    }
    if (!this.push) await this.ensureRelease(this.main);
    void this.tidy();
    // Everyone's version may have moved while the runner was down (a deploy, say): bring people's own versions up to it.
    void this.spread();
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

  /** Who sent a request: someone signed in, or failing that a guest, if guests are allowed. */
  async identify(request: Parameters<Identity>[0]): Promise<Person | null> {
    const person = await this.options.identity(request);
    if (person || !this.options.guests) return person;
    return guestFrom(request, this.options.guests.secret);
  }

  /** A cookie that makes whoever holds it a guest from now on. Null when guests aren't allowed. */
  welcome(): string | null {
    const secret = this.options.guests?.secret;
    if (!secret) return null;
    return `${GUEST_COOKIE}=${guestToken(secret, randomBytes(9).toString("hex"))}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`;
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
      // If their copy still has to be built, don't make them wait for it: show everyone's version
      // meanwhile. The box tells them, and moves them over when theirs is ready.
      // The commit is read once and that exact commit is started, so a merge landing in between
      // can't turn "it's built, start it" into "wait for a build".
      const sha = version === this.main ? undefined : await this.head(version);
      if (sha && !existsSync(join(this.releaseDir(version, sha), ".computah-built"))) {
        if (!version.building) void this.ensureRelease(version).catch(() => {});
        return this.target(null);
      }
      try {
        if (version.building) await version.building;
        if (!version.release || version.release.process.exited) await this.release(version, sha);
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
    // They're here, and their version is behind: start catching it up.
    if (mine?.stale) this.catchUp(mine);
    const version = this.versionFor(person, wantsMain);
    const proposals: Me["proposals"] = [];
    if (level === "owner") {
      for (const other of this.own.values()) {
        if (other === mine) continue;
        const changes = other.lane
          .list()
          .filter((job) => !job.chore && job.state === "done" && (job.files?.length ?? 0) > 0)
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
      canJoin: !person && !!this.options.guests,
      waiting: !!mine && !wantsMain && !this.push && (!mine.release || mine.release.process.exited) && !this.isLive(mine, person),
      note: level === "member" ? this.options.trust.memberNote : undefined,
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
    const all = this.counts.get("*");
    const total = all?.day === day ? all.sent : 0;
    const cap = this.options.trust.dailyLimit;
    if (cap !== undefined && total >= cap)
      throw new RequestError("This app has taken all the requests it can today. Try again tomorrow.", 429);
    this.counts.set(person.id, { day, sent: sent + 1 });
    this.counts.set("*", { day, sent: total + 1 });
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
      // Owners may act on anything. Trusted people may act on everyone's version, which they can change anyway.
      const mayChange = level === "owner" || theirs || (level === "trusted" && version === this.main);
      if (!visible || (toChange && !mayChange)) break;
      return { version, job };
    }
    throw new RequestError("No such request.", 404);
  }

  async cancel(person: Person | null, id: string) {
    const { version } = this.find(person, id, true);
    return version.lane.cancel(id);
  }

  async undo(person: Person | null, id: string) {
    const { version } = this.find(person, id, true);
    // A build that's under way is seconds from done, so wait for it instead of refusing.
    if (version.building) await version.building.catch(() => {});
    if (version.lane.busy) throw new RequestError("Wait for the change in progress to finish first.", 409);
    const undone = await version.lane.undo(id);
    await this.release(version).catch(() => {});
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
    const people = Object.fromEntries([...this.own].map(([id, version]) => [id, { ...version.person, url: version.url }]));
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
    await this.git(this.root, ["worktree", "remove", "--force", version.workDir]).catch(() => "");
    await this.git(this.root, ["branch", "-D", version.branch]).catch(() => "");
    if (this.push) await this.git(this.root, ["push", this.push.remote ?? "origin", "--delete", version.branch]).catch(() => "");
    await this.savePeople();
    await this.tidy();
  }

  /**
   * Delete builds nothing needs any more. A build is kept if it's a version's latest commit, is
   * running, or was replaced so recently that open pages may still be fetching from it.
   */
  private async tidy() {
    if (this.push || this.tidying) return;
    this.tidying = true;
    try {
      const folder = join(this.root, DATA, "releases");
      const keep = new Set(this.lingering);
      for (const version of [this.main, ...this.own.values()]) {
        if (!version) continue;
        if (version.release) keep.add(version.release.dir);
        keep.add(this.releaseDir(version, await this.head(version).catch(() => "")));
      }
      for (const name of await readdir(folder).catch(() => [] as string[])) {
        const dir = join(folder, name);
        if (keep.has(dir)) continue;
        await this.git(this.root, ["worktree", "remove", "--force", dir]).catch(() => "");
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
      await this.git(this.root, ["worktree", "prune"]).catch(() => "");
    } finally {
      this.tidying = false;
    }
  }

  /** Keep at most `guests.keep` guest versions, forgetting whoever was here longest ago. */
  private trimGuests() {
    const limit = this.options.guests?.keep;
    if (limit === undefined) return;
    const guests = [...this.own.values()].filter((version) => version.person?.id.startsWith("guest:")).sort((a, b) => a.usedAt - b.usedAt);
    for (const version of guests.slice(0, Math.max(0, guests.length - limit))) {
      if (!version.lane.busy && !version.building) void this.remove(version);
    }
  }

  /** Bring everyone's latest into each person's own version, where it merges cleanly. */
  private async spread() {
    for (const version of this.own.values()) {
      if (version.lane.busy || version.building) continue;
      try {
        await this.git(version.workDir, ["merge", "--no-edit", "--no-gpg-sign", MAIN]);
        version.stale = false;
        if (this.push) {
          if (version.url) void this.release(version).catch(() => {});
        } else if (version.release && !version.release.process.exited) {
          void this.release(version).catch(() => {});
        } else {
          // Nobody is on this copy right now. Build it anyway, so it's ready when they come back.
          this.prebuild(version);
        }
      } catch {
        // It conflicts. Leave their version as it was for now; the agent sorts it out when they next show up.
        await this.git(version.workDir, ["merge", "--abort"]).catch(() => "");
        version.stale = true;
      }
    }
  }

  /**
   * A person's version conflicts with everyone's latest: have the agent merge the two, keeping
   * what everyone's version changed and what this person asked for. If it can't, their version
   * stays exactly as it was.
   */
  private catchUp(version: Version) {
    if (!version.stale || version.catching || version === this.main) return;
    version.catching = true;
    const person = version.person ?? null;
    const member = this.level(person) === "member";
    void this.head(this.main)
      .then((latest) => {
        // One try per state of everyone's version. If it failed against this one, wait for the next.
        if (version.gaveUpAt === latest) {
          version.catching = false;
          return;
        }
        version.gaveUpAt = latest;
        return this.settle(version, member);
      })
      .catch(() => {
        version.catching = false;
      });
  }

  private settle(version: Version, member: boolean) {
    return version.lane
      .chore("catch up with everyone's version", { by: version.person, version: version.id }, async ({ ask, cancelled }) => {
        const before = await this.head(version);
        const undo = async () => {
          await this.git(version.workDir, ["merge", "--abort"]).catch(() => "");
          await this.git(version.workDir, ["reset", "--hard", before]).catch(() => "");
        };
        try {
          const clean = await this.git(version.workDir, ["merge", "--no-commit", "--no-ff", "--no-gpg-sign", MAIN]).then(
            () => true,
            () => false,
          );
          let summary = "caught up with everyone's version.";
          if (!clean) {
            const conflicted = (await this.git(version.workDir, ["diff", "--name-only", "--diff-filter=U", "-z"]))
              .split("\0")
              .filter(Boolean);
            if (!conflicted.length) throw new Error("The merge failed.");
            const asked = version.lane
              .list()
              .filter((job) => !job.chore && job.state === "done" && (job.files?.length ?? 0) > 0)
              .reverse()
              .map((job) => job.text);
            const rules = member ? (this.options.trust.memberRules ?? this.options.trust.memberNote) : undefined;
            const outcome = await ask(buildMergePrompt(conflicted, asked, { note: rules }));
            if (cancelled() || outcome.failed) throw new Error(outcome.failed ?? "Stopped.");
            // The agent may only have resolved the conflicted files, and must have resolved all of them.
            const touched = (await this.git(version.workDir, ["diff", "--name-only", "-z"])).split("\0").filter(Boolean);
            const stray = touched.filter((file) => !conflicted.includes(file));
            if (stray.length) throw new Error("It changed files that weren't part of the conflict.");
            const contents = await Promise.all(
              conflicted.map(async (path) => ({ path, content: await readFile(join(version.workDir, path), "utf8").catch(() => null) })),
            );
            if (contents.some(({ content }) => content !== null && /^(<{7}|>{7}) |^={7}$/m.test(content)))
              throw new Error("It left conflict markers behind.");
            const objection = member ? this.options.trust.memberCheck?.(contents) : null;
            if (objection) throw new Error(objection);
            await this.git(version.workDir, ["add", "-A", "--", ...conflicted]);
            if (outcome.summary) summary = outcome.summary;
          }
          await this.git(version.workDir, ["commit", "--no-edit", "--no-gpg-sign", "-m", "computah: catch up with everyone's version"]);
          try {
            await this.release(version);
          } catch (error) {
            throw new Error(`It merged but didn't build. ${firstLine(error)}`);
          }
          version.stale = false;
          return summary;
        } catch (error) {
          await undo();
          throw new Error(
            `Couldn't catch up with everyone's version, so yours is as it was. ${error instanceof Error ? error.message : ""}`.trim(),
          );
        } finally {
          version.catching = false;
        }
      })
      .catch(() => {
        version.catching = false;
      });
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
      limitsNote: (job) =>
        this.level(job.by ?? null) === "member" ? (this.options.trust.memberRules ?? this.options.trust.memberNote) : undefined,
      check: (job, files) => (this.level(job.by ?? null) === "member" ? (this.options.trust.memberCheck?.(files) ?? null) : null),
      onStart: (job) => void this.startLive(version, job),
      sandbox: (job) => this.sandboxFor(job),
      turn: (run) => this.takeTurn(run),
      verify: (job) => this.afterChange(version, job),
      repairs: this.options.repairs,
      // In push mode the failed commits already reached the remote, so their reverts must follow them.
      onReverted: async () => {
        const push = this.push;
        if (!push) return;
        const target = version === this.main ? (push.branch ?? "main") : version.branch;
        await this.git(version.workDir, ["push", push.remote ?? "origin", `HEAD:refs/heads/${target}`]);
      },
    });
    await version.lane.init();
    return version;
  }

  /** Run something that uses an agent, at most `maxAgents` at a time across every version. */
  private async takeTurn<T>(run: () => Promise<T>): Promise<T> {
    const limit = this.options.maxAgents ?? 6;
    if (this.agents.running >= limit) await new Promise<void>((resolve) => this.agents.waiting.push(resolve));
    this.agents.running++;
    try {
      return await run();
    } finally {
      this.agents.running--;
      this.agents.waiting.shift()?.();
    }
  }

  private sandboxFor(job: Job): Sandbox | undefined {
    const rule = this.options.sandbox;
    if (!rule) return undefined;
    return rule.for === "everyone" || this.level(job.by ?? null) === "member" ? rule.in : undefined;
  }

  /** While a change is being made, run a hot-reloading copy for the person who asked. */
  private async startLive(version: Version, job: Job) {
    const { app } = this.options;
    // A live copy is reached through the runner's front door, which push mode doesn't have.
    // A sandboxed agent's changes arrive all at once at the end, so there is nothing to watch live.
    if (!app.dev || !job.by || this.push || this.sandboxFor(job)) return;
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
      // Something the agent can't fix by editing code, such as the host refusing the deployment.
      if (error instanceof AppError && error.unfixable) throw error;
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

  /**
   * Run a build in its turn: after any build this version already has going, and with at most
   * `maxBuilds` running across every version.
   */
  private inLine<T>(version: Version, run: () => Promise<T>): Promise<T> {
    const earlier = (version.building ?? Promise.resolve()).catch(() => {});
    return earlier.then(async () => {
      const limit = Math.max(1, this.options.maxBuilds ?? 1);
      if (this.builds.running >= limit) await new Promise<void>((resolve) => this.builds.waiting.push(resolve));
      else this.builds.running++;
      try {
        return await run();
      } finally {
        // A waiting build is handed this one's place directly, so nothing can slip in ahead of it.
        const next = this.builds.waiting.shift();
        if (next) next();
        else this.builds.running--;
      }
    });
  }

  /** Build the version's latest commit and swap it in. */
  private release(version: Version, sha?: string): Promise<void> {
    const building = this.inLine(version, () => this.build(version, sha)).finally(() => {
      if (version.building === building) version.building = undefined;
    });
    version.building = building;
    building.catch(() => {});
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
    if (!production) await this.savePeople();
  }

  private releaseDir(version: Version, sha: string) {
    return join(this.root, DATA, "releases", `${version.id}-${sha.slice(0, 10)}`);
  }

  /** Build a commit into its own folder without starting it. Starting it later takes a moment, not a build. */
  private async prepare(version: Version, sha: string): Promise<string> {
    const { app } = this.options;
    const dir = this.releaseDir(version, sha);
    if (!existsSync(dir)) await this.git(this.root, ["worktree", "add", "--detach", dir, sha]);
    const built = join(dir, ".computah-built");
    if (!existsSync(built)) {
      await this.install(dir);
      if (app.build) await runStep(app.build, appDir(dir, app), app.env);
      await writeFile(built, "");
    }
    return dir;
  }

  /** Build a version's latest commit ahead of time, in turn with other builds, so its person doesn't wait for it. */
  private prebuild(version: Version) {
    const building = this.inLine(version, async () => {
      const sha = await this.head(version);
      await this.prepare(version, sha);
      // If they came back meanwhile and are on an older build, move them to this one.
      if (version.release && !version.release.process.exited && version.release.sha !== sha) await this.build(version, sha);
    })
      .catch(() => {})
      .finally(() => {
        if (version.building === building) version.building = undefined;
      });
    version.building = building;
  }

  /** Build (if needed) and start a commit of this version, by default its latest, and swap it in. */
  private async build(version: Version, at?: string) {
    if (this.push) return this.pushOut(version, this.push);
    const { app } = this.options;
    const sha = at ?? (await this.head(version));
    if (version.release?.sha === sha && !version.release.process.exited) return;
    const dir = await this.prepare(version, sha);
    this.makeRoom(version);
    const process = await AppProcess.start(app.start, appDir(dir, app), app);
    const old = version.release;
    version.release = { sha, dir, process };
    if (old) {
      // Pages already open were served by the old copy and still fetch from it, so it lingers before stopping.
      if (old.dir !== dir) this.lingering.add(old.dir);
      setTimeout(() => {
        old.process.stop();
        this.lingering.delete(old.dir);
        void this.tidy();
      }, this.options.lingerMs ?? 120_000).unref();
    }
  }

  /** Before starting a person's copy, stop the least recently used ones if too many are running. */
  private makeRoom(starting: Version) {
    const max = this.options.maxCopies;
    if (max === undefined || starting === this.main) return;
    const running = [...this.own.values()]
      .filter((version) => version !== starting && version.release && !version.release.process.exited && !version.lane.busy)
      .sort((a, b) => a.usedAt - b.usedAt);
    while (running.length >= max) running.shift()?.release?.process.stop();
  }

  /** Stop copies nobody is using. Everyone's version always stays up. */
  private reap() {
    this.trimGuests();
    void this.tidy();
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
      // A guest who hasn't come back is forgotten, along with their version.
      const forget = this.options.guests?.forgetMs;
      if (
        forget !== undefined &&
        version.person?.id.startsWith("guest:") &&
        !version.lane.busy &&
        !version.building &&
        now - version.usedAt > forget
      ) {
        void this.remove(version);
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
