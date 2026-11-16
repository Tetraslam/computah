# computah

An improvements box: a React component where a user types a change, and a local runner that hands it to a coding agent in the app's repo.

## layout

- `packages/computah`: the library. `src/server` is the runner (job queue, agent adapters, git snapshots and undo, the guarded HTTP server), `src/react` is the box, `src/cli.ts` is the `computah` command.
- `apps/demo`: a Next app that carries the box and can be rewritten through it.

## stack

From [tetrastack](https://github.com/tetraslam/tetrastack): pnpm, TypeScript, biome, vitest, Next 16 and Tailwind 4 in the demo. The library itself has no runtime dependencies beyond React: it is dropped into other people's apps, so it ships its own styles inside a shadow root and builds with plain `tsc`.

## rules

- The runner turns text into code changes. `refuse()` in `src/server/http.ts` is the security boundary; any change there needs a test in `test/server.test.ts`.
- A job that fails or is stopped keeps none of its edits. Undo never overwrites later work.
- The look is set in `BRIEF.md`. Read it before touching the box's styles.

## checks

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```
