# computah, make this app better

An improvements box for your app. You type what should change, and a coding agent you already have (Claude Code, OpenCode or Codex) makes the change in your repo while you watch.

![Typing a request into the box and watching a counter become a stopwatch](docs/demo.gif)

The idea is Patrick Collison's: ["a freeform text input that's hooked up to an agent that yolo implements whatever is submitted."](https://x.com/patrickc/status/2116636967517798672) This is that, as a library.

## Ways to use it

| you are                               | you set up                                                             | what happens when someone types in the box                                         |
| ------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| building an app on your laptop        | `<Computah />` and `computah -- next dev`                              | the code on your laptop changes and hot reload shows it in seconds                 |
| using a personal app every day        | the app on a small always-on machine, `computah serve`, you as owner   | the app changes for you from any device, phone included                            |
| sharing an app with family or friends | the same, with them listed as `trusted`                                | it changes for everyone, and anyone trusted can undo it                            |
| running an app for a community        | the same, with `members: "everyone"`                                   | each person changes a version of their own. You promote the good ones to everybody |
| hosting on Vercel                     | a runner on another machine, `release: { push }`, one route in the app | the change is pushed to GitHub and Vercel builds it. Members get a preview link    |

The first row is two lines. Every other row is one config file that names your build commands, your owners, and how to tell who is visiting.

## Use it

In your project (it must be a git repository):

```sh
pnpm add @tetraslam13/computah
```

Put the box anywhere in your app:

```tsx
import { Computah } from "@tetraslam13/computah";

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
2. Meanwhile the change is built. If the build fails, the agent is shown the error and fixes it, up to three times. Only if it can't is the change taken back out, and nobody else ever saw it.
3. The built copy is swapped in. Pages already open keep talking to the copy that served them, so nothing breaks mid-swap.

Each person's version is a git branch (`computah/u/<name>`); everyone's is `computah/main`. Personal copies start when their person shows up and stop when idle.

## An app on Vercel

Vercel can't run the runner, so the runner lives on another machine with a clone of the repo, and pushes each change to GitHub for Vercel to build.

On the runner, `computah.config.mjs`:

```js
import { gateway, vercel } from "@tetraslam13/computah/server";

export default {
  app: { install: "pnpm install --frozen-lockfile", build: "pnpm build" },
  identity: gateway(process.env.COMPUTAH_SECRET),
  trust: { owners: ["you@example.com"], members: "everyone" },
  release: { push: { branch: "main", host: vercel({ projectId: "prj_..." }) } }, // needs VERCEL_TOKEN
};
```

In the app, one route passes the box's requests to the runner and says who is signed in:

```ts
// app/api/computah/[...path]/route.ts
import { createProxy } from "@tetraslam13/computah/next";

export const { GET, POST } = createProxy({
  runner: process.env.COMPUTAH_RUNNER,
  secret: process.env.COMPUTAH_SECRET,
  identify: async (request) => {
    const user = await yourAuth(request);
    return user && { id: user.id, name: user.email };
  },
});
```

and the box points at it: `<Computah endpoint="/api/computah" />`.

- An owner's change is pushed to the branch Vercel serves. The box waits for the deployment and reloads.
- A member's change is pushed to a branch of their own, and the box links to its preview deployment.
- The build is checked on the runner before pushing. If Vercel's build still fails, its log goes to the agent to fix.
- This takes as long as Vercel takes to build, and there is no live preview while you wait.

Another host is one function: `deployed({ sha, branch, production })` waits for the build and returns its address, or throws with the build log.

## Sandboxes

By default the agent runs on the machine that runs the runner, with that machine's access. A sandbox runs it somewhere disposable instead: the code is copied in (without ignored files, so no `.env`), the agent works there, and only a patch of what it changed comes back.

```js
import { exeSandbox } from "@tetraslam13/computah/server";

export default {
  // ...
  sandbox: { in: exeSandbox() }, // members only. add `for: "everyone"` to sandbox owners too
};
```

| sandbox | what it is | what it needs |
| --- | --- | --- |
| `exeSandbox()` | a standalone exe.dev VM per request, cut off from the internet except exe's model gateway | an ssh key exe.dev knows, on the runner's machine |
| `modalSandbox()` | a Modal Sandbox per request | the `modal` package, Modal credentials, and a Modal Secret holding your model key |

Measured: on exe, a real Claude Code change took 12 seconds end to end, about 5 of them starting the VM. On Modal, the first sandbox took 113 seconds while the image built, and 2 seconds after that.

While the agent is in a sandbox there is no live preview: its changes arrive all at once when it finishes.

## Adapters

| kind     | built in                                   | your own                                 |
| -------- | ------------------------------------------ | ---------------------------------------- |
| agent    | `claude`, `opencode`, `codex`              | an object with `command()` and `parse()` |
| identity | `exe`, `local`, `header(name)`             | a function from request to person        |
| app      | any install, build, start and dev commands |                                          |
| host     | `vercel`                                   | an object with `deployed()`              |
| sandbox  | `exeSandbox`, `modalSandbox`               | an object with `open()`                  |

## Not done yet

- The Vercel adapter has run against a real Vercel project with a scripted agent: a production deploy, a preview for a member, and a failed build that was fixed. The app-side route has only run in tests.
- Without a sandbox, a member's agent runs with the same access to the machine as an owner's. With one, the agent is contained, but the code it writes still runs on the serving machine once built.
- The Modal sandbox has only run with a scripted agent. A real agent there needs a model key in a Modal Secret, which hasn't been tried.
- When someone's own version conflicts with everyone's, it is marked as behind and left alone. Nothing resolves the conflict yet.

## Develop

```sh
pnpm install
pnpm dev        # the demo card at localhost:3000, with its own box
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

The look is described in [BRIEF.md](BRIEF.md).

## License

MIT
