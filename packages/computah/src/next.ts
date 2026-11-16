/**
 * For an app whose host can't run the runner (Vercel and the like): a route in the app that
 * passes the box's requests on to a runner somewhere else, saying who is signed in.
 *
 *   // app/api/computah/[...path]/route.ts
 *   export const { GET, POST } = createProxy({
 *     runner: process.env.COMPUTAH_RUNNER!,
 *     secret: process.env.COMPUTAH_SECRET!,
 *     identify: async (request) => { const user = await auth(request); return user && { id: user.id, name: user.email }; },
 *   });
 *
 * It only uses the standard Request and Response, so it works in any framework that has them.
 */
export interface ProxyOptions {
  /** The runner's address, for example https://runner.example.com. */
  runner: string;
  /** The same secret the runner's `gateway(secret)` identity was given. */
  secret: string;
  /** Who sent this request, from the app's own sign-in. Return null for someone who isn't signed in. */
  identify: (request: Request) => { id: string; name?: string } | null | Promise<{ id: string; name?: string } | null>;
  /** Where this route is mounted. Default "/api/computah". */
  basePath?: string;
}

type Handler = (request: Request) => Promise<Response>;

const json = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });

export function createProxy(options: ProxyOptions): { GET: Handler; POST: Handler } {
  const base = (options.basePath ?? "/api/computah").replace(/\/+$/, "");
  const handler: Handler = async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(base)) return json(404, "Not found.");
    if (request.method !== "GET") {
      // A change must come from the app's own pages, never from another site using a visitor's browser.
      if (request.headers.get("x-computah") !== "1") return json(403, "Missing x-computah header.");
      const origin = request.headers.get("origin");
      const hosts = [url.host, request.headers.get("x-forwarded-host"), request.headers.get("host")];
      if (origin && !hosts.includes(new URL(origin).host)) return json(403, "This page isn't allowed to do that.");
    }
    const person = await options.identify(request);
    const headers = new Headers({ authorization: `Bearer ${options.secret}` });
    for (const name of ["content-type", "x-computah"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (person) {
      headers.set("x-computah-user-id", encodeURIComponent(person.id));
      if (person.name) headers.set("x-computah-user-name", encodeURIComponent(person.name));
    }
    let upstream: Response;
    try {
      upstream = await fetch(`${options.runner.replace(/\/+$/, "")}/__computah${url.pathname.slice(base.length)}${url.search}`, {
        method: request.method,
        headers,
        body: request.method === "GET" ? undefined : await request.text(),
        cache: "no-store",
      });
    } catch {
      return json(502, "The runner isn't reachable.");
    }
    const passed = new Headers({ "cache-control": "no-store" });
    const type = upstream.headers.get("content-type");
    if (type) passed.set("content-type", type);
    return new Response(upstream.body, { status: upstream.status, headers: passed });
  };
  return { GET: handler, POST: handler };
}
