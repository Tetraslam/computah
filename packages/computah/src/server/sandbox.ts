import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { createInterface } from "node:readline";
import { AppError } from "./app.js";
import type { AgentCommand } from "./types.js";

/**
 * Somewhere else to run the agent: a throwaway machine that gets a copy of the code and
 * nothing more. The agent works there; only its changes come back, as a patch.
 */
export interface Sandbox {
  name: string;
  open(): Promise<SandboxSession>;
  /**
   * Throw away sandboxes this runner left behind, if it was stopped before it could close them.
   * Called when the runner starts. A sandbox that bills by the second should have one.
   */
  sweep?(): Promise<void>;
}

export interface ExecOptions {
  /** Written to the command's stdin, then closed. */
  stdin?: string;
  /** Called for each line the command prints, as it prints it. */
  onLine?: (line: string) => void;
}

export interface SandboxSession {
  /** Run a command in the sandbox. Resolves with its exit code, everything it printed, and the end of its stderr. */
  exec(command: string[], options?: ExecOptions): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Stop whatever is running and throw the sandbox away. Safe to call more than once. */
  close(): Promise<void>;
}

export interface WarmOptions {
  /** The most sandboxes kept ready at once. Default 2. */
  max?: number;
  /** A ready sandbox that nobody used for this long is thrown away. Default 90 seconds. */
  idleMs?: number;
  /**
   * Keep this many ready at all times, asked for or not. Default 0, which costs nothing while
   * nobody is around: a sandbox is only started when someone opens the box.
   */
  min?: number;
}

/**
 * Keep sandboxes ready ahead of the requests that will use them, so a request doesn't wait for
 * one to start. `hint()` says a request is probably coming. Each sandbox is still used once.
 */
export function warm(sandbox: Sandbox, options: WarmOptions = {}): Sandbox & { hint(): void; stop(): Promise<void> } {
  const max = Math.max(1, options.max ?? 2);
  const min = Math.min(max, options.min ?? 0);
  const idleMs = options.idleMs ?? 90_000;
  type Entry = { session: Promise<SandboxSession>; timer: NodeJS.Timeout };
  const ready: Entry[] = [];
  let stopped = false;
  const discard = (entry: Entry) => {
    clearTimeout(entry.timer);
    const at = ready.indexOf(entry);
    if (at !== -1) ready.splice(at, 1);
    return entry.session.then((session) => session.close()).catch(() => {});
  };
  const start = () => {
    if (stopped || ready.length >= max) return;
    const session = sandbox.open();
    const entry: Entry = {
      session,
      timer: setTimeout(() => {
        void discard(entry);
        fill();
      }, idleMs),
    };
    entry.timer.unref();
    ready.push(entry);
    // One that failed to start is dropped without retrying at once, so a provider that's down isn't hammered.
    session.catch(() => void discard(entry));
  };
  const fill = () => {
    while (!stopped && ready.length < min) start();
  };
  fill();
  return {
    name: sandbox.name,
    sweep: sandbox.sweep && (() => sandbox.sweep?.() ?? Promise.resolve()),
    hint: start,
    async open() {
      const entry = ready.shift();
      if (!entry) return sandbox.open();
      clearTimeout(entry.timer);
      fill();
      // If the one that was being readied failed, start a fresh one the ordinary way.
      return entry.session.catch(() => sandbox.open());
    },
    /** Resolves once every ready sandbox has been thrown away. */
    async stop() {
      stopped = true;
      await Promise.all([...ready].map(discard));
    },
  };
}

/** Where the copy lives in the sandbox. Quoted wherever it is used, since $HOME is expanded there. */
const WORK = '"$HOME/computah-work"';
const SECRETS = '"$HOME/.computah-run-env"';

/**
 * Run an agent in a sandbox on a copy of the code and return what it changed.
 * `tar` is the code as a tar archive. The result's `patch` applies to that same code.
 */
