import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProxy } from "../src/next.js";
import { AppError } from "../src/server/app.js";
import { createFrontServer } from "../src/server/front.js";
import { type Host, vercel } from "../src/server/hosts.js";
import { gateway } from "../src/server/identity.js";
import { Site } from "../src/server/site.js";
import type { Agent, Job } from "../src/server/types.js";

let dir: string;
let repo: string;
let remote: string;
let site: Site;
let runner: Server;
let app: Server;
let base: string;
let deployed: { sha: string; branch: string; production: boolean }[];
let failNext: string | null;
let signedIn: string | null;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const remoteFile = (branch: string, file: string) => git(remote, "show", `${branch}:${file}`);

const agent: Agent = {
  name: "scripted",
  command: (prompt) => {
    if (prompt.includes("The build failed with"))
      return {
        command: "bash",
        args: ["-c", `grep -q broken page.txt && sed -i 's/broken/mended/' page.txt || echo fixed >> page.txt; echo "RESULT Mended it."`],
      };
    const text = /<request>\n([\s\S]*?)\n<\/request>/.exec(prompt)?.[1] ?? "";
    return { command: "bash", args: ["-c", `printf '%s\\n' "$1" >> page.txt; echo "RESULT Added $1."`, "agent", text] };
  },
  parse: (line) => (line.startsWith("RESULT ") ? [{ type: "result", text: line.slice(7) }] : []),
};

/** A host that records what it was asked to deploy, and can be told to fail once. */
const host: Host = {
  name: "fake",
  async deployed(input) {
    deployed.push(input);
    if (failNext) {
      const message = failNext;
      failNext = null;
      throw new AppError(message);
    }
    return { url: `https://${input.production ? "app" : input.branch.replace(/\W+/g, "-")}.example` };
  },
};

const headers = { "content-type": "application/json", "x-computah": "1" };
async function ask(text: string): Promise<Job> {
  const response = await fetch(`${base}/api/computah/jobs`, { method: "POST", headers, body: JSON.stringify({ text }) });
  expect(response.status).toBe(201);
  const { job } = (await response.json()) as { job: Job };
  for (let i = 0; i < 400; i++) {
    const current = ((await (await fetch(`${base}/api/computah/jobs/${job.id}`)).json()) as { job: Job }).job;
    if (!["queued", "working"].includes(current.state)) return current;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("job never settled");
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "computah-push-"));
  remote = join(dir, "remote.git");
  repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "page.txt"), "hello\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "start");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  deployed = [];
  failNext = null;
  signedIn = "olive";

  site = new Site({
    cwd: repo,
    agent,
    app: { start: "", build: "! grep -q broken page.txt" },
    identity: gateway("s3cret"),
    trust: { owners: ["olive"], members: ["mel"] },
    release: { push: { host } },
  });
  await site.init();
  runner = createFrontServer(site);
  await new Promise<void>((resolve) => runner.listen(0, "127.0.0.1", resolve));
  const runnerUrl = `http://127.0.0.1:${(runner.address() as AddressInfo).port}`;

  // The app, as its host would run it: one route that passes the box's requests to the runner.
  const proxy = createProxy({ runner: runnerUrl, secret: "s3cret", identify: () => (signedIn ? { id: signedIn } : null) });
  app = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const method = request.method ?? "GET";
    const answer = await proxy[method === "GET" ? "GET" : "POST"](
      new Request(`http://${request.headers.host}${request.url}`, {
        method,
        headers: request.headers as Record<string, string>,
        body: method === "GET" ? undefined : Buffer.concat(chunks),
      }),
    );
    response.writeHead(answer.status, Object.fromEntries(answer.headers));
    response.end(Buffer.from(await answer.arrayBuffer()));
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});

afterEach(async () => {
  site.stop();
  await Promise.all([runner, app].map((server) => new Promise<void>((resolve) => void server.close(() => resolve()))));
  rmSync(dir, { recursive: true, force: true });
});

