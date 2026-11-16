import { execFileSync } from "node:child_process";

/** One change made to this site by typing into its own box, read from git. */
export interface Change {
  sha: string;
  /** Whoever asked, as the runner recorded them. Never an email address. */
  by: string;
  date: string;
  /** What they typed, verbatim. */
  request: string;
  /** True when a later commit took it back out (an undo, or a build that couldn't be fixed). */
  undone: boolean;
}

const FIELD = "\x1f";
const RECORD = "\x1e";

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** Show a name, but only the part before the @ when the runner recorded an email. */
function displayName(author: string): string {
  return author.replace(/@.*$/, "").trim() || "someone";
}

/**
 * The request text from a commit the runner made. Its message is the subject, a blank line,
 * the request as typed, a blank line, and "Requested through the improvements box[ by name]."
 */
export function requestFrom(subject: string, body: string): string {
  const paragraphs = body.trim().split(/\n\s*\n/);
  if (/^Requested through the improvements box/.test(paragraphs.at(-1) ?? "")) paragraphs.pop();
  return paragraphs.join("\n\n").trim() || subject.replace(/^computah: /, "");
}

/**
 * Every change made to this app through its box, newest first. Read at build time, so the
 * list is exactly what this build contains. Outside a git checkout it is empty.
 */
export function readChanges(): Change[] {
  let log: string;
  try {
    // Only commits that touch this app's own directory ("." is the app when built).
    log = git(["log", `--format=%H${FIELD}%an${FIELD}%aI${FIELD}%s${FIELD}%b${RECORD}`, "--", "."]);
  } catch {
    return [];
  }
  const records = log
    .split(RECORD)
    .map((record) => record.replace(/^\n+/, ""))
    .filter(Boolean)
    .map((record) => {
      const [sha = "", author = "", date = "", subject = "", body = ""] = record.split(FIELD);
      return { sha, author, date, subject, body };
    });
  const reverted = new Set<string>();
  for (const record of records) {
    for (const match of record.body.matchAll(/This reverts commit ([0-9a-f]{40})/g)) reverted.add(match[1] as string);
  }
  return records
    .filter((record) => record.subject.startsWith("computah: ") && !record.subject.startsWith("computah: fix the build for "))
    .map((record) => ({
      sha: record.sha,
      by: displayName(record.author),
      date: record.date,
      request: requestFrom(record.subject, record.body),
      undone: reverted.has(record.sha),
    }));
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The day as the person who asked saw it: the date part of git's own timestamp, not converted. */
export function formatDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return "";
  const [, year, month, day] = match;
  return `${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}`;
}

/** The same list as markdown, for the card's .md twin and llms-full.txt. */
export function changesMarkdown(changes: Change[]): string {
  if (!changes.length) return "nothing yet. the first change made by typing will show up here.";
  return changes
    .map((change) => {
      const quoted = change.request
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      return `- ${formatDate(change.date)}, asked by ${change.by}${change.undone ? " (undone since)" : ""}, commit ${change.sha.slice(0, 7)}\n\n${quoted.replace(/^/gm, "  ")}`;
    })
    .join("\n\n");
}
