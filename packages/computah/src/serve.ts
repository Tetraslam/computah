import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { type AgentName, agents } from "./server/agents.js";
import type { AppCommands } from "./server/app.js";
import { createFrontServer } from "./server/front.js";
import { exe, type Identity, local, type Trust } from "./server/identity.js";
import type { Sandbox } from "./server/sandbox.js";
import { type PushOptions, Site } from "./server/site.js";
import type { Agent } from "./server/types.js";

/** The shape of `computah.config.mjs`'s default export. */
export interface Config {
  /** Which coding agent makes the changes, or an adapter of your own. Default: the first one installed. */
  agent?: AgentName | Agent;
  model?: string;
  app: AppCommands;
  /** Who a visitor is: "exe" for exe.dev's login, "local" for this machine only, or your own function. */
  identity: "exe" | "local" | Identity;
  trust: Trust;
  /** Default 8000. */
  port?: number;
  /** Default 0.0.0.0. */
  host?: string;
  idleMs?: number;
  agentEnv?: NodeJS.ProcessEnv;
  /** How a change reaches people. Leave out to build and serve on this machine. */
  release?: { push: PushOptions };
  /** How many times the agent may try to fix a change that doesn't build. Default 3. */
  repairs?: number /** Run the agent in a sandbox: `{ in: exeSandbox() }`, for members only unless `for: "everyone"`. */;
  sandbox?: { in: Sandbox; for?: "members" | "everyone" };
  /** Let people who aren't signed in take part as guests. Needs `trust.members: "everyone"`. */
  guests?: { secret: string; forgetMs?: number };
  /** The most personal copies running at once. */
  maxCopies?: number;
}

export async function serveSite(argv: string[]): Promise<never> {
  const { values } = parseArgs({ args: argv, options: { config: { type: "string" }, port: { type: "string" }, cwd: { type: "string" } } });
  const cwd = resolve(values.cwd ?? process.cwd());
  const path = resolve(cwd, values.config ?? "computah.config.mjs");
  if (!existsSync(path)) fail(`No config at ${path}. See the README for an example.`);
  const config = ((await import(pathToFileURL(path).href)) as { default?: Config }).default;
  if (!config?.trust?.owners?.length) fail("The config needs `trust.owners`.");
  if (!config.release?.push && !config.app?.start) fail("The config needs `app.start`, or `release.push` if a host serves the app.");

  const installed = (command: string) => spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
  const name = typeof config.agent === "string" ? config.agent : (["claude", "opencode", "codex"] as const).find(installed);
  const agent = typeof config.agent === "object" ? config.agent : name && name in agents ? agents[name]({ model: config.model }) : null;
  if (!agent) fail("No coding agent found. Install Claude Code, OpenCode or Codex, or set `agent` in the config.");

  const identity = config.identity === "exe" ? exe() : config.identity === "local" ? local() : config.identity;
  if (typeof identity !== "function") fail('`identity` must be "exe", "local" or a function.');

  const site = new Site({
    cwd,
    agent,
    app: config.app ?? { start: "" },
    identity,
    trust: config.trust,
    idleMs: config.idleMs,
    agentEnv: config.agentEnv,
    release: config.release,
    repairs: config.repairs,
    sandbox: config.sandbox,
    guests: config.guests,
    maxCopies: config.maxCopies,
  });
  const port = Number(values.port ?? config.port ?? 8000);
  const host = config.host ?? "0.0.0.0";
  console.log(config.release?.push ? "computah: starting…" : "computah: building the app…");
  try {
    await site.init();
  } catch (error) {
    fail(`The app didn't build or start.\n${error instanceof Error ? error.message : error}`);
  }
  const server = createFrontServer(site);
  server.on("error", (error: NodeJS.ErrnoException) => fail(error.code === "EADDRINUSE" ? `Port ${port} is in use.` : error.message));
  server.listen(port, host, () => console.log(`computah: serving on http://${host}:${port}, changes by ${agent.name}`));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      site.stop();
      server.close();
      setTimeout(() => process.exit(0), 300);
    });
  }
  return new Promise<never>(() => {});
}

function fail(message: string): never {
  console.error(`computah: ${message}`);
  process.exit(1);
}
