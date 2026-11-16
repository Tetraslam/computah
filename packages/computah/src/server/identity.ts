import type { IncomingMessage } from "node:http";

/** Who is asking. `id` must be stable and unforgeable by the visitor. */
export interface Person {
  id: string;
  /** Shown in the box and in commit messages. */
  name?: string;
}

/** Works out who sent a request, or null for someone not signed in. */
export type Identity = (request: IncomingMessage) => Person | null | Promise<Person | null>;

const isLoopback = (address: string | undefined) =>
  !!address && (address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127."));

/** Everyone on this machine is one person, "you". For development. */
export function local(): Identity {
  return (request) => (isLoopback(request.socket.remoteAddress) ? { id: "local", name: "you" } : null);
}

/**
 * exe.dev's login: its proxy sets these headers on every signed-in request and
 * strips them from anything a visitor sends. Only trust this behind that proxy.
 */
export function exe(): Identity {
  return header("x-exedev-userid", "x-exedev-email");
}

/**
 * Take the person from request headers set by a proxy you control. The proxy
 * must remove these headers from incoming requests, or anyone can claim to be anyone.
 */
export function header(idHeader: string, nameHeader?: string): Identity {
  return (request) => {
    const id = request.headers[idHeader.toLowerCase()];
    if (typeof id !== "string" || !id.trim()) return null;
    const name = nameHeader ? request.headers[nameHeader.toLowerCase()] : undefined;
    return { id: id.trim(), name: typeof name === "string" && name.trim() ? name.trim() : undefined };
  };
}

/**
 * What a person may do:
 * - owner: change the app for everyone, and promote or discard other people's changes.
 * - trusted: change the app for everyone.
 * - member: change their own version only. The owner can promote it.
 * - visitor: use the app, but not the box.
 */
export type Level = "owner" | "trusted" | "member" | "visitor";

export interface Trust {
  /** Ids or names (such as emails) of the owners. */
  owners: string[];
  trusted?: string[];
  /** Who gets a personal version: a list, or "everyone" who is signed in. Default: nobody. */
  members?: string[] | "everyone";
  /** Files a member's change may touch, as globs relative to the repo root. Default: anything. */
  memberPaths?: string[];
  /** Requests a member may send per day. Default 20. */
  memberDailyLimit?: number;
}

export function levelOf(person: Person | null, trust: Trust): Level {
  if (!person) return "visitor";
  const names = [person.id, person.name].filter((value): value is string => !!value).map((value) => value.toLowerCase());
  const listed = (list: string[] | undefined) => !!list?.some((entry) => names.includes(entry.toLowerCase()));
  if (listed(trust.owners)) return "owner";
  if (listed(trust.trusted)) return "trusted";
  if (trust.members === "everyone" || listed(trust.members === undefined ? [] : trust.members)) return "member";
  return "visitor";
}

/** Turn a glob into a matcher. `*` stays within a path segment, `**` crosses them. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index] as string;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        source += ".*";
        index++;
        if (glob[index + 1] === "/") index++;
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** The files in `files` that fall outside every allowed glob. */
export function outsidePaths(files: string[], allowed: string[] | undefined): string[] {
  if (!allowed?.length) return [];
  const matchers = allowed.map(globToRegExp);
  return files.filter((file) => !matchers.some((matcher) => matcher.test(file)));
}

/** A short, filesystem- and branch-safe name for a person. */
export function slugFor(person: Person): string {
  const readable = (person.name ?? person.id)
    .toLowerCase()
    .replace(/@.*$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  let hash = 2166136261;
  for (const char of person.id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `${readable || "person"}-${(hash >>> 0).toString(36)}`;
}
