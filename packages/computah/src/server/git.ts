import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export class GitError extends Error {}

export function run(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; input?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) reject(new GitError(`${command} ${args[0] ?? ""}: ${(stderr || error.message).trim()}`));
        else resolve(stdout);
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string) => run("git", args, { cwd, env, input });

/** Diff flags that ignore the user's own diff settings (external tools, prefixes, colour), so the output is a plain patch. */
const PLAIN_DIFF = ["--no-ext-diff", "--no-color", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
}

/**
 * A tree object holding the working directory exactly as it is now: tracked and
 * untracked files, minus anything ignored. Nothing in the repo is touched; the
 * tree is built through a throwaway index.
 */
export async function snapshot(cwd: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "computah-index-"));
  const env = { GIT_INDEX_FILE: join(dir, "index") };
  try {
    const head = await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "");
    if (head.trim()) await git(cwd, ["read-tree", "HEAD"], env);
    await git(cwd, ["add", "-A", "."], env);
    return (await git(cwd, ["write-tree"], env)).trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Paths that differ between two snapshots. */
export async function changedFiles(cwd: string, before: string, after: string): Promise<string[]> {
  const out = await git(cwd, ["diff", "--no-ext-diff", "--name-only", "-z", before, after]);
  return out.split("\0").filter(Boolean);
}

/**
 * Put the files a job changed back the way they were. Fails without changing
 * anything if someone has edited the same lines since.
 */
export async function restore(cwd: string, before: string, after: string): Promise<void> {
  const patch = await git(cwd, ["diff", "--binary", "--full-index", ...PLAIN_DIFF, after, before]);
  if (!patch.trim()) return;
  try {
    await git(cwd, ["apply", "--check", "--whitespace=nowarn", "-"], undefined, patch);
  } catch {
    throw new GitError("These files have changed since, so the change can't be undone cleanly.");
  }
  await git(cwd, ["apply", "--whitespace=nowarn", "-"], undefined, patch);
}

/** Commit only `files`, leaving anything else in the working tree alone. */
export async function commitFiles(cwd: string, files: string[], message: string, author?: string): Promise<string> {
  await git(cwd, ["add", "-A", "--", ...files]);
  await git(
    cwd,
    [
      "commit",
      "--no-gpg-sign",
      ...(author ? ["--author", `${author.replace(/[<>\n]/g, "")} <computah@localhost>`] : []),
      "-m",
      message,
      "--only",
      "--",
      ...files,
    ],
    COMMITTER,
  );
  return (await git(cwd, ["rev-parse", "HEAD"])).trim();
}

/** Used only when the machine has no git identity configured, as on a fresh server. */
const COMMITTER = {
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "computah",
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "computah@localhost",
};

export async function revertCommit(cwd: string, commit: string): Promise<string> {
  try {
    await git(cwd, ["revert", "--no-edit", "--no-gpg-sign", commit], {
      ...COMMITTER,
      GIT_AUTHOR_NAME: "computah",
      GIT_AUTHOR_EMAIL: "computah@localhost",
    });
  } catch (error) {
    await git(cwd, ["revert", "--abort"]).catch(() => "");
    throw new GitError(
      error instanceof Error && /conflict/i.test(error.message)
        ? "Later changes touch the same lines, so the change can't be undone cleanly."
        : "The change couldn't be undone.",
    );
  }
  return (await git(cwd, ["rev-parse", "HEAD"])).trim();
}

/** Keep computah's own files out of `git status` without editing the project's .gitignore. */
export async function excludeLocally(cwd: string, pattern: string): Promise<void> {
  const { readFile, writeFile, mkdir } = await import("node:fs/promises");
  const path = (await git(cwd, ["rev-parse", "--git-path", "info/exclude"])).trim();
  const full = resolve(cwd, path);
  const current = await readFile(full, "utf8").catch(() => "");
  if (current.split("\n").includes(pattern)) return;
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`);
}
