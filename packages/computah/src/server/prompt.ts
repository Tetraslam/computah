import type { JobContext } from "./types.js";

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

/** The instructions an agent gets for one request from the box. */
/** What a request is allowed to change, told to the agent so it doesn't waste the request on something that will be refused. */
export interface Limits {
  /** Globs of the only files that may change. */
  paths?: string[];
  /** Any further rules, in plain words. */
  note?: string;
}

export function buildPrompt(text: string, context: JobContext, limits: Limits = {}): string {
  const where: string[] = [];
  if (context.url) where.push(`- Page they were on: ${clip(context.url, 500)}`);
  if (context.title) where.push(`- Page title: ${clip(context.title, 200)}`);
  if (context.viewport) where.push(`- Window size: ${context.viewport.width}×${context.viewport.height}`);
  if (context.selection) where.push(`- Text they had selected: "${clip(context.selection, 1000)}"`);
  if (context.element) {
    const element = context.element;
    where.push(`- Element they pointed at: ${clip(element.selector, 300)}`);
    if (element.component) where.push(`  - React component: ${clip(element.component, 200)}`);
    if (element.text) where.push(`  - Its text: "${clip(element.text, 300)}"`);
    if (element.html) where.push(`  - Its HTML: ${clip(element.html, 1200)}`);
  }

  return [
    "A person using this app typed a change request into its improvements box. You are in the app's repository. Make the change.",
    "",
    "Their request, verbatim:",
    "<request>",
    text.trim(),
    "</request>",
    ...(where.length ? ["", "Where they were when they asked:", ...where] : []),
    ...(limits.paths?.length
      ? [
          "",
          "This person may only change part of the app. You may only create or edit files matching:",
          ...limits.paths.map((path) => `- ${path}`),
          ...(limits.note ? [limits.note] : []),
          "A change to any other file is thrown away along with the whole request. If what they ask can't be done within those files, change nothing and say so.",
        ]
      : []),
    "",
    "How to work:",
    "- Find the code behind what they were looking at before changing anything. Follow the repo's conventions and any AGENTS.md or CLAUDE.md.",
    "- Make the smallest complete change that does what they asked. If the request is ambiguous, choose the reading a user of this app most likely meant.",
    "- The app is probably running with hot reload, so every save is live. Don't leave a file half-edited or broken.",
    "- Don't start, stop or restart servers. Don't commit, push or change git state. Don't install dependencies unless the request can't be done without one.",
    "- If the repo has a fast type check or lint command, run it on what you changed and fix what you broke.",
    "- If you can't or shouldn't do what was asked, change nothing and say why.",
    "",
    "When you're done, reply with one or two plain sentences for the person who asked: what changed, in terms of what they'll see. No file names, no code, no headings, and nothing about checks you ran unless one is still failing.",
  ].join("\n");
}

/** The instructions an agent gets when the change it just made doesn't build. */
export function buildRepairPrompt(text: string, problem: string): string {
  return [
    "You just changed this app's code for a request from its improvements box. The change is committed, but the app no longer builds.",
    "",
    "The request was:",
    "<request>",
    text.trim(),
    "</request>",
    "",
    "The build failed with:",
    "<error>",
    clip(problem.trim(), 6000),
    "</error>",
    "",
    "Fix the build while keeping what the request asked for. Look at your last commit (`git show --stat HEAD`) to see what you changed.",
    "- Fix the cause, whether it's in your change or in code your change exposed. Don't remove the feature to make the error go away.",
    "- Run the failing step yourself if you can, and check it passes before you finish.",
    "- Don't start, stop or restart servers. Don't commit, push or change git state.",
    "",
    "When you're done, reply with one or two plain sentences for the person who asked: what they'll see now. No file names, no code.",
  ].join("\n");
}
