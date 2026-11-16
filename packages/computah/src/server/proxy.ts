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

function forwardHeaders(incoming: IncomingMessage): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value !== undefined && !HOP.has(name)) headers[name] = value;
  }
  return headers;
}

/** Pass an HTTP request to a copy of the app on this machine and stream the answer back. */
export function proxyRequest(incoming: IncomingMessage, outgoing: ServerResponse, port: number) {
  const upstream = request(
    { host: "127.0.0.1", port, method: incoming.method, path: incoming.url, headers: forwardHeaders(incoming) },
    (response) => {
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined && !HOP.has(name)) headers[name] = value;
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
export function proxyUpgrade(incoming: IncomingMessage, socket: Duplex, head: Buffer, port: number) {
  const upstream = connect(port, "127.0.0.1", () => {
    const lines = [`${incoming.method} ${incoming.url} HTTP/1.1`];
    for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
      lines.push(`${incoming.rawHeaders[index]}: ${incoming.rawHeaders[index + 1]}`);
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
