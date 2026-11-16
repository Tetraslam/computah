import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type Computah, RequestError } from "./jobs.js";
import type { JobContext, JobEvent } from "./types.js";

export interface ServeOptions {
  /** Default 4821. */
  port?: number;
  /** Default 127.0.0.1. Anything else requires `secret`. */
  host?: string;
  /** Required on every request as `Authorization: Bearer <secret>` when set. */
  secret?: string;
  /** Extra page origins allowed to call the runner, beyond pages served from this machine. */
  origins?: string[];
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackHost(hostname: string): boolean {
  const name = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(name) || name.endsWith(".localhost");
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function hostnameOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
}

export interface RequestFacts {
  method: string;
  remoteAddress: string | undefined;
  host: string | undefined;
  origin: string | undefined;
  authorization: string | undefined;
  marker: string | undefined;
  contentType: string | undefined;
}

/**
 * Decide whether a request may reach the runner. Returns a reason to refuse, or null.
 *
 * The runner turns text into code changes, so this is the whole security boundary:
 * - without a secret, only this machine may connect, and the Host header must name
 *   this machine (which stops DNS rebinding);
 * - a browser request must come from a page served by this machine or a listed origin
 *   (which stops other websites from using the visitor's browser to reach the runner);
 * - anything that changes state must carry a custom header and a JSON body, so it
 *   can't be sent by a plain form or image tag.
 */
export function refuse(facts: RequestFacts, options: ServeOptions): string | null {
  if (options.secret) {
    const given = Buffer.from(facts.authorization?.replace(/^Bearer\s+/i, "") ?? "");
    const wanted = Buffer.from(options.secret);
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return "Wrong or missing secret.";
  } else {
    if (!isLoopbackAddress(facts.remoteAddress)) return "Only this machine may use the runner unless a secret is set.";
    const host = hostnameOf(facts.host);
    if (!host || !isLoopbackHost(host)) return "Unexpected Host header.";
  }
  if (facts.origin) {
    const origin = hostnameOf(facts.origin);
    const listed = options.origins?.includes(facts.origin) ?? false;
    if (!listed && !(origin && isLoopbackHost(origin))) return "This page isn't allowed to use the runner.";
  }
  if (facts.method !== "GET" && facts.method !== "OPTIONS") {
    if (facts.marker !== "1") return "Missing x-computah header.";
    if (!facts.contentType?.toLowerCase().startsWith("application/json")) return "Send JSON.";
  }
  return null;
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage, limit = 256 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new RequestError("That request is too large.", 413);
    chunks.push(chunk as Buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Falls through to the error below.
  }
  throw new RequestError("Send a JSON object.");
}

/** Keep only the context fields we know, with bounded sizes. */
export function cleanContext(raw: unknown): JobContext {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (value: unknown, limit: number) => (typeof value === "string" && value ? value.slice(0, limit) : undefined);
  const context: JobContext = {
    url: text(input.url, 2000),
    title: text(input.title, 300),
    selection: text(input.selection, 2000),
  };
  const viewport = input.viewport as { width?: unknown; height?: unknown } | undefined;
  if (viewport && Number.isFinite(viewport.width) && Number.isFinite(viewport.height)) {
    context.viewport = {
      width: Math.round(Number(viewport.width)),
      height: Math.round(Number(viewport.height)),
    };
  }
  const element = input.element as Record<string, unknown> | undefined;
  const selector = text(element?.selector, 500);
  if (element && selector) {
    context.element = {
      selector,
      text: text(element.text, 500),
      html: text(element.html, 2000),
      component: text(element.component, 300),
    };
  }
  return context;
}

/** The runner's HTTP server. Call `.listen()` on the result, or use `serve`. */
export function createRunnerServer(computah: Computah, options: ServeOptions = {}): Server {
  return createServer(async (request, response) => {
    const origin = request.headers.origin;
    const reason = refuse(
      {
        method: request.method ?? "GET",
        remoteAddress: request.socket.remoteAddress,
        host: request.headers.host,
        origin,
        authorization: request.headers.authorization,
        marker: request.headers["x-computah"] as string | undefined,
        contentType: request.headers["content-type"],
      },
      options,
    );
    // Only an allowed page ever gets CORS headers, so a refused page can't read anything.
    if (origin && !reason) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "origin");
      response.setHeader("access-control-allow-headers", "content-type, x-computah, authorization");
      response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      response.setHeader("access-control-max-age", "600");
    }
    if (reason) return send(response, 403, { error: reason });
    if (request.method === "OPTIONS") return void response.writeHead(204).end();

    const path = new URL(request.url ?? "/", "http://runner").pathname.replace(/\/+$/, "") || "/";
    const [, first, id, action] = path.split("/");
    try {
      await computah.init();
      if (request.method === "GET" && path === "/") {
        return send(response, 200, {
          name: "computah",
          agent: computah.agentName,
          repo: computah.repo.split("/").pop(),
        });
      }
      if (first !== "jobs") return send(response, 404, { error: "Not found." });
      if (request.method === "GET" && !id) return send(response, 200, { jobs: computah.list() });
      if (request.method === "POST" && !id) {
        const body = await readJson(request);
        const job = await computah.submit(typeof body.text === "string" ? body.text : "", cleanContext(body.context));
        return send(response, 201, { job });
      }
      if (!id) return send(response, 405, { error: "Method not allowed." });
      if (request.method === "GET" && !action) {
        const job = computah.get(id);
        return job ? send(response, 200, { job }) : send(response, 404, { error: "No such request." });
      }
      if (request.method === "GET" && action === "events") return await stream(computah, id, request, response);
      if (request.method === "POST" && action === "cancel") return send(response, 200, { job: await computah.cancel(id) });
      if (request.method === "POST" && action === "undo") return send(response, 200, { job: await computah.undo(id) });
      return send(response, 404, { error: "Not found." });
    } catch (error) {
      if (error instanceof RequestError) return send(response, error.status, { error: error.message });
      return send(response, 500, { error: "The runner hit an error." });
    }
  });
}

/** Send a job's events as server-sent events: everything so far, then live until it ends. */
async function stream(computah: Computah, id: string, request: IncomingMessage, response: ServerResponse) {
  const job = computah.get(id);
  if (!job) return send(response, 404, { error: "No such request." });
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  let sent = 0;
  const write = (event: JobEvent) => {
    if (event.seq < sent) return;
    sent = event.seq + 1;
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const ended = () => ["done", "failed", "cancelled", "undone"].includes(computah.get(id)?.state ?? "failed");
  const unsubscribe = computah.subscribe(id, (event) => {
    write(event);
    if (event.type === "state" && ended()) close();
  });
  const heartbeat = setInterval(() => response.write(": ping\n\n"), 20_000);
  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
    response.end();
  };
  request.on("close", close);
  for (const event of await computah.history(id)) write(event);
  if (ended()) close();
}

export function serve(computah: Computah, options: ServeOptions = {}): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host) && !options.secret) {
    return Promise.reject(new Error("Refusing to listen beyond this machine without a secret. Set one, or keep the default host."));
  }
  const server = createRunnerServer(computah, options);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4821, host, () => resolve(server));
  });
}
