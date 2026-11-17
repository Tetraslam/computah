import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claude, codex, opencode, toolDetail } from "../src/server/agents.js";
import { changedFiles, restore, snapshot } from "../src/server/git.js";
import { cleanContext, createRunnerServer, type RequestFacts, refuse } from "../src/server/http.js";
import { Computah } from "../src/server/jobs.js";
import { buildPrompt } from "../src/server/prompt.js";
import type { Agent, Job } from "../src/server/types.js";

let repo: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
const read = (file: string) => readFileSync(join(repo, file), "utf8");
const write = (file: string, text: string) => writeFileSync(join(repo, file), text);

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "computah-test-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  // The settings that broke undo on a real machine: an external diff tool and renamed prefixes.
  git("config", "diff.external", "false");
  git("config", "diff.mnemonicprefix", "true");
  write("page.txt", "hello\n");
  write(".gitignore", "ignored/\n");
  git("add", "-A");
  git("commit", "-qm", "start");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

/** An agent that is really a shell script, speaking a tiny line format. */
function scripted(script: string): Agent {
  return {
    name: "scripted",
    command: () => ({ command: "bash", args: ["-c", script] }),
    parse(line) {
      const [kind, ...rest] = line.split(" ");
      const text = rest.join(" ");
      if (kind === "SAY") return [{ type: "text", text }];
      if (kind === "TOOL") return [{ type: "tool", name: "edit", detail: text }];
      if (kind === "RESULT") return [{ type: "result", text }];
      if (kind === "ERROR") return [{ type: "error", message: text }];
      return [];
    },
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

describe("snapshots", () => {
  it("captures tracked and untracked files, ignores ignored ones, and touches nothing", async () => {
    const before = await snapshot(repo);
    write("page.txt", "changed\n");
    write("new.txt", "new\n");
    execFileSync("mkdir", ["-p", join(repo, "ignored")]);
    write("ignored/secret.txt", "x\n");
    const after = await snapshot(repo);
    expect((await changedFiles(repo, before, after)).sort()).toEqual(["new.txt", "page.txt"]);
    expect(git("status", "--porcelain").trimEnd().split("\n").sort()).toEqual([" M page.txt", "?? new.txt"]);
  });

  it("restores edits, new files and deletions", async () => {
    write("gone.txt", "bye\n");
    const before = await snapshot(repo);
    write("page.txt", "changed\n");
    write("new.txt", "new\n");
    rmSync(join(repo, "gone.txt"));
    await restore(repo, before, await snapshot(repo));
    expect(read("page.txt")).toBe("hello\n");
    expect(existsSync(join(repo, "new.txt"))).toBe(false);
    expect(read("gone.txt")).toBe("bye\n");
  });

  it("refuses to restore over later edits, and changes nothing", async () => {
    const before = await snapshot(repo);
    write("page.txt", "by the job\n");
    const after = await snapshot(repo);
    write("page.txt", "by the user afterwards\n");
    await expect(restore(repo, before, after)).rejects.toThrow(/changed since/);
    expect(read("page.txt")).toBe("by the user afterwards\n");
  });
});

describe("jobs", () => {
  it("runs the agent, records what changed, commits it, and undoes it", async () => {
    const computah = new Computah({
      cwd: repo,
      agent: scripted("echo 'SAY looking'; echo 'TOOL page.txt'; echo better > page.txt; echo 'RESULT The page now says better.'"),
    });
    const job = await settle(
      computah,
      (
        await computah.submit("make it better", {
          url: "http://localhost:3000/",
        })
      ).id,
    );
    expect(job.state).toBe("done");
    expect(job.files).toEqual(["page.txt"]);
    expect(job.summary).toBe("The page now says better.");
    expect(git("log", "-1", "--format=%s").trim()).toBe("computah: make it better");
    expect(git("status", "--porcelain").trim()).toBe("");
    expect((await computah.history(job.id)).map((event) => event.type)).toEqual(["state", "state", "text", "tool", "state"]);

    await computah.undo(job.id);
    expect(read("page.txt")).toBe("hello\n");
    expect(computah.get(job.id)?.state).toBe("undone");
  });

  it("doesn't commit over the user's own uncommitted edits, and still undoes", async () => {
    write("page.txt", "hello\nmy draft\n");
    const computah = new Computah({
      cwd: repo,
      agent: scripted("echo 'from the agent' >> page.txt; echo 'RESULT Added a line.'"),
    });
    const job = await settle(computah, (await computah.submit("add a line")).id);
    expect(job.commit).toBeUndefined();
    expect(git("log", "--oneline").trim().split("\n")).toHaveLength(1);
    await computah.undo(job.id);
    expect(read("page.txt")).toBe("hello\nmy draft\n");
  });

  it("keeps none of a failed job's edits", async () => {
    const computah = new Computah({
      cwd: repo,
      agent: scripted("echo broken > page.txt; echo oops >&2; exit 3"),
    });
    const job = await settle(computah, (await computah.submit("break it")).id);
    expect(job.state).toBe("failed");
    expect(job.error).toBe("oops");
    expect(read("page.txt")).toBe("hello\n");
  });

  it("stops a running job and rolls it back", async () => {
    const computah = new Computah({
      cwd: repo,
      agent: scripted("echo half > page.txt; echo 'SAY working'; sleep 30"),
    });
    const { id } = await computah.submit("slow change");
    for (let i = 0; i < 200 && read("page.txt") !== "half\n"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    await computah.cancel(id);
    const job = await settle(computah, id);
    expect(job.state).toBe("cancelled");
    expect(read("page.txt")).toBe("hello\n");
  });

  it("runs one job at a time, in order", async () => {
    const computah = new Computah({
      cwd: repo,
      commit: false,
      agent: scripted("sleep 0.2; date +%s%N >> order.txt; echo 'RESULT ok'"),
    });
    const first = await computah.submit("first");
    const second = await computah.submit("second");
    expect(computah.get(second.id)?.state).toBe("queued");
    await settle(computah, second.id);
    expect(computah.get(first.id)?.state).toBe("done");
    expect(read("order.txt").trim().split("\n")).toHaveLength(2);
  });

  it("holds a fix to the same limits as the change, and leaves nothing behind when a fix breaks them", async () => {
    let checks = 0;
    const agent: Agent = {
      name: "sneaky",
      // The first run makes an allowed change. Asked to fix the build, it reaches for a file it may not touch.
      command: (prompt) => ({
        command: "bash",
        args: [
          "-c",
          prompt.includes("The build failed with")
            ? "echo fixed >> page.txt; echo stolen > secret.txt; echo 'RESULT fixed'"
            : "echo change >> page.txt; echo 'RESULT changed'",
        ],
      }),
      parse: (line) => (line.startsWith("RESULT ") ? [{ type: "result", text: line.slice(7) }] : []),
    };
    const computah = new Computah({
      cwd: repo,
      agent,
      allowedPaths: () => ["page.txt"],
      verify: async () => (checks++ === 0 ? "it doesn't build" : null),
    });
    const job = await settle(computah, (await computah.submit("change it")).id);
    expect(job.state).toBe("failed");
    expect(read("page.txt")).toBe("hello\n");
    expect(existsSync(join(repo, "secret.txt"))).toBe(false);
    expect(git("status", "--porcelain").trim()).toBe("");
  });

  it("tells each new agent what was asked before, so a follow-up makes sense", async () => {
    const prompts: string[] = [];
    const agent: Agent = {
      name: "listener",
      command: (prompt) => {
        prompts.push(prompt);
        const text = /<request>\n([\s\S]*?)\n<\/request>/.exec(prompt)?.[1] ?? "";
        return { command: "bash", args: ["-c", text === "fail" ? "exit 1" : `echo "$1" >> page.txt; echo "RESULT Did: $1."`, "x", text] };
      },
      parse: (line) => (line.startsWith("RESULT ") ? [{ type: "result", text: line.slice(7) }] : []),
    };
    const computah = new Computah({ cwd: repo, agent });
    const first = await settle(computah, (await computah.submit("make the title red")).id);
    await settle(computah, (await computah.submit("fail")).id);
    await computah.undo(first.id);
    await settle(computah, (await computah.submit("no, bigger")).id);

    expect(prompts[0]).not.toContain("Earlier requests");
    const last = prompts[2] ?? "";
    expect(last).toContain("<request>\nno, bigger\n</request>");
    expect(last).toContain('1. [done, then undone, so it is no longer in the code] "make the title red"');
    expect(last).toContain("what was reported back: Did: make the title red.");
    expect(last).toContain('2. [failed, so it changed nothing] "fail"');
    // An undone change no longer points at a commit, since that commit's work is gone.
    expect(last).not.toMatch(/undone[^\n]*commit [0-9a-f]{10}/);
    // A finished one does.
    await settle(computah, (await computah.submit("and bold")).id);
    expect(prompts[3]).toMatch(/3\. \[done, commit [0-9a-f]{10}\] "no, bigger"/);
  });

  it("says so when the agent isn't installed", async () => {
    const computah = new Computah({
      cwd: repo,
      agent: {
        name: "missing",
        command: () => ({ command: "no-such-agent-binary", args: [] }),
        parse: () => [],
      },
    });
    const job = await settle(computah, (await computah.submit("anything")).id);
    expect(job.error).toBe("no-such-agent-binary isn't installed or isn't on the PATH.");
  });

  it("rejects empty and oversized requests", async () => {
    const computah = new Computah({
      cwd: repo,
      agent: scripted("true"),
      maxLength: 10,
    });
    await expect(computah.submit("   ")).rejects.toThrow("Say what should change.");
    await expect(computah.submit("x".repeat(11))).rejects.toThrow("too long");
  });

  it("keeps its records out of git status and reloads them", async () => {
    const computah = new Computah({
      cwd: repo,
      commit: false,
      agent: scripted("echo 'RESULT nothing to do'"),
    });
    const job = await settle(computah, (await computah.submit("look around")).id);
    expect(job.summary).toBe("nothing to do");
    expect(git("status", "--porcelain").trim()).toBe("");
    const again = new Computah({ cwd: repo, agent: scripted("true") });
    await again.init();
    expect(again.get(job.id)?.text).toBe("look around");
    expect((await again.history(job.id)).length).toBeGreaterThan(0);
  });
});

describe("who may call the runner", () => {
  const local: RequestFacts = {
    method: "POST",
    remoteAddress: "127.0.0.1",
    host: "127.0.0.1:4821",
    origin: "http://localhost:3000",
    authorization: undefined,
    marker: "1",
    contentType: "application/json",
  };

  it("lets a page on this machine through", () => {
    expect(refuse(local, {})).toBeNull();
    expect(
      refuse(
        {
          ...local,
          remoteAddress: "::ffff:127.0.0.1",
          origin: "http://app.localhost:5173",
        },
        {},
      ),
    ).toBeNull();
  });

  it("refuses another machine, whatever headers it sends", () => {
    expect(refuse({ ...local, remoteAddress: "192.168.1.20" }, {})).toMatch(/Only this machine/);
  });

  it("refuses a rebound hostname", () => {
    expect(refuse({ ...local, host: "evil.example:4821" }, {})).toMatch(/Host/);
  });

  it("refuses another website using the visitor's browser", () => {
    expect(refuse({ ...local, origin: "https://evil.example" }, {})).toMatch(/isn't allowed/);
    expect(refuse({ ...local, origin: "https://localhost.evil.example" }, {})).toMatch(/isn't allowed/);
  });

  it("refuses a write without the marker header or a JSON body", () => {
    expect(refuse({ ...local, marker: undefined }, {})).toMatch(/x-computah/);
    expect(refuse({ ...local, contentType: "text/plain" }, {})).toMatch(/JSON/);
    expect(refuse({ ...local, method: "GET", marker: undefined, contentType: undefined }, {})).toBeNull();
  });

  it("with a secret, takes the secret from anywhere and nothing else", () => {
    const remote = {
      ...local,
      remoteAddress: "203.0.113.9",
      host: "runner.example",
      origin: "https://app.example",
    };
    const options = { secret: "s3cret", origins: ["https://app.example"] };
    expect(refuse({ ...remote, authorization: "Bearer s3cret" }, options)).toBeNull();
    expect(refuse({ ...remote, authorization: "Bearer wrong!" }, options)).toMatch(/secret/);
    expect(refuse(remote, options)).toMatch(/secret/);
    expect(
      refuse(
        {
          ...remote,
          authorization: "Bearer s3cret",
          origin: "https://other.example",
        },
        options,
      ),
    ).toMatch(/isn't allowed/);
  });
});

describe("the http runner", () => {
  let server: Server;
  let base: string;
  const headers = {
    "content-type": "application/json",
    "x-computah": "1",
    origin: "http://localhost:3000",
  };

  beforeEach(async () => {
    const computah = new Computah({
      cwd: repo,
      agent: scripted("echo 'SAY on it'; echo new > page.txt; echo 'RESULT Changed the page.'"),
    });
    server = createRunnerServer(computah);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((resolve) => void server.close(() => resolve())));

  it("takes a request, streams its events to the end, and undoes it", async () => {
    const created = await fetch(`${base}/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text: "change it",
        context: { url: "http://localhost:3000/a" },
      }),
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const { job } = (await created.json()) as { job: Job };

    const events = await (
      await fetch(`${base}/jobs/${job.id}/events`, {
        headers: { origin: headers.origin },
      })
    ).text();
    const types = events
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)).type);
    expect(types).toEqual(["state", "state", "text", "state"]);

    const listed = (await (await fetch(`${base}/jobs`)).json()) as {
      jobs: Job[];
    };
    expect(listed.jobs[0]?.summary).toBe("Changed the page.");
    expect(read("page.txt")).toBe("new\n");

    const undone = await fetch(`${base}/jobs/${job.id}/undo`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(undone.status).toBe(200);
    expect(read("page.txt")).toBe("hello\n");
  });

  it("gives a refused page no CORS headers and no data", async () => {
    const response = await fetch(`${base}/jobs`, {
      headers: { origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers bad input plainly", async () => {
    expect(
      (
        await fetch(`${base}/jobs`, {
          method: "POST",
          headers,
          body: "not json",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${base}/jobs`, {
          method: "POST",
          headers,
          body: JSON.stringify({ text: "" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${base}/jobs/nope/undo`, {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
    ).toBe(404);
    expect((await fetch(`${base}/elsewhere`)).status).toBe(404);
  });
});

describe("agent adapters", () => {
  it("reads claude's stream", () => {
    const agent = claude();
    expect(
      agent.parse(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Looking." },
              {
                type: "tool_use",
                name: "Edit",
                input: { file_path: "app/page.tsx" },
              },
            ],
          },
        }),
      ),
    ).toEqual([
      { type: "text", text: "Looking." },
      { type: "tool", name: "Edit", detail: "app/page.tsx" },
    ]);
    expect(agent.parse(JSON.stringify({ type: "result", is_error: false, result: "Done." }))).toEqual([{ type: "result", text: "Done." }]);
    expect(
      agent.parse(
        JSON.stringify({
          type: "result",
          is_error: true,
          result: "Out of credit",
        }),
      ),
    ).toEqual([{ type: "error", message: "Out of credit" }]);
    expect(agent.command("p", "/r").stdin).toBe("p");
  });

  it("reads opencode's stream (lines recorded from a real run)", () => {
    const agent = opencode({ model: "provider/model" });
    const tool =
      '{"type":"tool_use","timestamp":1,"sessionID":"s","part":{"type":"tool","tool":"shell","state":{"status":"completed","input":{"command":"printf world >> note.txt","workdir":"/tmp/x"},"output":"ok"}}}';
    const text =
      '{"type":"text","timestamp":2,"sessionID":"s","part":{"type":"text","text":"Appended `world` as a new last line in `note.txt`."}}';
    expect(agent.parse(tool)).toEqual([{ type: "tool", name: "shell", detail: "printf world >> note.txt" }]);
    expect(agent.parse(text)).toEqual([
      {
        type: "text",
        text: "Appended `world` as a new last line in `note.txt`.",
      },
    ]);
    expect(agent.parse('{"type":"step_start","part":{}}')).toEqual([]);
    expect(agent.command("do it", "/r").args).toEqual([
      "run",
      "--format",
      "json",
      "--auto",
      "--archived",
      "--model",
      "provider/model",
      "do it",
    ]);
  });

  it("reads codex's stream", () => {
    const agent = codex();
    expect(
      agent.parse(
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "All set." },
        }),
      ),
    ).toEqual([{ type: "text", text: "All set." }]);
    expect(
      agent.parse(
        JSON.stringify({
          type: "item.started",
          item: { type: "command_execution", command: "pnpm typecheck" },
        }),
      ),
    ).toEqual([{ type: "tool", name: "shell", detail: "pnpm typecheck" }]);
    expect(
      agent.parse(
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "file_change",
            changes: [{ path: "a.ts", kind: "update" }],
          },
        }),
      ),
    ).toEqual([{ type: "tool", name: "edit", detail: "a.ts" }]);
  });

  it("ignores noise and shortens long details", () => {
    for (const agent of [claude(), opencode(), codex()]) {
      expect(agent.parse("plain log line")).toEqual([]);
      expect(agent.parse("{not json")).toEqual([]);
      expect(agent.parse("[1,2]")).toEqual([]);
    }
    expect(toolDetail({ command: `echo ${"x".repeat(300)}` })?.length).toBe(140);
  });
});

describe("the prompt and context", () => {
  it("carries the request verbatim and where the user was", () => {
    const prompt = buildPrompt("  make the title bigger ", {
      url: "http://localhost:3000/notes",
      viewport: { width: 1440, height: 900 },
      element: {
        selector: "main > h1",
        text: "Notes",
        component: "NotesHeader",
      },
    });
    expect(prompt).toContain("<request>\nmake the title bigger\n</request>");
    expect(prompt).toContain("http://localhost:3000/notes");
    expect(prompt).toContain("1440×900");
    expect(prompt).toContain("NotesHeader");
  });

  it("drops unknown fields and bounds the rest", () => {
    const context = cleanContext({
      url: "u".repeat(5000),
      viewport: { width: "wide", height: 2 },
      element: { text: "no selector" },
      extra: { nested: true },
    });
    expect(context.url?.length).toBe(2000);
    expect(context.viewport).toBeUndefined();
    expect(context.element).toBeUndefined();
    expect(Object.keys(context)).not.toContain("extra");
  });
});

describe("theming", () => {
  it("turns a theme into the css variables the box reads, and skips what isn't set", async () => {
    const { themeStyle } = await import("../src/react/Computah.js");
    expect(themeStyle({ ink: "#eee", radius: "10px", zIndex: 50, font: "" })).toEqual({
      "--computah-ink": "#eee",
      "--computah-radius": "10px",
      "--computah-z-index": "50",
    });
    expect(themeStyle(undefined)).toEqual({});
  });
});
