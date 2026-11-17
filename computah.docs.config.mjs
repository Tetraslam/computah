// How the docs site (apps/docs) is served at computah.tetraslam.world.
// The site is a computah app itself. Its owner changes anything by typing into its box.
// Everyone else, signed in or not, can change the framed pieces in apps/docs/playground,
// each in a version only they see.
import { clientOnly, codex, exeSandbox } from "./packages/computah/dist/server/index.js";

const list = (value) =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
const guestSecret = process.env.COMPUTAH_GUEST_SECRET;

// OpenAI's faster service tier ("fast"), which codex takes as a config override. Other agents ignore it.
const tier = process.env.COMPUTAH_SERVICE_TIER;
const agent =
  process.env.COMPUTAH_AGENT === "codex" && tier
    ? codex({ model: process.env.COMPUTAH_MODEL, args: ["-c", `service_tier="${tier}"`] })
    : process.env.COMPUTAH_AGENT;

export default {
  agent,
  model: process.env.COMPUTAH_MODEL,
  port: Number(process.env.PORT ?? 8000),
  app: {
    dir: "apps/docs",
    install: "pnpm install --frozen-lockfile && pnpm --filter @tetraslam13/computah build",
    build: "pnpm build",
    start: "pnpm exec next start",
    dev: "pnpm exec next dev",
  },
  identity: process.env.COMPUTAH_IDENTITY === "exe" ? "exe" : "local",
  // Without a guest secret the pieces stay read-only for everyone but owners and trusted people.
  // A guest's version is about 95 MB of build on disk, so only the most recent ones are kept.
  guests: guestSecret ? { secret: guestSecret, forgetMs: 24 * 60 * 60 * 1000, keep: 40 } : undefined,
  trust: {
    owners: list(process.env.COMPUTAH_OWNERS ?? "you"),
    trusted: list(process.env.COMPUTAH_TRUSTED),
    members: guestSecret ? "everyone" : undefined,
    // The pieces load in the browser only (see apps/docs/components/playground.tsx), and this
    // check keeps them that way, so a visitor's code never runs on the server.
    memberPaths: ["apps/docs/playground/*.tsx"],
    memberCheck: clientOnly(),
    memberNote: "you can change the framed parts of each page. only you see your version.",
    memberRules:
      'Each of those files is one self-contained piece of a page. It must keep "use client" as its first line, export a default React component that takes no props, and import nothing except react. Change only the piece that belongs to the page they were on (the file is named after the page; the home page is home.tsx).',
    memberDailyLimit: 12,
    dailyLimit: Number(process.env.COMPUTAH_DAILY_LIMIT ?? 150),
  },
  // A visitor's request is worked on in a throwaway machine that has a copy of the code and nothing else.
  sandbox: process.env.COMPUTAH_SANDBOX === "exe" ? { in: exeSandbox() } : undefined,
  // Each running copy is about 100 MB of memory, and each agent is one sandbox machine.
  maxCopies: 12,
  maxAgents: 6,
  idleMs: 5 * 60 * 1000,
};