describe("an app its host builds", () => {
  it("pushes an owner's change to the branch the host serves, and waits for the host", async () => {
    const job = await ask("from olive");
    expect(job.state).toBe("done");
    expect(job.release).toBe("live");
    expect(remoteFile("main", "page.txt")).toBe("hello\nfrom olive\n");
    expect(deployed).toEqual([{ sha: job.commit, branch: "main", production: true }]);
    expect(job.url).toBeUndefined();
  });

  it("pushes a member's change to a branch of their own and says where the host serves it", async () => {
    signedIn = "mel";
    const job = await ask("from mel");
    expect(job.release).toBe("live");
    expect(remoteFile("main", "page.txt")).toBe("hello\n");
    expect(deployed[0]?.production).toBe(false);
    expect(remoteFile(deployed[0]?.branch ?? "", "page.txt")).toBe("hello\nfrom mel\n");
    expect(job.url).toMatch(/^https:\/\/computah-u-mel-/);
    const me = (await (await fetch(`${base}/api/computah/me`)).json()) as { mode: string; ownUrl: string };
    expect(me.mode).toBe("push");
    expect(me.ownUrl).toBe(job.url);
  });

  it("gives the host's build error to the agent to fix", async () => {
    failNext = "Type error: page.txt is broken";
    const job = await ask("works here, fails there");
    expect(job.state).toBe("done");
    expect(job.summary).toBe("Mended it.");
    expect(deployed).toHaveLength(2);
  });

  it("catches a broken build on the runner before pushing anything", async () => {
    const job = await ask("broken");
    expect(job.state).toBe("done");
    expect(remoteFile("main", "page.txt")).toBe("hello\nmended\n");
    // The broken commit never reached the host on its own.
    expect(deployed).toHaveLength(1);
  });

  it("takes in work pushed by someone else instead of failing", async () => {
    const other = join(dir, "other");
    execFileSync("git", ["clone", "-q", remote, other]);
    writeFileSync(join(other, "other.txt"), "theirs\n");
    git(other, "add", "-A");
    git(other, "-c", "user.email=o@example.invalid", "-c", "user.name=Other", "commit", "-qm", "theirs");
    git(other, "push", "-q", "origin", "main");
    expect((await ask("mine")).release).toBe("live");
    expect(remoteFile("main", "other.txt")).toBe("theirs\n");
    expect(remoteFile("main", "page.txt")).toBe("hello\nmine\n");
  });

  it("only believes who the app says is signed in, and only with the secret", async () => {
    signedIn = null;
    expect((await fetch(`${base}/api/computah/jobs`, { method: "POST", headers, body: JSON.stringify({ text: "hi" }) })).status).toBe(403);
    // Reaching the runner directly and claiming to be the owner gets nowhere without the secret.
    const direct = `http://127.0.0.1:${(runner.address() as AddressInfo).port}/__computah`;
    const claim = { ...headers, "x-computah-user-id": "olive" };
    expect((await fetch(`${direct}/jobs`, { method: "POST", headers: claim, body: JSON.stringify({ text: "hi" }) })).status).toBe(403);
    expect(
      (
        await fetch(`${direct}/jobs`, {
          method: "POST",
          headers: { ...claim, authorization: "Bearer wrong!" },
          body: JSON.stringify({ text: "hi" }),
        })
      ).status,
    ).toBe(403);
    // The runner serves no pages in this mode.
    expect((await fetch(direct.replace("/__computah", "/"))).status).toBe(404);
  });

  it("refuses a change sent from another site through the app's route", async () => {
    const response = await fetch(`${base}/api/computah/jobs`, {
      method: "POST",
      headers: { ...headers, origin: "https://evil.example" },
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(
      (await fetch(`${base}/api/computah/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status,
    ).toBe(403);
  });
});

describe("the vercel host", () => {
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it("waits through building and returns the address", async () => {
    const states = [
      [],
      [{ uid: "dpl_1", readyState: "QUEUED" }],
      [{ uid: "dpl_1", readyState: "BUILDING" }],
      [{ uid: "dpl_1", readyState: "READY", url: "app-abc.vercel.app" }],
    ];
    const asked: string[] = [];
    const host = vercel({
      token: "t",
      projectId: "prj",
      teamId: "team",
      pollMs: 1,
      fetch: (async (url: URL) => {
        asked.push(String(url));
        return answer({ deployments: states.shift() ?? [] });
      }) as never,
    });
    expect(await host.deployed({ sha: "abc123", branch: "main", production: true })).toEqual({ url: "https://app-abc.vercel.app" });
    expect(asked[0]).toBe("https://api.vercel.com/v7/deployments?projectId=prj&sha=abc123&limit=1&teamId=team");
    expect(asked).toHaveLength(4);
  });

  it("fails with the end of the build log", async () => {
    const host = vercel({
      token: "t",
      projectId: "prj",
      pollMs: 1,
      fetch: (async (url: URL) =>
        String(url).includes("/events")
          ? answer([
              { type: "stdout", payload: { text: "Running build" } },
              { type: "stderr", payload: { text: "Type error: nope" } },
            ])
          : answer({ deployments: [{ uid: "dpl_9", readyState: "ERROR" }] })) as never,
    });
    await expect(host.deployed({ sha: "s", branch: "b", production: false })).rejects.toThrow(
      "The Vercel build failed.\nRunning build\nType error: nope",
    );
  });

  it("says so when Vercel never picks the push up, or there is no token", async () => {
    const host = vercel({
      token: "t",
      projectId: "prj",
      pollMs: 1,
      startTimeoutMs: 5,
      fetch: (async () => answer({ deployments: [] })) as never,
    });
    await expect(host.deployed({ sha: "s", branch: "b", production: true })).rejects.toThrow(/never started a build/);
    const saved = process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_TOKEN;
    await expect(vercel({ projectId: "prj" }).deployed({ sha: "s", branch: "b", production: true })).rejects.toThrow(/No Vercel token/);
    if (saved) process.env.VERCEL_TOKEN = saved;
  });
});
