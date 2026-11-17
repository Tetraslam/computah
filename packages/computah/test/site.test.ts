import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { get, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFrontServer, refuseWrite } from "../src/server/front.js";
import { clientOnly, globToRegExp, header, levelOf, outsidePaths, slugFor } from "../src/server/identity.js";
import { asLocal } from "../src/server/proxy.js";
import { Site } from "../src/server/site.js";
import type { Agent, Job } from "../src/server/types.js";

/**
 * A whole app in three files: `page.txt` is the source, the build copies it to
 * `built.txt` (and refuses the word "broken"), and `server.js` serves the built file.
 */
const SERVER = `
const http = require("node:http");
const fs = require("node:fs");
const dev = process.argv[2] === "dev";
http.createServer((request, response) => {
  response.setHeader("content-type", "text/plain");
  response.end((dev ? "dev:" : "") + fs.readFileSync(dev ? "page.txt" : "built.txt", "utf8"));
}).listen(process.env.PORT, "127.0.0.1");
`;

let repo: string;
let site: Site;
let server: Server;
let base: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

/** The agent appends the request text to a file named by its first word, or page.txt. */
const agent: Agent = {
  name: "scripted",
  command: (prompt) => {
    // Asked to settle a conflict, it keeps both sides' lines, unless one of the requests said to give up.
    if (prompt.includes("in the middle of that git merge")) {
      return {
        command: "bash",
        args: [
          "-c",
          `grep -q "give up" page.txt || { grep -v -E '^(<<<<<<<|=======|>>>>>>>)' page.txt > merged && mv merged page.txt; }; echo "RESULT Kept yours and theirs."`,
        ],
      };
    }
    // Asked to fix a build, it mends the word that breaks it, unless the request said "forever".
    if (prompt.includes("The build failed with")) {
      return { command: "bash", args: ["-c", `grep -q forever page.txt || sed -i 's/broken/mended/' page.txt; echo "RESULT Mended it."`] };
    }
    const text = /<request>\n([\s\S]*?)\n<\/request>/.exec(prompt)?.[1] ?? "";
    const [target, ...rest] = text.split(" ");
    const file = target?.includes(".") ? target : "page.txt";
    const words = target?.includes(".") ? rest.join(" ") : text;
    return {
      command: "bash",
      args: ["-c", `sleep 0.3; printf '%s\\n' "$1" >> "$2"; echo "RESULT Added $1."`, "agent", words, file ?? "page.txt"],
    };
  },
  parse: (line) => (line.startsWith("RESULT ") ? [{ type: "result", text: line.slice(7) }] : []),
};

const as = (id: string) => ({ "x-user": id });
const write = (id: string) => ({ ...as(id), "content-type": "application/json", "x-computah": "1" });
const page = async (id?: string, cookie?: string) =>
  (await fetch(`${base}/`, { headers: { ...(id ? as(id) : {}), ...(cookie ? { cookie } : {}) } })).text();
const post = (id: string, path: string, body: unknown = {}) =>
  fetch(`${base}/__computah${path}`, { method: "POST", headers: write(id), body: JSON.stringify(body) });

async function ask(id: string, text: string, scope?: "me"): Promise<Job> {
  const response = await post(id, "/jobs", { text, for: scope });
  expect(response.status).toBe(201);
  const { job } = (await response.json()) as { job: Job };
  for (let i = 0; i < 600; i++) {
    const current = ((await (await fetch(`${base}/__computah/jobs/${job.id}`, { headers: as(id) })).json()) as { job: Job }).job;
    if (!["queued", "working"].includes(current.state)) return current;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("job never settled");
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "computah-site-"));
  git("init", "-q", "-b", "trunk");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "page.txt"), "hello\n");
  writeFileSync(join(repo, "secret.txt"), "keys\n");
  writeFileSync(join(repo, "server.js"), SERVER);
  writeFileSync(join(repo, ".gitignore"), "built.txt\n");
  git("add", "-A");
  git("commit", "-qm", "start");
  site = new Site({
    cwd: repo,
    agent,
    app: { build: `! grep -q broken page.txt && cp page.txt built.txt`, start: "node server.js", dev: "node server.js dev" },
    identity: header("x-user"),
    trust: { owners: ["olive"], trusted: ["tess"], members: ["mel", "max"], memberPaths: ["page.txt"], memberDailyLimit: 3 },
  });
  await site.init();
  server = createFrontServer(site);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterEach(async () => {
  site.stop();
  await new Promise<void>((resolve) => void server.close(() => resolve()));
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(repo, { recursive: true, force: true });
});

