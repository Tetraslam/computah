import { type ChildProcess, spawn } from "node:child_process";
import { request } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";

/** How to install, build and run the app. Each command runs in a shell with PORT set. */
export interface AppCommands {
  /** Directory of the app inside the repo, if it isn't the root. */
  dir?: string;
  /** Install dependencies in a fresh copy, for example "pnpm install --frozen-lockfile". */
  install?: string;
  /** Build a copy for serving, for example "pnpm build". */
  build?: string;
  /** Serve the built copy on $PORT, for example "pnpm start". */
  start: string;
  /**
   * Serve a copy with hot reload on $PORT, for example "pnpm dev". When set, the
   * person who asked for a change watches it happen live while the build runs.
   */
  dev?: string;
  /** Path that answers when the app is up. Default "/". */
  health?: string;
  /** How long a copy may take to start answering. Default 90 seconds. */
  startTimeoutMs?: number;
  /** Extra environment for every command. */
  env?: NodeJS.ProcessEnv;
}

export class AppError extends Error {
  constructor(
    message: string,
    /** True when editing the code can't help, so the agent isn't asked to try. */
    readonly unfixable = false,
  ) {
    super(message);
  }
}

/** A port nothing is listening on right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

/** Run a setup command to completion. Rejects with the end of its output if it fails. */
export function runStep(command: string, cwd: string, env: NodeJS.ProcessEnv = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-8000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", () => reject(new AppError(`Couldn't run: ${command}`)));
    child.on("close", (code) => {
      if (code === 0) return resolve();
      const lines = tail.trim().split("\n").filter(Boolean).slice(-40).join("\n");
      reject(new AppError(`"${command}" failed.\n${lines}`));
    });
  });
}

/** One running copy of the app. */
export class AppProcess {
  private child: ChildProcess | null = null;
  private tail = "";
  exited = false;

  constructor(
    readonly port: number,
    readonly dir: string,
  ) {}

  /** Start `command` on a free port and wait until it answers. */
  static async start(command: string, dir: string, app: AppCommands): Promise<AppProcess> {
    const port = await freePort();
    const running = new AppProcess(port, dir);
    const child = spawn("sh", ["-c", command], {
      cwd: dir,
      env: { ...process.env, ...app.env, PORT: String(port), HOSTNAME: "127.0.0.1", HOST: "127.0.0.1" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    running.child = child;
    const keep = (chunk: Buffer) => {
      running.tail = (running.tail + chunk.toString()).slice(-8000);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.on("close", () => {
      running.exited = true;
    });
    child.on("error", () => {
      running.exited = true;
    });
    try {
      await running.ready(app.health ?? "/", app.startTimeoutMs ?? 90_000);
    } catch (error) {
      running.stop();
      throw error;
    }
    return running;
  }

  private async ready(path: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.exited) {
        const lines = this.tail.trim().split("\n").filter(Boolean).slice(-40).join("\n");
        throw new AppError(`The app stopped while starting.\n${lines}`);
      }
      if (await answers(this.port, path)) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new AppError("The app didn't start answering in time.");
  }

  /** Stop the copy and everything it started. */
  stop() {
    const child = this.child;
    if (!child?.pid || this.exited) return;
    const pid = child.pid;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    setTimeout(() => {
      try {
        if (!this.exited) process.kill(-pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }, 4000).unref();
  }
}

/** Whether something on `port` answers `path` without a server error. */
export function answers(port: number, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = request({ host: "127.0.0.1", port, path, method: "GET", timeout: 2000 }, (response) => {
      response.resume();
      resolve((response.statusCode ?? 500) < 500);
    });
    probe.on("error", () => resolve(false));
    probe.on("timeout", () => {
      probe.destroy();
      resolve(false);
    });
    probe.end();
  });
}

export const appDir = (root: string, app: AppCommands) => (app.dir ? join(root, app.dir) : root);
