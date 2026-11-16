import { createHmac, timingSafeEqual } from "node:crypto";
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
 * Take the person from the app's own server, which forwards the box's requests to the runner
 * with a shared secret and says who is signed in. Use with `createProxy` from "@tetraslam13/computah/next".
 */
export function gateway(secret: string): Identity {
  const wanted = Buffer.from(`Bearer ${secret}`);
  return (request) => {
    const given = Buffer.from(request.headers.authorization ?? "");
    if (!secret || given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
    const id = request.headers["x-computah-user-id"];
    if (typeof id !== "string" || !id.trim()) return null;
    const name = request.headers["x-computah-user-name"];
    return {
      id: decodeURIComponent(id.trim()),
      name: typeof name === "string" && name.trim() ? decodeURIComponent(name.trim()) : undefined,
    };
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
  /** What members may change, in a sentence for them. Shown in their box. */
  memberNote?: string;
  /** Rules for a member's change beyond `memberPaths`, for the agent. Defaults to `memberNote`. */
  memberRules?: string;
  /**
   * Look at a member's change and object to it: given each changed file's new contents, return why
   * it isn't acceptable, or null. See `clientOnly()` for a ready-made one.
   */
  memberCheck?: (files: { path: string; content: string | null }[]) => string | null;
  /** Requests a member may send per day. Default 20. */
  memberDailyLimit?: number;
  /** Requests all members together may send per day. Default: no limit. */
  dailyLimit?: number;
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

/**
 * A `memberCheck` for pieces of a page that run only in the visitor's own browser: every changed
 * file must be a client component ("use client" first), must not declare server code, and may
 * import only the listed packages. Pair it with a wrapper that loads the pieces without server
 * rendering, so a member's code never runs on your server.
 */
export function clientOnly(options: { imports?: string[] } = {}): NonNullable<Trust["memberCheck"]> {
  const allowed = options.imports ?? ["react"];
  return (files) => {
    for (const { path, content } of files) {
      if (content === null) return `${path} can't be deleted.`;
      const code = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (!/^\s*["']use client["'];?/.test(code)) return `${path} has to start with "use client".`;
      if (/["']use server["']/.test(code)) return `${path} can't contain server code.`;
      const sources = [
        ...code.matchAll(/\bfrom\s*["']([^"']+)["']/g),
        ...code.matchAll(/\bimport\s*["']([^"']+)["']/g),
        ...code.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']/g),
      ].map((match) => match[1] as string);
      const stray = sources.find((source) => !allowed.includes(source));
      if (stray) return `${path} can only import ${allowed.join(", ")}, not "${stray}".`;
      if (/\b(?:import|require)\s*\(\s*[^"'\s)]/.test(code)) return `${path} can't load code by a computed name.`;
    }
    return null;
  };
}

/** Sign-in for people who haven't signed in: a random name kept in a signed cookie. */
export const GUEST_COOKIE = "computah_guest";

export function guestToken(secret: string, id: string): string {
  return `${id}.${createHmac("sha256", secret).update(id).digest("hex").slice(0, 32)}`;
}

/** The guest a request's cookie names, if its signature is ours. */
export function guestFrom(request: IncomingMessage, secret: string): Person | null {
  const value = new RegExp(`(?:^|;\\s*)${GUEST_COOKIE}=([a-z0-9]+\\.[a-f0-9]+)`).exec(request.headers.cookie ?? "")?.[1];
  if (!value) return null;
  const [id] = value.split(".");
  if (!id) return null;
  const wanted = Buffer.from(guestToken(secret, id));
  const given = Buffer.from(value);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
  return { id: `guest:${id}`, name: "guest" };
}
