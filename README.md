# computah, make this app better

An improvements box for your app. You type what should change, and a coding agent you already have (Claude Code, OpenCode or Codex) makes the change in your repo while you watch.

![The box after turning a counter into a stopwatch](docs/box-done.png)

The idea is Patrick Collison's: ["a freeform text input that's hooked up to an agent that yolo implements whatever is submitted."](https://x.com/patrickc/status/2116636967517798672) This is that, as a library.

## Use it

In your project (it must be a git repository):

```sh
pnpm add computah
```

Put the box anywhere in your app:

```tsx
import { Computah } from "computah";

<Computah />;
```

Run the runner next to your dev server:

```json
{ "scripts": { "dev": "computah -- next dev" } }
```

Open your app and press `Ctrl+.` (`⌘.` on a Mac).

## What it does

- **Shows the work.** Each request shows what the agent is doing right now, and every step on demand.
- **Undo.** Every finished change has an undo. It never overwrites edits made since.
- **Leaves no mess.** A request that fails or is stopped keeps none of its edits.
- **Knows where you were.** The page, your selection, the window size, and an element you point at all go to the agent.
- **Queues.** Send several requests; they run one at a time, in order.
- **Commits.** Each change is its own commit, unless it touches files you have uncommitted edits in.
- **Stays out of your styles.** The box lives in a shadow root and has no dependencies beyond React.

## Options

`<Computah>`:

| prop       | default                 |                                             |
| ---------- | ----------------------- | ------------------------------------------- |
| `hotkey`   | `"mod+."`               | opens and closes the box                    |
| `title`    | `"improvements"`        | the window's title                          |
| `launcher` | `true`                  | show the small button that opens it         |
| `endpoint` | `http://127.0.0.1:4821` | where the runner is                         |
| `secret`   | none                    | bearer token, for a runner started with one |

`computah` (the development runner): `--agent claude|opencode|codex`, `--model`, `--port`, `--no-commit`, `--cwd`, `--host`, `--secret`, `--origin`. Run `computah --help`.

## Safety

The runner turns text into code changes, so who can reach it matters.

- By default it listens on this machine only, checks that the connection really comes from this machine, and only accepts browser requests from pages served by this machine. Another website open in your browser can't use it, and neither can another computer on your network.
- To use it from elsewhere, start it with `--secret` and pass the same `secret` to the box. Anyone with the secret can change your code, so only give the box to people you'd give commit access.
- The agent runs with your permissions, the same as when you run it yourself.

## Serve the app itself

In development the box changes the checkout on your machine. To put it in a running app that other people use, let the runner serve the app:

```sh
computah serve
```

It reads `computah.config.mjs`:

```js
export default {
  agent: "codex",
  app: {
    install: "pnpm install --frozen-lockfile",
    build: "pnpm build",
    start: "pnpm start", // must listen on $PORT
    dev: "pnpm dev", // optional: lets the person asking watch their change live
  },
  identity: "exe", // exe.dev's login, "local", or (request) => ({ id, name })
  trust: {
    owners: ["you@example.com"],
    trusted: ["friend@example.com"],
    members: "everyone",
    memberPaths: ["app/**"],
  },
};
```

![The served demo after three changes](docs/served.png)

What each person can do:

| level          | what the box does for them                                                      |
| -------------- | ------------------------------------------------------------------------------- |
| owner, trusted | changes the app for everyone                                                    |
| member         | changes their own version, which only they see. An owner can make it everyone's |
| visitor        | nothing. They never see the box                                                 |

How a change reaches people:

1. The person who asked is moved onto a hot-reloading copy and watches the change happen.
2. Meanwhile the change is built. If the build fails, the change is reverted and nobody else ever saw it.
3. The built copy is swapped in. Pages already open keep talking to the copy that served them, so nothing breaks mid-swap.

Each person's version is a git branch (`computah/u/<name>`); everyone's is `computah/main`. Personal copies start when their person shows up and stop when idle.

## Adapters

| kind     | built in                                   | your own                                 |
| -------- | ------------------------------------------ | ---------------------------------------- |
| agent    | `claude`, `opencode`, `codex`              | an object with `command()` and `parse()` |
| identity | `exe`, `local`, `header(name)`             | a function from request to person        |
| app      | any install, build, start and dev commands |                                          |

## Not done yet

- Changes reach people by building and swapping on the machine that serves the app. There is no adapter yet for hosts that build for you (Vercel) or for running the agent in a separate sandbox.
- A member's agent runs with the same access to the machine as an owner's. `memberPaths` limits what a change may touch, not what the agent can read while working.
- When someone's own version conflicts with everyone's, it is marked as behind and left alone. Nothing resolves the conflict yet.
- Not published to npm yet.

## Develop

```sh
pnpm install
pnpm dev        # the demo card at localhost:3000, with its own box
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

The look is described in [BRIEF.md](BRIEF.md).

## License

MIT
