import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { header } from "../src/server/identity.js";
import { Computah } from "../src/server/jobs.js";
import type { Sandbox } from "../src/server/sandbox.js";
import { Site } from "../src/server/site.js";
import type { Agent, Job } from "../src/server/types.js";

let repo: string;
let homes: string[];
let opened: number;
let closed: number;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

/** A "sandbox" that is only another home directory on this machine: enough to prove the copy-in, run, patch-out flow. */
const elsewhere: Sandbox = {
  name: "elsewhere",
  async open() {
    opened++;
    const home = mkdtempSync(join(tmpdir(), "computah-sbx-"));
    homes.push(home);
    return {
      exec: (command, options = {}) =>
        new Promise((resolve) => {
          const child = spawn(command[0] as string, command.slice(1), {
            env: { PATH: process.env.PATH, HOME: home },
            stdio: ["pipe", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          let pending = "";
          child.stdout.on("data", (chunk: Buffer) => {
            if (!options.onLine) return void (stdout += chunk.toString());
            pending += chunk.toString();
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            for (const line of lines) options.onLine(line);
          });
          child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          child.stdin.end(options.stdin ?? "");
          child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
        }),
      async close() {
        closed++;
      },
    };
  },
};

function scripted(script: string): Agent {
  return {
    name: "scripted",
    command: () => ({ command: "bash", args: ["-c", script] }),
    parse: (line) =>
      line.startsWith("RESULT ")
        ? [{ type: "result", text: line.slice(7) }]
        : line.startsWith("SAY ")
          ? [{ type: "text", text: line.slice(4) }]
          : [],
  };
}

async function settle(computah: Computah, id: string): Promise<Job> {
  for (let i = 0; i < 400; i++) {
    const job = computah.get(id);
    if (job && !["queued", "working"].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("job never settled");
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "computah-sandbox-"));
  homes = [];
  opened = 0;
  closed = 0;
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "page.txt"), "hello\n");
  writeFileSync(join(repo, ".gitignore"), ".env\n");
  writeFileSync(join(repo, ".env"), "SECRET=on-the-host\n");
  git("add", "-A");
  git("commit", "-qm", "start");
});
afterEach(() => {
  for (const dir of [repo, ...homes]) rmSync(dir, { recursive: true, force: true });
});

describe("an agent in a sandbox", () => {
  it("works on a copy and only its changes come back", async () => {
    writeFileSync(join(repo, "draft.txt"), "not committed yet\n");
    const script = `echo "SAY in $(pwd)"; echo changed >> page.txt; echo new > added.txt; rm draft.txt; cat .env 2>/dev/null && echo LEAKED >> page.txt; echo "RESULT Done away."`;
    const computah = new Computah({ cwd: repo, agent: scripted(script), sandbox: () => elsewhere });
    const job = await settle(computah, (await computah.submit("change it")).id);
    expect(job.state).toBe("done");
    expect(job.summary).toBe("Done away.");
    expect(job.files?.sort()).toEqual(["added.txt", "draft.txt", "page.txt"]);
    // The copy had the uncommitted file but not the ignored one, so the secret never left.
    expect(readFileSync(join(repo, "page.txt"), "utf8")).toBe("hello\nchanged\n");
    expect(readFileSync(join(repo, "added.txt"), "utf8")).toBe("new\n");
    expect(existsSync(join(repo, "draft.txt"))).toBe(false);
    expect(readFileSync(join(repo, ".env"), "utf8")).toBe("SECRET=on-the-host\n");
    // It ran somewhere else, and the sandbox was thrown away afterwards.
    const said = (await computah.history(job.id)).find((event) => event.type === "text");
    expect(said?.type === "text" && said.text).toContain(homes[0]);
    expect([opened, closed]).toEqual([1, 1]);
  });

  it("keeps nothing from an agent that fails there", async () => {
    const computah = new Computah({
      cwd: repo,
      agent: scripted("echo broken > page.txt; echo nope >&2; exit 2"),
      sandbox: () => elsewhere,
    });
    const job = await settle(computah, (await computah.submit("break it")).id);
    expect(job.state).toBe("failed");
    expect(job.error).toBe("nope");
    expect(readFileSync(join(repo, "page.txt"), "utf8")).toBe("hello\n");
    expect(closed).toBe(1);
  });

  it("can be stopped, and the sandbox is closed", async () => {
    const computah = new Computah({ cwd: repo, agent: scripted("sleep 30"), sandbox: () => elsewhere });
    const { id } = await computah.submit("slow");
    for (let i = 0; i < 200 && opened === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await computah.cancel(id);
    // The pretend sandbox can't kill its process on close, so only the bookkeeping is checked here.
    expect(closed).toBeGreaterThanOrEqual(1);
  });

  it("passes the agent's arguments through untouched, whatever characters they hold", async () => {
    const tricky = `it's "quoted" $HOME \`back\` ; rm -rf / && echo`;
    const agent: Agent = {
      name: "echo",
      command: () => ({ command: "bash", args: ["-c", 'printf "%s" "$1" > said.txt; echo "RESULT ok"', "x", tricky] }),
      parse: (line) => (line.startsWith("RESULT ") ? [{ type: "result", text: line.slice(7) }] : []),
    };
    const computah = new Computah({ cwd: repo, agent, sandbox: () => elsewhere });
    await settle(computah, (await computah.submit("say it")).id);
    expect(readFileSync(join(repo, "said.txt"), "utf8")).toBe(tricky);
  });
});

describe("who gets sandboxed when the app is served", () => {
  it("sandboxes members and leaves owners on the machine, by default", async () => {
    writeFileSync(
      join(repo, "server.js"),
      `require("node:http").createServer((q, r) => r.end(require("node:fs").readFileSync("page.txt"))).listen(process.env.PORT, "127.0.0.1");`,
    );
    git("add", "-A");
    git("commit", "-qm", "server");
    const site = new Site({
      cwd: repo,
      agent: scripted(`echo "$HOME" >> page.txt; echo "RESULT ok"`),
      app: { start: "node server.js" },
      identity: header("x-user"),
      trust: { owners: ["olive"], members: ["mel"] },
      sandbox: { in: elsewhere },
    });
    await site.init();
    try {
      const wait = async (person: { id: string }, id: string) => {
        for (let i = 0; i < 400; i++) {
          const { job } = site.find(person, id);
          if (!["queued", "working"].includes(job.state)) return job;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("never settled");
      };
      await wait({ id: "olive" }, (await site.submit({ id: "olive" }, "mine", {})).id);
      expect(opened).toBe(0);
      const job = await wait({ id: "mel" }, (await site.submit({ id: "mel" }, "mine", {})).id);
      expect(job.state).toBe("done");
      expect(opened).toBe(1);
    } finally {
      site.stop();
    }
  });
});
