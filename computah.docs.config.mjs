// How the docs site (apps/docs) is served at computah.tetraslam.world.
// The site is a computah app itself: its owner changes it by typing into its box.
const list = (value) =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

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
  trust: {
    owners: list(process.env.COMPUTAH_OWNERS ?? "you"),
    trusted: list(process.env.COMPUTAH_TRUSTED),
    // Nobody else can change the docs: the site is public, and a change is code that runs on its server.
  },
};
