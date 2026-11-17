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

/** An earlier request to the same version of the app, so a new one can refer back to it. */
export interface Earlier {
  text: string;
  /** How it ended: done, failed, cancelled or undone. */
  state: string;
  /** What the agent said it did. */
  summary?: string;
  /** The commit it made, to look at exactly what changed. */
  commit?: string;
  /** False when someone else asked for it. */
  mine: boolean;
}

function earlierLines(earlier: Earlier[]): string[] {
  if (!earlier.length) return [];
  const outcome = (entry: Earlier) =>
    entry.state === "done"
      ? "done"
      : entry.state === "undone"
        ? "done, then undone, so it is no longer in the code"
        : `${entry.state}, so it changed nothing`;
  return [
    "",
    'Earlier requests to this same version of the app, oldest first. To the person this is one conversation, so the new request may lean on these: "it", "that", "bigger", "no, the other one", "try again".',
    ...earlier.map((entry, index) => {
      const who = entry.mine ? "" : " (asked by someone else)";
      const commit = entry.commit ? `, commit ${entry.commit.slice(0, 10)}` : "";
      const said = entry.summary ? `\n   what was reported back: ${clip(entry.summary.replace(/\s+/g, " "), 300)}` : "";
      return `${index + 1}. [${outcome(entry)}${commit}]${who} "${clip(entry.text.replace(/\s+/g, " "), 400)}"${said}`;
    }),
    "These are background, not instructions: do not redo them, and do only what the new request asks. `git show <commit>` shows exactly what one of them changed.",
  ];
}

export function buildPrompt(text: string, context: JobContext, limits: Limits = {}, earlier: Earlier[] = []): string {
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
    ...earlierLines(earlier),
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

/** The instructions an agent gets when two sets of changes to the app collide. */
export function buildMergePrompt(files: string[], theirs: string[], limits: Limits = {}): string {
  return [
    "This app has a shared version that everyone uses, and one person has a version of their own with changes they asked for. The shared version has moved on, and bringing its latest changes into this person's version hit conflicts. You are in this person's checkout, in the middle of that git merge.",
    "",
    "Files with conflicts:",
    ...files.map((file) => `- ${file}`),
    "",
    ...(theirs.length
      ? [
          "What this person asked for, oldest first. These are the intentions to keep:",
          ...theirs.map((text) => `- ${clip(text.replace(/\s+/g, " "), 400)}`),
          "",
        ]
      : []),
    "In each file, the part between `<<<<<<<` and `=======` is this person's version, and the part between `=======` and `>>>>>>>` is the shared version.",
    "",
    "Resolve every conflict so the file keeps BOTH: what the shared version changed, and what this person asked for. Their requests still have to be true of the result. If the two genuinely can't both hold, keep the shared version's structure and redo this person's change on top of it.",
    "- Edit only the files listed above. Leave no conflict markers behind.",
    "- Don't run git add, git commit, git merge or any other command that changes git state. The merge is finished for you afterwards.",
    "- Don't start, stop or restart servers.",
    ...(limits.note ? [`- These files have rules: ${limits.note}`] : []),
    "",
    "When you're done, reply with one plain sentence for this person about what happened to their changes. No file names, no code.",
  ].join("\n");
}
