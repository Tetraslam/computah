#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { type AgentName, agents } from "./server/agents.js";
import { serve } from "./server/http.js";
import { Computah } from "./server/jobs.js";

const HELP = `computah: the runner behind the improvements box.

  computah [options] [-- <command to run alongside, e.g. next dev>]
  computah serve [--config computah.config.mjs] [--port 8000]
      serve the app itself, with a version per person (see the README)

  --agent <claude|opencode|codex>  which coding agent makes the changes (default: the first one installed)
  --model <name>                   model to pass to the agent
  --port <number>                  default 4821
  --host <address>                 default 127.0.0.1; anything else needs --secret
  --secret <text>                  require this as a bearer token (or set COMPUTAH_SECRET)
  --origin <url>                   allow a page origin beyond this machine (repeatable)
  --no-commit                      leave changes uncommitted
  --cwd <dir>                      the repository to work in (default: here)
`;

if (process.argv[2] === "serve") {
  const { serveSite } = await import("./serve.js");
  await serveSite(process.argv.slice(3));
}

const split = process.argv.indexOf("--");
const own = split === -1 ? process.argv.slice(2) : process.argv.slice(2, split);
const alongside = split === -1 ? [] : process.argv.slice(split + 1);

const { values } = parseArgs({
  args: own,
  options: {
    agent: { type: "string" },
    model: { type: "string" },
    port: { type: "string" },
    host: { type: "string" },
    secret: { type: "string" },
    origin: { type: "string", multiple: true },
    "no-commit": { type: "boolean" },
    cwd: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const installed = (command: string) => spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
const name = (values.agent ?? (["claude", "opencode", "codex"] as const).find(installed)) as AgentName | undefined;
if (!name || !(name in agents)) {
  console.error(
    values.agent
      ? `Unknown agent "${values.agent}". Use claude, opencode or codex.`
      : "No coding agent found. Install Claude Code, OpenCode or Codex.",
  );
  process.exit(1);
}

const computah = new Computah({
  cwd: values.cwd ?? process.cwd(),
  agent: agents[name]({ model: values.model }),
  commit: !values["no-commit"],
});
const port = Number(values.port ?? 4821);
const host = values.host ?? "127.0.0.1";

try {
  await computah.init();
  await serve(computah, {
    port,
    host,
    secret: values.secret ?? process.env.COMPUTAH_SECRET,
    origins: values.origin,
  });
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  console.error(
    code === "EADDRINUSE"
      ? `Port ${port} is in use. Is another computah already running? Pass --port to use another.`
      : `computah: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(1);
}
console.log(`computah: ${name} will make changes in ${computah.repo} (http://${host}:${port})`);

if (alongside.length) {
  const child = spawn(alongside[0] as string, alongside.slice(1), {
    stdio: "inherit",
    shell: false,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", () => {
    console.error(`computah: couldn't run ${alongside[0]}`);
    process.exit(1);
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
}
