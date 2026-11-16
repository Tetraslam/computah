import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { get, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFrontServer, refuseWrite } from "../src/server/front.js";
import { globToRegExp, header, levelOf, outsidePaths, slugFor } from "../src/server/identity.js";
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
    expect((await post("tess", `/jobs/${job.id}/undo`)).status).toBe(404);
    expect((await post("olive", `/jobs/${job.id}/undo`)).status).toBe(200);
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
