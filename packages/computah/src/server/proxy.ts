import { type IncomingMessage, request, type ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";

/** Headers that describe one hop and must not be passed along. */
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * A development server only answers requests that look like they come from its own address
 * (Next and Vite both check). For a live copy, present the request that way: the original host
 * moves to x-forwarded-host, and Host, Origin and Referer name the copy itself.
 */
export function asLocal(name: string, value: string, port: number, publicHost: string | undefined): string {
  const local = `localhost:${port}`;
  if (name === "host") return local;
  if ((name === "origin" || name === "referer") && publicHost) {
    try {
      const url = new URL(value);
      if (url.host === publicHost) return `http://${local}${name === "referer" ? url.pathname + url.search : ""}`;
    } catch {
      // Leave a value we can't parse alone.
    }
  }
  return value;
}

function forwardHeaders(incoming: IncomingMessage, port: number, local: boolean): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  const publicHost = incoming.headers.host;
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined || HOP.has(name)) continue;
    headers[name] = local && typeof value === "string" ? asLocal(name, value, port, publicHost) : value;
  }
  if (local && publicHost && !headers["x-forwarded-host"]) headers["x-forwarded-host"] = publicHost;
  return headers;
}

/** Pass an HTTP request to a copy of the app on this machine and stream the answer back. */
export function proxyRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  port: number,
  options: { setCookie?: string; local?: boolean } = {},
) {
  const { setCookie } = options;
  const upstream = request(
    { host: "127.0.0.1", port, method: incoming.method, path: incoming.url, headers: forwardHeaders(incoming, port, !!options.local) },
    (response) => {
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined && !HOP.has(name)) headers[name] = value;
      }
      if (setCookie) {
        const existing = headers["set-cookie"];
        headers["set-cookie"] = [...(Array.isArray(existing) ? existing : existing ? [existing] : []), setCookie];
      }
      outgoing.writeHead(response.statusCode ?? 502, headers);
      response.pipe(outgoing);
    },
  );
  upstream.on("error", () => {
    if (!outgoing.headersSent) outgoing.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    outgoing.end("The app isn't answering right now.");
  });
  incoming.pipe(upstream);
}

/** Pass a connection upgrade (a websocket, as hot reload uses) straight through. */
export function proxyUpgrade(incoming: IncomingMessage, socket: Duplex, head: Buffer, port: number, local = false) {
  const upstream = connect(port, "127.0.0.1", () => {
    const lines = [`${incoming.method} ${incoming.url} HTTP/1.1`];
    for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
      const name = incoming.rawHeaders[index] as string;
      const value = incoming.rawHeaders[index + 1] as string;
      lines.push(`${name}: ${local ? asLocal(name.toLowerCase(), value, port, incoming.headers.host) : value}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  const close = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", close);
  socket.on("error", close);
}