describe("a served app", () => {
  it("serves everyone the built app, signed in or not", async () => {
    expect(await page()).toBe("hello\n");
    expect(await page("mel")).toBe("hello\n");
  });

  it("an owner's change reaches everyone once it has built", async () => {
    const job = await ask("olive", "from olive");
    expect(job.state).toBe("done");
    expect(job.release).toBe("live");
    expect(job.by?.id).toBe("olive");
    expect(await page()).toBe("hello\nfrom olive\n");
    expect(await page("mel")).toBe("hello\nfrom olive\n");
    expect(git("log", "-1", "--format=%an|%s", "computah/main").trim()).toBe("olive|computah: from olive");
  });

  it("a trusted person changes it for everyone too", async () => {
    expect((await ask("tess", "from tess")).release).toBe("live");
    expect(await page()).toBe("hello\nfrom tess\n");
  });

  it("a member's change is theirs alone until the owner promotes it", async () => {
    const job = await ask("mel", "from mel");
    expect(job.version).not.toBe("main");
    expect(await page("mel")).toBe("hello\nfrom mel\n");
    expect(await page("max")).toBe("hello\n");
    expect(await page()).toBe("hello\n");
    // Mel can still look at everyone's version.
    expect(await page("mel", "computah_view=main")).toBe("hello\n");

    const me = (await (await fetch(`${base}/__computah/me`, { headers: as("olive") })).json()) as {
      proposals: { id: string; changes: string[] }[];
    };
    expect(me.proposals).toHaveLength(1);
    expect(me.proposals[0]?.changes).toEqual(["from mel"]);

    expect((await post("max", `/versions/${me.proposals[0]?.id}/promote`)).status).toBe(403);
    expect((await post("olive", `/versions/${me.proposals[0]?.id}/promote`)).status).toBe(200);
    expect(await page()).toBe("hello\nfrom mel\n");
    expect(await page("max")).toBe("hello\nfrom mel\n");
  });

  it("everyone's later changes flow into a member's own version", async () => {
    await ask("mel", "from mel");
    await ask("olive", "other.txt from olive");
    for (
      let i = 0;
      i < 100 && !readFileSync(join(repo, ".computah/work", slugFor({ id: "mel" }), "page.txt"), "utf8").includes("mel");
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const merged = join(repo, ".computah/work", slugFor({ id: "mel" }), "other.txt");
    for (let i = 0; i < 100; i++) {
      try {
        readFileSync(merged);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    }
    expect(readFileSync(merged, "utf8")).toBe("from olive\n");
  });

  it("shows the agent a failed build and keeps the change once it's fixed", async () => {
    const job = await ask("olive", "broken");
    expect(job.state).toBe("done");
    expect(job.release).toBe("live");
    expect(job.commits).toHaveLength(2);
    expect(job.summary).toBe("Mended it.");
    expect(await page()).toBe("hello\nmended\n");
    // Undo takes out the change and its fix together.
    expect((await post("olive", `/jobs/${job.id}/undo`)).status).toBe(200);
    expect(await page()).toBe("hello\n");
  });

  it("builds people's versions ahead of time, and shows everyone's rather than making anyone wait for a build", async () => {
    await ask("mel", "from mel");
    site.stop();
    // Everyone's version moves while the runner is down, so mel's copy will need a new build.
    const main = join(repo, ".computah/work/main");
    writeFileSync(join(main, "deployed.txt"), "deployed\n");
    execFileSync("git", ["add", "-A"], { cwd: main });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "deploy"], { cwd: main });
    const again = new Site({
      cwd: repo,
      agent,
      // A build slow enough to catch mel arriving in the middle of it.
      app: { build: "sleep 1.2 && cat page.txt deployed.txt > built.txt", start: "node server.js" },
      identity: header("x-user"),
      trust: { owners: ["olive"], members: ["mel"] },
    });
    await again.init();
    const front = createFrontServer(again);
    await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
    const at = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;
    const get = async (path: string) => fetch(`${at}${path}`, { headers: as("mel") });
    try {
      // Mid-build: mel gets a page at once, never a wait. Depending on how far the catch-up has got,
      // that's everyone's version (and the box says theirs is on the way) or their own previous build.
      const started = Date.now();
      const first = await (await get("/")).text();
      expect(Date.now() - started).toBeLessThan(600);
      expect(["hello\ndeployed\n", "hello\nfrom mel\n"]).toContain(first);
      if (first === "hello\ndeployed\n") expect(((await (await get("/__computah/me")).json()) as { waiting: boolean }).waiting).toBe(true);
      // Nobody asked for mel's page again, and it still gets built. Then it's theirs, with both changes.
      for (let i = 0; i < 200; i++) {
        if ((await (await get("/")).text()) === "hello\nfrom mel\ndeployed\n") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(await (await get("/")).text()).toBe("hello\nfrom mel\ndeployed\n");
      expect(((await (await get("/__computah/me")).json()) as { waiting: boolean }).waiting).toBe(false);
    } finally {
      again.stop();
      await new Promise<void>((resolve) => void front.close(() => resolve()));
    }
  }, 30_000);

  it("has the agent settle it when everyone's version and a member's change the same lines", async () => {
    await ask("mel", "from mel");
    await ask("olive", "from olive");
    // Both added a line in the same place, so the plain merge conflicts and mel's version falls behind.
    const me = async () => (await (await fetch(`${base}/__computah/me`, { headers: as("mel") })).json()) as { stale: boolean };
    for (let i = 0; i < 100 && !(await me()).stale; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    // Showing up is what starts the catch-up. It appears in mel's box like any request.
    let chore: Job | undefined;
    for (let i = 0; i < 400; i++) {
      await me();
      const jobs = ((await (await fetch(`${base}/__computah/jobs`, { headers: as("mel") })).json()) as { jobs: Job[] }).jobs;
      chore = jobs.find((job) => job.chore);
      if (chore && !["queued", "working"].includes(chore.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(chore?.state).toBe("done");
    expect(chore?.summary).toBe("Kept yours and theirs.");
    expect((await me()).stale).toBe(false);
    // Mel now has both changes; everyone else still has only olive's.
    expect(await page("mel")).toBe("hello\nfrom mel\nfrom olive\n");
    expect(await page("max")).toBe("hello\nfrom olive\n");
  });

  it("leaves a member's version exactly as it was when the conflict can't be settled", async () => {
    await ask("mel", "give up");
    await ask("olive", "from olive");
    const me = async () => (await (await fetch(`${base}/__computah/me`, { headers: as("mel") })).json()) as { stale: boolean };
    for (let i = 0; i < 100 && !(await me()).stale; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    let chore: Job | undefined;
    for (let i = 0; i < 400; i++) {
      const jobs = ((await (await fetch(`${base}/__computah/jobs`, { headers: as("mel") })).json()) as { jobs: Job[] }).jobs;
      chore = jobs.find((job) => job.chore && !["queued", "working"].includes(job.state));
      if (chore) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(chore?.state).toBe("failed");
    expect(chore?.error).toMatch(/so yours is as it was\. It left conflict markers behind/);
    // Coming back doesn't make it try again against the same state of everyone's version.
    for (let i = 0; i < 5; i++) await me();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const chores = ((await (await fetch(`${base}/__computah/jobs`, { headers: as("mel") })).json()) as { jobs: Job[] }).jobs.filter(
      (job) => job.chore,
    );
    expect(chores).toHaveLength(1);
    expect(await page("mel")).toBe("hello\ngive up\n");
    expect(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: join(repo, ".computah/work", slugFor({ id: "mel" })),
        encoding: "utf8",
      }).trim(),
    ).toBe("");
  });

  it("brings people's own versions up to date when the runner starts again after everyone's version moved", async () => {
    await ask("mel", "from mel");
    site.stop();
    // A deploy while the runner is down: everyone's version gets a commit from outside.
    const main = join(repo, ".computah/work/main");
    writeFileSync(join(main, "deployed.txt"), "new\n");
    execFileSync("git", ["add", "-A"], { cwd: main });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "deploy"], { cwd: main });
    const again = new Site({
      cwd: repo,
      agent,
      app: { build: "cp page.txt built.txt", start: "node server.js" },
      identity: header("x-user"),
      trust: { owners: ["olive"], members: ["mel"] },
    });
    await again.init();
    try {
      const mine = join(repo, ".computah/work", slugFor({ id: "mel" }), "deployed.txt");
      for (let i = 0; i < 200 && !existsSync(mine); i++) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(readFileSync(mine, "utf8")).toBe("new\n");
    } finally {
      again.stop();
    }
  });

  it("a change the agent can't make build never goes live and leaves the history clean", async () => {
    const job = await ask("olive", "broken forever");
    expect(job.state).toBe("failed");
    expect(job.error).toMatch(/still didn't build after trying to fix it, so nothing changed/);
    expect(await page()).toBe("hello\n");
    expect(readFileSync(join(repo, ".computah/work/main/page.txt"), "utf8")).toBe("hello\n");
    // The app still takes changes afterwards.
    expect((await ask("olive", "fine")).release).toBe("live");
    expect(await page()).toBe("hello\nfine\n");
  });

  it("undo rebuilds without the change", async () => {
    const job = await ask("olive", "temporary");
    expect(await page()).toBe("hello\ntemporary\n");
    // A member can't undo it; a trusted person can, since they could change it anyway.
    expect((await post("mel", `/jobs/${job.id}/undo`)).status).toBe(404);
    expect((await post("tess", `/jobs/${job.id}/undo`)).status).toBe(200);
    expect(await page()).toBe("hello\n");
  });

  it("keeps a member inside the paths they're allowed", async () => {
    const job = await ask("mel", "secret.txt leak");
    expect(job.state).toBe("failed");
    expect(job.error).toMatch(/can't change here \(secret.txt\)/);
    expect(readFileSync(join(repo, ".computah/work", slugFor({ id: "mel" }), "secret.txt"), "utf8")).toBe("keys\n");
  });

  it("limits how much a member can ask in a day", async () => {
    for (const text of ["one", "two", "three"]) await ask("mel", text);
    expect((await post("mel", "/jobs", { text: "four" })).status).toBe(429);
  });

  it("refuses visitors and strangers", async () => {
    expect((await post("nobody", "/jobs", { text: "hi" })).status).toBe(403);
    expect(
      (
        await fetch(`${base}/__computah/jobs`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-computah": "1" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    const me = (await (await fetch(`${base}/__computah/me`)).json()) as { level: string };
    expect(me.level).toBe("visitor");
    await ask("olive", "private note");
    expect(((await (await fetch(`${base}/__computah/jobs`, { headers: as("nobody") })).json()) as { jobs: Job[] }).jobs).toEqual([]);
  });

  it("shows the person who asked a live copy while their change is made", async () => {
    const response = await post("olive", "/jobs", { text: "live line" });
    const { job } = (await response.json()) as { job: Job };
    let sawLive = false;
    for (let i = 0; i < 300; i++) {
      const text = await page("olive");
      if (text.startsWith("dev:")) sawLive = true;
      // Nobody else is ever on the live copy.
      expect((await page("tess")).startsWith("dev:")).toBe(false);
      const state = ((await (await fetch(`${base}/__computah/jobs/${job.id}`, { headers: as("olive") })).json()) as { job: Job }).job.state;
      if (state === "done") break;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    expect(sawLive).toBe(true);
    expect(await page("olive")).toBe("hello\nlive line\n");
  });
});

describe("a page and the copy that served it", () => {
  /** A page load as a browser sends it. `fetch` can't set sec-fetch-mode, so this uses a plain request. */
  const load = (id: string, cookie?: string) =>
    new Promise<{ text: string; pin?: string }>((resolve, reject) => {
      const headers = { ...as(id), "sec-fetch-mode": "navigate", ...(cookie ? { cookie } : {}) };
      get(`${base}/`, { headers }, (response) => {
        let text = "";
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => resolve({ text, pin: /computah_copy=([a-f0-9]+)/.exec(String(response.headers["set-cookie"]))?.[1] }));
      }).on("error", reject);
    });

  it("keeps a page's own requests on its copy while a new build swaps in", async () => {
    const first = await load("tess");
    expect(first.pin).toBeTruthy();
    await ask("olive", "newer");
    // A page opened before the change still fetches from the copy that served it...
    expect(await page("tess", `computah_copy=${first.pin}`)).toBe("hello\n");
    // ...and loading the page again moves it to the new one.
    const second = await load("tess", `computah_copy=${first.pin}`);
    expect(second.text).toBe("hello\nnewer\n");
    expect(second.pin).not.toBe(first.pin);
  });

  it("ignores a made-up copy name", async () => {
    expect(await page(undefined, "computah_copy=nope")).toBe("hello\n");
  });
});

describe("guests and pieces that are theirs to change", () => {
  let guestSite: Site;
  let guestServer: Server;
  let url: string;
  const call = (path: string, init: RequestInit = {}) => fetch(`${url}${path}`, init);
  const jsonHeaders = { "content-type": "application/json", "x-computah": "1" };

  beforeEach(async () => {
    writeFileSync(join(repo, "toy.tsx"), '"use client";\nexport default function Toy() { return null; }\n');
    git("add", "-A");
    git("commit", "-qm", "toy");
    guestSite = new Site({
      cwd: repo,
      agent: {
        name: "writer",
        // The request is "<file> <<< <contents>": the agent writes exactly that.
        command: (prompt) => {
          const [file, body] = (/<request>\n([\s\S]*?)\n<\/request>/.exec(prompt)?.[1] ?? "").split(" <<< ");
          return { command: "bash", args: ["-c", `printf '%s\n' "$1" > "$2"; echo "RESULT ok"`, "agent", body ?? "", file ?? "x"] };
        },
        parse: (line) => (line.startsWith("RESULT ") ? [{ type: "result", text: line.slice(7) }] : []),
      },
      app: { build: "cp page.txt built.txt", start: "node server.js" },
      identity: header("x-user"),
      trust: {
        owners: ["olive"],
        members: "everyone",
        memberPaths: ["toy.tsx"],
        memberCheck: clientOnly(),
        memberNote: "only the toy.",
        dailyLimit: 3,
      },
      guests: { secret: "guest-secret" },
      maxCopies: 1,
    });
    await guestSite.init();
    guestServer = createFrontServer(guestSite);
    await new Promise<void>((resolve) => guestServer.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(guestServer.address() as AddressInfo).port}`;
  }, 30_000);
  afterEach(async () => {
    guestSite.stop();
    await new Promise<void>((resolve) => void guestServer.close(() => resolve()));
  });

  async function guest() {
    const hello = await call("/__computah/hello", { method: "POST", headers: jsonHeaders, body: "{}" });
    expect(hello.status).toBe(201);
    const cookie = /computah_guest=[a-z0-9]+\.[a-f0-9]+/.exec(hello.headers.get("set-cookie") ?? "")?.[0] ?? "";
    const send = async (text: string) => {
      const response = await call("/__computah/jobs", {
        method: "POST",
        headers: { ...jsonHeaders, cookie },
        body: JSON.stringify({ text }),
      });
      if (response.status !== 201) return { status: response.status } as { status: number; job?: Job };
      const { job } = (await response.json()) as { job: Job };
      for (let i = 0; i < 400; i++) {
        const now = ((await (await call(`/__computah/jobs/${job.id}`, { headers: { cookie } })).json()) as { job: Job }).job;
        if (!["queued", "working"].includes(now.state)) return { status: 201, job: now };
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("never settled");
    };
    return { cookie, send };
  }

  it("someone not signed in can become a guest, and a guest is a member", async () => {
    const before = (await (await call("/__computah/me")).json()) as { level: string; canJoin: boolean };
    expect([before.level, before.canJoin]).toEqual(["visitor", true]);
    const { cookie } = await guest();
    const after = (await (await call("/__computah/me", { headers: { cookie } })).json()) as {
      level: string;
      note: string;
      person: { id: string };
    };
    expect(after.level).toBe("member");
    expect(after.note).toBe("only the toy.");
    expect(after.person.id).toMatch(/^guest:/);
  });

  it("refuses a guest cookie it didn't sign", async () => {
    const forged = "computah_guest=abcdef012345678901.00000000000000000000000000000000";
    expect(((await (await call("/__computah/me", { headers: { cookie: forged } })).json()) as { level: string }).level).toBe("visitor");
  });

  it("a guest can change their piece, as long as it stays a browser-only component", async () => {
    const { send } = await guest();
    const good = await send('toy.tsx <<< "use client"; import { useState } from "react"; export default function Toy() { return null; }');
    expect(good.job?.state).toBe("done");
    for (const [body, why] of [
      ['import fs from "node:fs"; export default function Toy() { return null; }', /has to start with "use client"/],
      ['"use client"; import fs from "node:fs"; export default function Toy() { return null; }', /can only import react, not "node:fs"/],
      ['"use client"; export async function act() { "use server"; }', /can't contain server code/],
    ] as const) {
      const bad = await send(`toy.tsx <<< ${body}`);
      // The third bad request also hits the daily cap for all members together.
      if (bad.status === 429) continue;
      expect(bad.job?.state).toBe("failed");
      expect(bad.job?.error).toMatch(why);
    }
    // None of it reached everyone's version.
    expect(git("log", "--format=%s", "computah/main").includes("toy.tsx <<<")).toBe(false);
  });

  it("stops all members together at the app's daily cap", async () => {
    const one = await guest();
    const two = await guest();
    await one.send("page.txt <<< nope");
    await one.send("page.txt <<< nope");
    await two.send("page.txt <<< nope");
    expect((await two.send("page.txt <<< nope")).status).toBe(429);
  });

  it("checks imports written every way", () => {
    const check = clientOnly({ imports: ["react"] });
    const file = (content: string | null) => [{ path: "toy.tsx", content }];
    expect(check(file('"use client";\nimport { useState } from "react";\nexport default () => null;'))).toBeNull();
    expect(check(file("'use client'\n// import x from 'fs'\nexport default () => null;"))).toBeNull();
    expect(check(file('"use client";\nconst fs = require("fs");'))).toMatch(/not "fs"/);
    expect(check(file('"use client";\nconst x = await import("https://evil.example/x.js");'))).toMatch(/not "https/);
    expect(check(file('"use client";\nconst name = "f" + "s"; import(name);'))).toMatch(/computed name/);
    expect(check(file('"use client";\nexport * from "../secrets";'))).toMatch(/not "\.\.\/secrets"/);
    expect(check(file('/* "use client" */ import "server-only";'))).toMatch(/has to start/);
    expect(check(file(null))).toMatch(/can't be deleted/);
  });
});

describe("keeping a busy app within its means", () => {
  it("deletes builds nothing needs, runs a limited number of agents at once, and forgets the oldest guests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "computah-means-"));
    const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    run("init", "-q", "-b", "trunk");
    run("config", "user.email", "test@example.invalid");
    run("config", "user.name", "Test");
    run("config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "page.txt"), "hello\n");
    writeFileSync(join(dir, "server.js"), SERVER);
    writeFileSync(join(dir, ".gitignore"), "built.txt\nlog.txt\n");
    run("add", "-A");
    run("commit", "-qm", "start");
    const log = join(dir, "log.txt");
    const busy = new Site({
      cwd: dir,
      // Each agent notes when it starts and stops, in a file outside any checkout's history.
      agent: {
        name: "clocked",
        command: (prompt) => {
          const text = /<request>\n([\s\S]*?)\n<\/request>/.exec(prompt)?.[1] ?? "";
          return {
            command: "bash",
            args: ["-c", `echo start >> "$2"; sleep 0.4; echo "$1" >> page.txt; echo end >> "$2"; echo "RESULT ok"`, "x", text, log],
          };
        },
        parse: (line) => (line.startsWith("RESULT ") ? [{ type: "result", text: line.slice(7) }] : []),
      },
      app: { build: "cp page.txt built.txt", start: "node server.js" },
      identity: header("x-user"),
      trust: { owners: ["olive"], members: "everyone" },
      guests: { secret: "s", keep: 2 },
      maxAgents: 1,
      lingerMs: 50,
    });
    await busy.init();
    try {
      const wait = async (person: { id: string }, id: string) => {
        for (let i = 0; i < 600; i++) {
          const { job } = busy.find(person, id);
          if (!["queued", "working"].includes(job.state)) return job;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("never settled");
      };
      // Three guests ask at the same moment. With one agent allowed, they never overlap.
      const guests = ["a", "b", "c"].map((name) => ({ id: `guest:${name}`, name: "guest" }));
      const jobs = await Promise.all(guests.map((guest) => busy.submit(guest, `from ${guest.id}`, {})));
      for (const [at, guest] of guests.entries()) expect((await wait(guest, jobs[at]?.id ?? "")).state).toBe("done");
      const marks = readFileSync(log, "utf8").trim().split("\n");
      expect(marks).toEqual(["start", "end", "start", "end", "start", "end"]);

      // A second change for one of them replaces its build; the old one is deleted once nothing can be using it.
      const again = await busy.submit(guests[2] as { id: string }, "more", {});
      await wait(guests[2] as { id: string }, again.id);
      // Only two guests are kept: the one who was here longest ago is forgotten on the next sweep.
      (busy as unknown as { reap(): void }).reap();
      await new Promise((resolve) => setTimeout(resolve, 600));
      const builds = execFileSync("ls", [join(dir, ".computah/releases")], { encoding: "utf8" })
        .trim()
        .split("\n");
      const kept = execFileSync("ls", [join(dir, ".computah/work")], { encoding: "utf8" })
        .trim()
        .split("\n");
      expect(kept.filter((name) => name.startsWith("guest")).length).toBe(2);
      // One build each for everyone's version and the two guests left. Nothing else is lying around.
      expect(builds).toHaveLength(3);
    } finally {
      busy.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("builds side by side", () => {
  it("runs as many builds at once as it's allowed, and no more", async () => {
    const dir = mkdtempSync(join(tmpdir(), "computah-side-"));
    const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    run("init", "-q", "-b", "trunk");
    run("config", "user.email", "test@example.invalid");
    run("config", "user.name", "Test");
    run("config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "page.txt"), "hello\n");
    writeFileSync(join(dir, "server.js"), SERVER);
    writeFileSync(join(dir, ".gitignore"), "built.txt\nlog.txt\n");
    run("add", "-A");
    run("commit", "-qm", "start");
    const log = join(dir, "log.txt");
    const busy = new Site({
      cwd: dir,
      agent: {
        name: "quick",
        command: (prompt) => {
          const text = /<request>\n([\s\S]*?)\n<\/request>/.exec(prompt)?.[1] ?? "";
          return { command: "bash", args: ["-c", `echo "$1" >> page.txt; echo "RESULT ok"`, "x", text] };
        },
        parse: (line) => (line.startsWith("RESULT ") ? [{ type: "result", text: line.slice(7) }] : []),
      },
      // Each build notes when it starts and stops, and takes long enough that they'd overlap.
      app: { build: `echo start >> "${log}"; sleep 0.5; cp page.txt built.txt; echo end >> "${log}"`, start: "node server.js" },
      identity: header("x-user"),
      trust: { owners: ["olive"], members: "everyone" },
      guests: { secret: "s" },
      maxBuilds: 2,
    });
    await busy.init();
    try {
      writeFileSync(log, "");
      const guests = ["a", "b", "c", "d"].map((name) => ({ id: `guest:${name}`, name: "guest" }));
      const jobs = await Promise.all(guests.map((guest) => busy.submit(guest, `from ${guest.id}`, {})));
      for (const [at, guest] of guests.entries()) {
        for (let i = 0; i < 800; i++) {
          if (!["queued", "working"].includes(busy.find(guest, jobs[at]?.id ?? "").job.state)) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(busy.find(guest, jobs[at]?.id ?? "").job.state).toBe("done");
      }
      let now = 0;
      let most = 0;
      for (const mark of readFileSync(log, "utf8").trim().split("\n")) {
        now += mark === "start" ? 1 : -1;
        most = Math.max(most, now);
      }
      expect(most).toBe(2);
    } finally {
      busy.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("a live copy sees requests as its own", () => {
  it("rewrites host, origin and referer, and leaves other sites' values alone", () => {
    expect(asLocal("host", "app.example", 4000, "app.example")).toBe("localhost:4000");
    expect(asLocal("origin", "https://app.example", 4000, "app.example")).toBe("http://localhost:4000");
    expect(asLocal("referer", "https://app.example/notes?a=1", 4000, "app.example")).toBe("http://localhost:4000/notes?a=1");
    expect(asLocal("origin", "https://evil.example", 4000, "app.example")).toBe("https://evil.example");
    expect(asLocal("cookie", "a=b", 4000, "app.example")).toBe("a=b");
  });
});

describe("the write guard", () => {
  const request = (headers: Record<string, string>) => ({ headers }) as never;
  it("needs the marker, JSON, and the app's own origin", () => {
    const good = { "x-computah": "1", "content-type": "application/json", host: "app.example", origin: "https://app.example" };
    expect(refuseWrite(request(good))).toBeNull();
    expect(refuseWrite(request({ ...good, origin: "https://evil.example" }))).toMatch(/isn't allowed/);
    expect(refuseWrite(request({ ...good, "x-computah": "" }))).toMatch(/x-computah/);
    expect(refuseWrite(request({ ...good, "content-type": "text/plain" }))).toMatch(/JSON/);
    expect(refuseWrite(request({ ...good, host: "127.0.0.1:8000", "x-forwarded-host": "app.example" }))).toBeNull();
  });
});

describe("trust", () => {
  const trust = { owners: ["a@x.dev"], trusted: ["t"], members: "everyone" as const };
  it("places people by id or name, case-insensitively", () => {
    expect(levelOf({ id: "u1", name: "A@x.dev" }, trust)).toBe("owner");
    expect(levelOf({ id: "T" }, trust)).toBe("trusted");
    expect(levelOf({ id: "anyone" }, trust)).toBe("member");
    expect(levelOf(null, trust)).toBe("visitor");
    expect(levelOf({ id: "anyone" }, { owners: [] })).toBe("visitor");
  });

  it("matches globs", () => {
    expect(globToRegExp("app/**").test("app/a/b.tsx")).toBe(true);
    expect(globToRegExp("app/*.tsx").test("app/a/b.tsx")).toBe(false);
    expect(globToRegExp("**/*.css").test("a/b/c.css")).toBe(true);
    expect(outsidePaths(["app/page.tsx", "lib/auth.ts"], ["app/**"])).toEqual(["lib/auth.ts"]);
    expect(outsidePaths(["anything"], undefined)).toEqual([]);
  });

  it("gives each person a distinct, safe name", () => {
    expect(slugFor({ id: "u1", name: "Mel.Smith@example.com" })).toMatch(/^mel-smith-[a-z0-9]+$/);
    expect(slugFor({ id: "u1" })).not.toBe(slugFor({ id: "u2" }));
  });
});
