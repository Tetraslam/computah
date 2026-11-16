import type { JobContext } from "./types.js";

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

/** The instructions an agent gets for one request from the box. */
export function buildPrompt(text: string, context: JobContext): string {
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
    "",
    "How to work:",
    "- Find the code behind what they were looking at before changing anything. Follow the repo's conventions and any AGENTS.md or CLAUDE.md.",
    "- Make the smallest complete change that does what they asked. If the request is ambiguous, choose the reading a user of this app most likely meant.",
    "- The app is probably running with hot reload, so every save is live. Don't leave a file half-edited or broken.",
    "- Don't start, stop or restart servers. Don't commit, push or change git state. Don't install dependencies unless the request can't be done without one.",
    "- If the repo has a fast type check or lint command, run it on what you changed and fix what you broke.",
    "- If you can't or shouldn't do what was asked, change nothing and say why.",
    "",
    "When you're done, reply with one or two plain sentences for the person who asked: what changed, in terms of what they'll see. No file names, no code, no headings.",
  ].join("\n");
}
