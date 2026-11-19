# computah

a little window you put in your app. you type what you want to be different, and the coding agent you already have (claude code, opencode, codex, droid, cursor or devin) goes and edits the code while you watch

![me asking for a stopwatch and watching the counter turn into one](https://computah.sh/demo.gif)

```sh
pnpm add @tetraslam13/computah
```

**[computah.sh](https://computah.sh)** is the docs, and the docs are a computah app too, so you can open the box there and change the site right now (only you see your version)

## setting it up

the way i'd do it is tell your coding agent:

> add computah to this app. the instructions are at https://computah.sh/llms-full.txt

or by hand, it's two things. put the box anywhere in a react app that lives in a git repo:

```tsx
import { Computah } from "@tetraslam13/computah";

<Computah />;
```

and run your dev server through computah instead of on its own:

```sh
computah -- next dev
```

then open your app and press `Ctrl+.` (`⌘.` on a mac)

it uses your agent signed in however you signed it in, so there's no account to make and no api key to paste anywhere

## what it does

- you see what the agent is doing while it does it
- every change has an undo, and a change that fails or gets stopped leaves nothing behind
- you can point at the thing you mean, and it also knows what page you're on
- each change is its own git commit
- it remembers what you asked before, so "no, bigger" works
- it looks like a little 1-bit window by default and you can [make it look like your app](https://computah.sh/styling)

## past your own laptop

the same box works in an app other people use. all of this is one config file, and each of these is a card on the docs site

| if you want                                                                 | read                                                     |
| --------------------------------------------------------------------------- | -------------------------------------------------------- |
| to change a personal app from your phone                                    | [serve it](https://computah.sh/serve-it)                 |
| family or friends to change it too                                          | [people and trust](https://computah.sh/people-and-trust) |
| strangers to change parts of a public site, each in a version only they see | [letting anyone change it](https://computah.sh/guests)   |
| those people to pay for their own changes with their chatgpt plan           | [their own chatgpt plan](https://computah.sh/chatgpt)    |
| it on vercel                                                                | [on vercel](https://computah.sh/on-vercel)               |
| the agent kept off your machine                                             | [sandboxes](https://computah.sh/sandboxes)               |
| to know who can make it change your code                                    | [safety](https://computah.sh/safety)                     |

on the docs site, 24 strangers asking for changes at the same moment each had theirs in 10 to 22 seconds

## if you're an agent

hi :) everything is written so you can read it

- [`llms-full.txt`](https://computah.sh/llms-full.txt) is all of the docs in one file
- [`llms.txt`](https://computah.sh/llms.txt) is the list of cards, and any card is markdown if you add `.md` to its address, like [`/start-here.md`](https://computah.sh/start-here.md)
- every prop, flag and config field is on [`/reference.md`](https://computah.sh/reference.md)

the short version of a normal setup, in a react app that's a git repo:

1. `pnpm add @tetraslam13/computah` (or the same with npm, yarn or bun)
2. render `<Computah />` from `@tetraslam13/computah` once, somewhere on every page. in a next app that's the root layout, inside `<body>`. it's already a client component, so the file you put it in doesn't need `"use client"`
3. change the dev script so the runner starts with the dev server: `"dev": "computah -- next dev"`, keeping whatever the dev command already was after the `--`
4. tell the person to open the app and press `Ctrl+.`

nothing else is needed for development: no env vars, no keys, no config file. `computah serve` and `computah.config.mjs` are only for putting it in an app other people use, and that's [serve it](https://computah.sh/serve-it.md)

## where this came from

patrick collison [posted](https://x.com/patrickc/status/2116636967517798672) that he's been putting "a freeform text input that's hooked up to an agent that yolo implements whatever is submitted" into all his personal apps. i wanted that in all of mine without rebuilding it every time, so now it's a library

## working on computah itself

```sh
pnpm install
pnpm dev        # the demo card at localhost:3000, with its own box
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

the docs site is `apps/docs`, the library is `packages/computah`, and the look is described in [BRIEF.md](https://github.com/tetraslam/computah/blob/master/BRIEF.md)

mit
