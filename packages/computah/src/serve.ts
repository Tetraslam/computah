import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { type AgentName, agents } from "./server/agents.js";
import type { AppCommands } from "./server/app.js";
import { createFrontServer } from "./server/front.js";
import { exe, type Identity, local, type Trust } from "./server/identity.js";
import { Site } from "./server/site.js";
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
}

export async function serveSite(argv: string[]): Promise<never> {
  const { values } = parseArgs({ args: argv, options: { config: { type: "string" }, port: { type: "string" }, cwd: { type: "string" } } });
  const cwd = resolve(values.cwd ?? process.cwd());
  const path = resolve(cwd, values.config ?? "computah.config.mjs");
  if (!existsSync(path)) fail(`No config at ${path}. See the README for an example.`);
  const config = ((await import(pathToFileURL(path).href)) as { default?: Config }).default;
  if (!config?.app?.start || !config.trust?.owners?.length) fail("The config needs at least `app.start` and `trust.owners`.");

  const installed = (command: string) => spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
  const name = typeof config.agent === "string" ? config.agent : (["claude", "opencode", "codex"] as const).find(installed);
  const agent = typeof config.agent === "object" ? config.agent : name && name in agents ? agents[name]({ model: config.model }) : null;
  if (!agent) fail("No coding agent found. Install Claude Code, OpenCode or Codex, or set `agent` in the config.");

  const identity = config.identity === "exe" ? exe() : config.identity === "local" ? local() : config.identity;
  if (typeof identity !== "function") fail('`identity` must be "exe", "local" or a function.');

  const site = new Site({ cwd, agent, app: config.app, identity, trust: config.trust, idleMs: config.idleMs, agentEnv: config.agentEnv });
  const port = Number(values.port ?? config.port ?? 8000);
  const host = config.host ?? "0.0.0.0";
  console.log("computah: building the app…");
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