export async function runInSandbox(
  session: SandboxSession,
  tar: Buffer,
  agent: AgentCommand,
  onLine: (line: string) => void,
): Promise<{ code: number; stderr: string; patch: string }> {
  const unpack = await session.exec(
    [
      "sh",
      "-c",
      `rm -rf ${WORK} && mkdir -p ${WORK} && cd ${WORK} && base64 -d | tar -x && git init -q && git add -A && git -c user.email=computah@localhost -c user.name=computah commit -q --no-gpg-sign -m base`,
    ],
    { stdin: tar.toString("base64") },
  );
  if (unpack.code !== 0)
    throw new AppError(`Couldn't copy the code into the sandbox. ${unpack.stderr.trim().split("\n").pop() ?? ""}`, true);

  // Anything only this run may know (a person's credentials) goes in through stdin to a file only
  // this user can read, so it never shows up in a command line or a log.
  const names = Object.keys(agent.env ?? {});
  if (names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
    throw new AppError("An environment name for the agent isn't valid.", true);
  if (names.length) {
    const lines = names.map((name) => `${name}='${(agent.env?.[name] ?? "").replace(/'/g, `'\\''`)}'`).join("\n");
    const kept = await session.exec(["sh", "-c", `umask 077 && cat > ${SECRETS}`], { stdin: `${lines}\n` });
    if (kept.code !== 0) throw new AppError("Couldn't prepare the sandbox.", true);
  }
  const load = names.length ? `set -a && . ${SECRETS} && set +a && rm -f ${SECRETS} && ` : "";

  // The agent's own arguments are passed as arguments, never pasted into a shell string.
  const run = await session.exec(["sh", "-c", `${load}cd ${WORK} && exec "$@"`, "agent", agent.command, ...agent.args], {
    stdin: agent.stdin ?? "",
    onLine,
  });

  const diff = await session.exec(["sh", "-c", `cd ${WORK} && git add -A && git diff --binary --cached HEAD`]);
  if (diff.code !== 0) throw new AppError("Couldn't read the changes back from the sandbox.", true);
  return { code: run.code, stderr: run.stderr, patch: diff.stdout };
}

// ---------- exe.dev ----------

export interface ExeSandboxOptions {
  /**
   * What the sandbox may reach: "integrations" (only exe.dev's own services, such as its
   * model gateway) or "all" (the whole internet). Default "integrations".
   */
  egress?: "integrations" | "all";
  /** Shell commands run once in a new sandbox, before the code is copied in. */
  setup?: string[];
  /** Extra arguments for every ssh call, for example ["-i", "/path/to/key"]. */
  ssh?: string[];
  /**
   * Prefix for sandbox names. Default "computah-sbx" plus a few characters that are this
   * runner's own, so two runners on one account never touch each other's sandboxes.
   */
  prefix?: string;
}

/** Points Claude Code and Codex at exe.dev's model gateway, so no keys are needed in the sandbox. */
export const EXE_GATEWAY_SETUP = [
  `mkdir -p ~/.claude ~/.codex`,
  `printf '%s' '{"apiKeyHelper":"printf exe-gateway","env":{"ANTHROPIC_BASE_URL":"https://llm.int.exe.xyz"},"permissions":{"allow":["Bash","Read","Edit","Write","Glob","Grep"]}}' > ~/.claude/settings.json`,
  `printf 'model_provider = "exe-llm"\\n\\n[model_providers.exe-llm]\\nname = "exe-llm"\\nbase_url = "https://llm.int.exe.xyz/v1"\\nrequires_openai_auth = false\\n' > ~/.codex/config.toml`,
];

/**
 * A standalone exe.dev VM per request, made and removed over ssh. The machine running
 * this needs an ssh key that exe.dev knows. The stock image already has Claude Code,
 * Codex and OpenCode on it.
 */
export function exeSandbox(options: ExeSandboxOptions = {}): Sandbox {
  const base = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=20", ...(options.ssh ?? [])];
  const prefix = options.prefix ?? `computah-sbx-${createHash("sha1").update(`${hostname()}:${process.cwd()}`).digest("hex").slice(0, 6)}`;
  return {
    name: "exe",
    async sweep() {
      const listed = await ssh([...base, "exe.dev", "ls", "--json"]);
      if (listed.code !== 0) return;
      let names: string[] = [];
      try {
        names = (JSON.parse(listed.stdout) as { vms?: { vm_name?: string }[] }).vms?.map((vm) => vm.vm_name ?? "") ?? [];
      } catch {
        return;
      }
      // Only names this runner makes: its prefix, a dash, and eight hex characters.
      const mine = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[0-9a-f]{8}$`);
      await Promise.all(names.filter((name) => mine.test(name)).map((name) => ssh([...base, "exe.dev", "rm", name])));
    },
    async open() {
      const name = `${prefix}-${randomBytes(4).toString("hex")}`;
      const made = await ssh([
        ...base,
        "exe.dev",
        "new",
        "--sandbox",
        `--name=${name}`,
        `--egress=${options.egress ?? "integrations"}`,
        "--no-email",
        "--json",
      ]);
      if (made.code !== 0)
        throw new AppError(`exe.dev couldn't make a sandbox. ${(made.stderr || made.stdout).trim().split("\n").pop() ?? ""}`, true);
      const host = `${name}.exe.xyz`;
      let running: (() => void) | null = null;
      let closed = false;
      const session: SandboxSession = {
        exec(command, execOptions = {}) {
          // ssh joins its arguments with spaces and hands them to a shell, so each one is quoted.
          const remote = command.map(quote).join(" ");
          const call = ssh([...base, host, remote], execOptions);
          running = call.stop;
          return call;
        },
        async close() {
          if (closed) return;
          closed = true;
          running?.();
          await ssh([...base, "exe.dev", "rm", name]);
        },
      };
      try {
        // One connection for all of it: each ssh call costs most of a second.
        const setup = options.setup ?? EXE_GATEWAY_SETUP;
        if (setup.length) {
          const step = await session.exec(["sh", "-c", setup.map((line) => `{ ${line}\n}`).join(" && ")]);
          if (step.code !== 0) throw new AppError(`Sandbox setup failed. ${step.stderr.trim().split("\n").pop() ?? ""}`, true);
        }
      } catch (error) {
        await session.close();
        throw error;
      }
      return session;
    },
  };
}

