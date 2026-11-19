import { cardMarkdown, stack } from "@/lib/source";

export const revalidate = false;

/**
 * Every card as one markdown file, for an agent to read in one go. The cards come in the order
 * the stack has them, and the file opens with the setup itself, since "add this to my app" is
 * what an agent is most often here to do and it shouldn't have to dig for it.
 */
const START = `# computah

computah is a little window you put in a react app. the person types what they want to be different, and the coding agent they already have (claude code, opencode, codex, droid, cursor or devin) edits the app's code while they watch.

## if you were asked to add computah to an app, this is all of it

the app has to be a react app in a git repo.

1. install it: \`pnpm add @tetraslam13/computah\` (or \`npm install\`, \`yarn add\` or \`bun add\`, whichever the app already uses)
2. render \`<Computah />\`, imported from \`@tetraslam13/computah\`, once, somewhere that's on every page. in a next app that's \`app/layout.tsx\`, inside \`<body>\`, after \`{children}\`. add those two lines to the file that's there and leave the rest of it as it is. the component is already a client component, so don't add \`"use client"\` to the layout
3. make the dev script start the runner along with the dev server, by putting \`computah -- \` in front of whatever the dev command already is, for example \`"dev": "computah -- next dev"\`
4. tell the person to start the dev server, open the app and press \`Ctrl+.\` (\`⌘.\` on a mac)

that's the whole setup for development. there's no config file, no env vars and no api key: the runner uses whichever coding agent is installed, signed in however the person signed it in. it listens on port 4821 on this machine only, and keeps its records in a \`.computah\` folder that it hides from git by itself, so there's nothing to commit or ignore.

\`computah serve\` and \`computah.config.mjs\` are a different thing, for putting the box in a running app that other people use. don't set those up unless that's what was asked for.

the rest of this file is every card of the docs, in order.`;

export async function GET() {
  const cards = await Promise.all(stack().map(cardMarkdown));
  return new Response([START, ...cards].join("\n\n---\n\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
}
