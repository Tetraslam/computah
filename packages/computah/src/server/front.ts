import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { cleanContext } from "./http.js";
import type { Person } from "./identity.js";
import { RequestError } from "./jobs.js";
import { proxyRequest, proxyUpgrade } from "./proxy.js";
import type { Site } from "./site.js";
import type { JobEvent } from "./types.js";

/** Everything the runner serves itself lives under this path; the rest goes to the app. */
export const PREFIX = "/__computah";
const VIEW_COOKIE = "computah_view";
const COPY_COOKIE = "computah_copy";

const cookie = (request: IncomingMessage, name: string) => new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(request.headers.cookie ?? "")?.[1];

/** A request for a page itself, as opposed to something a page already open is fetching. */
export function isNavigation(request: IncomingMessage): boolean {
  if (request.method !== "GET") return false;
  const mode = request.headers["sec-fetch-mode"];
  if (typeof mode === "string") return mode === "navigate";
  return (request.headers.accept ?? "").includes("text/html");
}

/**
 * Pick the copy of the app for a request. A page load gets the person's current copy and is
 * told its name in a cookie; everything that page then fetches goes to that same copy, so a
 * page never mixes files from two builds while a change is being swapped in.
 */
async function route(
  site: Site,
  person: Person | null,
  request: IncomingMessage,
): Promise<{ port: number; local: boolean; setCookie?: string }> {
  if (!isNavigation(request)) {
    const pinned = site.copy(cookie(request, COPY_COOKIE));
    if (pinned) return { port: pinned.port, local: pinned.live };
  }
  const target = await site.target(person, wantsMain(request));
  return {
    port: target.port,
    local: target.live,
    setCookie: isNavigation(request) ? `${COPY_COOKIE}=${target.copy}; Path=/; SameSite=Lax; HttpOnly` : undefined,
  };
}

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

const wantsMain = (request: IncomingMessage) => new RegExp(`(?:^|;\\s*)${VIEW_COOKIE}=main(?:;|$)`).test(request.headers.cookie ?? "");

/**
 * A change request must come from the app's own pages: same origin, with a
 * custom header and a JSON body. That stops another site from using a signed-in
 * visitor's browser to send one.
 */
export function refuseWrite(request: IncomingMessage): string | null {
  if (request.headers["x-computah"] !== "1") return "Missing x-computah header.";
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) return "Send JSON.";
  const origin = request.headers.origin;
  if (origin) {
    const forwarded = request.headers["x-forwarded-host"];
    const hosts = [request.headers.host, typeof forwarded === "string" ? forwarded : undefined].filter(Boolean);
    try {
      if (!hosts.includes(new URL(origin).host)) return "This page isn't allowed to do that.";
    } catch {
      return "This page isn't allowed to do that.";
    }
  }
  return null;
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
    // Falls through.
  }
  throw new RequestError("Send a JSON object.");
}

/** The server visitors connect to: it answers the box's API and passes everything else to the right copy of the app. */
export function createFrontServer(site: Site): Server {
  const server = createServer(async (request, response) => {
    let person: Person | null = null;
    try {
      person = await site.identify(request);
      const path = new URL(request.url ?? "/", "http://front").pathname;
      if (path === PREFIX || path.startsWith(`${PREFIX}/`)) return await api(site, person, path.slice(PREFIX.length), request, response);
      if (site.pushes) return send(response, 404, { error: "Not found." });
      const { port, local, setCookie } = await route(site, person, request);
      proxyRequest(request, response, port, { setCookie, local });
    } catch (error) {
      if (response.headersSent) return void response.end();
      if (error instanceof RequestError) return send(response, error.status, { error: error.message });
      send(response, 500, { error: "The runner hit an error." });
    }
  });
  server.on("upgrade", async (request, socket, head) => {
    try {
      const person = await site.identify(request);
      const { port, local } = await route(site, person, request);
      proxyUpgrade(request, socket, head, port, local);
    } catch {
      socket.destroy();
    }
  });
  return server;
}

async function api(site: Site, person: Person | null, path: string, request: IncomingMessage, response: ServerResponse) {
  const method = request.method ?? "GET";
  const [, first, id, action] = path.replace(/\/+$/, "").split("/");
  if (method !== "GET") {
    const reason = refuseWrite(request);
    if (reason) return send(response, 403, { error: reason });
  }

  if (method === "GET" && (first === undefined || first === "me")) {
    return send(response, 200, { name: "computah", ...(await site.me(person, wantsMain(request))) });
  }
  if (first === "pieces" && method === "GET") {
    if (!id) return send(response, 200, { pieces: await site.pieces(person, wantsMain(request)) });
    const script = site.piece(id.replace(/\.js$/, ""));
    if (script === undefined) return send(response, 404, { error: "Not found." });
    // A piece is named after its contents, so it never changes and can be kept forever.
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" });
    return void response.end(script);
  }
  if (first === "warm" && method === "POST") {
    site.warm(person);
    return send(response, 200, { ok: true });
  }
  if (first === "hello" && method === "POST") {
    // Someone not signed in asks to take part: they become a guest, if this app has guests.
    const cookie = person ? null : site.welcome();
    return send(response, cookie ? 201 : 200, { ok: true, guest: !!cookie }, cookie ? { "set-cookie": cookie } : {});
  }
  if (first === "view" && method === "POST") {
    const body = await readJson(request);
    const main = body.version === "main";
    return send(
      response,
      200,
      { ok: true },
      { "set-cookie": `${VIEW_COOKIE}=${main ? "main" : ""}; Path=/; SameSite=Lax${main ? "" : "; Max-Age=0"}` },
    );
  }
  if (first === "versions" && method === "POST" && id) {
    if (action === "promote") await site.promote(person, id);
    else if (action === "discard") await site.discard(person, id);
    else return send(response, 404, { error: "Not found." });
    return send(response, 200, { ok: true });
  }
  if (first !== "jobs") return send(response, 404, { error: "Not found." });

  if (method === "GET" && !id) return send(response, 200, { jobs: site.jobs(person) });
  if (method === "POST" && !id) {
    const body = await readJson(request);
    const job = await site.submit(
      person,
      typeof body.text === "string" ? body.text : "",
      cleanContext(body.context),
      body.for === "me" ? "me" : "everyone",
    );
    return send(response, 201, { job });
  }
  if (!id) return send(response, 405, { error: "Method not allowed." });
  if (method === "GET" && !action) return send(response, 200, { job: site.find(person, id).job });
  if (method === "GET" && action === "events") return stream(site, person, id, request, response);
  if (method === "POST" && action === "cancel") return send(response, 200, { job: await site.cancel(person, id) });
  if (method === "POST" && action === "undo") return send(response, 200, { job: await site.undo(person, id) });
  return send(response, 404, { error: "Not found." });
}

async function stream(site: Site, person: Person | null, id: string, request: IncomingMessage, response: ServerResponse) {
  const lane = site.lane(person, id);
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
  const ended = () => ["done", "failed", "cancelled", "undone"].includes(lane.get(id)?.state ?? "failed");
  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
    response.end();
  };
  const unsubscribe = lane.subscribe(id, (event) => {
    write(event);
    if (event.type === "state" && ended()) close();
  });
  const heartbeat = setInterval(() => response.write(": ping\n\n"), 20_000);
  request.on("close", close);
  for (const event of await lane.history(id)) write(event);
  if (ended()) close();
}