const quote = (argument: string) => `'${argument.replace(/'/g, `'\\''`)}'`;

function ssh(args: string[], options: ExecOptions = {}): Promise<{ code: number; stdout: string; stderr: string }> & { stop: () => void } {
  const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
  const result = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    let stdout = "";
    let stderr = "";
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (options.onLine) options.onLine(line);
      else stdout += `${line}\n`;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin ?? "");
    child.on("error", () => resolve({ code: 127, stdout, stderr: "ssh isn't installed." }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
  return Object.assign(result, { stop: () => void child.kill("SIGTERM") });
}

// ---------- Modal ----------

export interface ModalSandboxOptions {
  /** The Modal app sandboxes are created under. Default "computah". */
  app?: string;
  /** A registry image to start from. Default "node:24-bookworm-slim". */
  image?: string;
  /**
   * Dockerfile lines that put git and your agent on the image. The default installs git,
   * Claude Code, Codex and OpenCode.
   */
  build?: string[];
  /** Names of Modal Secrets to give the agent, such as one holding ANTHROPIC_API_KEY. */
  secrets?: string[];
  /** Cut the sandbox off from the network entirely. Only useful with an agent that needs none. Default false. */
  blockNetwork?: boolean;
  /** How long a sandbox may live. Default 20 minutes. */
  timeoutMs?: number;
}

export const MODAL_AGENT_IMAGE = [
  "RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep && rm -rf /var/lib/apt/lists/*",
  "RUN npm install -g @anthropic-ai/claude-code @openai/codex opencode-ai",
];

/**
 * A Modal Sandbox per request. Needs the `modal` package installed next to computah and
 * Modal credentials in the environment or in ~/.modal.toml.
 */
export function modalSandbox(options: ModalSandboxOptions = {}): Sandbox {
  return {
    name: "modal",
    async open() {
      // biome-ignore lint/suspicious/noExplicitAny: modal is an optional dependency, loaded only when this adapter is used.
      let sdk: any;
      try {
        sdk = await import("modal");
      } catch {
        throw new AppError("The Modal sandbox needs the `modal` package. Install it next to computah.", true);
      }
      const client = new sdk.ModalClient();
      const app = await client.apps.fromName(options.app ?? "computah", { createIfMissing: true });
      const image = client.images
        .fromRegistry(options.image ?? "node:24-bookworm-slim")
        .dockerfileCommands(options.build ?? MODAL_AGENT_IMAGE);
      const secrets = await Promise.all((options.secrets ?? []).map((name) => client.secrets.fromName(name)));
      const sandbox = await client.sandboxes.create(app, image, {
        timeoutMs: options.timeoutMs ?? 20 * 60_000,
        blockNetwork: options.blockNetwork ?? false,
      });
      let closed = false;
      return {
        async exec(command, execOptions = {}) {
          const process = await sandbox.exec(command, { stdout: "pipe", stderr: "pipe", secrets });
          const feed = (async () => {
            if (execOptions.stdin) await process.stdin.writeText(execOptions.stdin);
            await process.stdin.close();
          })().catch(() => {});
          let stdout = "";
          let pending = "";
          const reading = (async () => {
            for await (const chunk of process.stdout as AsyncIterable<string>) {
              if (!execOptions.onLine) {
                stdout += chunk;
                continue;
              }
              pending += chunk;
              const lines = pending.split("\n");
              pending = lines.pop() ?? "";
              for (const line of lines) execOptions.onLine(line);
            }
            if (pending && execOptions.onLine) execOptions.onLine(pending);
          })();
          const [stderr, code] = await Promise.all([
            process.stderr.readText() as Promise<string>,
            process.wait() as Promise<number>,
            reading,
            feed,
          ]);
          return { code, stdout, stderr: stderr.slice(-4000) };
        },
        async close() {
          if (closed) return;
          closed = true;
          await sandbox.terminate().catch(() => {});
        },
      };
    },
  };
}
