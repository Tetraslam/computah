// How the docs site (apps/docs) is served at computah.tetraslam.world.
// The site is a computah app itself. Its owner changes anything by typing into its box.
// Everyone else, signed in or not, can change the framed pieces in apps/docs/playground,
// each in a version only they see.
import { clientOnly, exeSandbox } from "./packages/computah/dist/server/index.js";

const list = (value) =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
const guestSecret = process.env.COMPUTAH_GUEST_SECRET;

export default {
  agent: process.env.COMPUTAH_AGENT,
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
  guests: guestSecret ? { secret: guestSecret, forgetMs: 24 * 60 * 60 * 1000 } : undefined,
  trust: {
    owners: list(process.env.COMPUTAH_OWNERS ?? "you"),
    trusted: list(process.env.COMPUTAH_TRUSTED),
    members: guestSecret ? "everyone" : undefined,
    // The pieces load in the browser only (see apps/docs/components/playground.tsx), and this
    // check keeps them that way, so a visitor's code never runs on the server.
    memberPaths: ["apps/docs/playground/*.tsx"],
    memberCheck: clientOnly(),
    memberNote:
      'Each of those files is one self-contained piece of a page. It must keep "use client" as its first line, export a default React component that takes no props, and import nothing except react. Change only the piece that belongs to the page they were on (the file is named after the page; the home page is home.tsx).',
    memberDailyLimit: 12,
    dailyLimit: 150,
  },
  // A visitor's request is worked on in a throwaway machine that has a copy of the code and nothing else.
  sandbox: process.env.COMPUTAH_SANDBOX === "exe" ? { in: exeSandbox() } : undefined,
  maxCopies: 5,
  idleMs: 5 * 60 * 1000,
};
