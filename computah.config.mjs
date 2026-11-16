// How the demo is served with a version per person. Run `pnpm serve` at the repo root.
const owners = (process.env.COMPUTAH_OWNERS ?? "you").split(",").map((entry) => entry.trim());

export default {
  agent: process.env.COMPUTAH_AGENT,
  model: process.env.COMPUTAH_MODEL,
  port: Number(process.env.PORT ?? 8000),
  app: {
    dir: "apps/demo",
    install: "pnpm install --frozen-lockfile && pnpm --filter @tetraslam13/computah build",
    build: "pnpm build",
    start: "pnpm exec next start",
    dev: "pnpm exec next dev",
  },
  // On exe.dev its proxy says who each visitor is. Anywhere else, only this machine counts as you.
  identity: process.env.COMPUTAH_IDENTITY === "exe" ? "exe" : "local",
  trust: {
    owners,
    trusted: (process.env.COMPUTAH_TRUSTED ?? "").split(",").filter(Boolean),
    members: "everyone",
    // Members may change the demo's pages and nothing else.
    memberPaths: ["apps/demo/app/**"],
  },
};
