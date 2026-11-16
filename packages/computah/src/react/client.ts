import type { Job, JobContext, JobEvent } from "../server/types.js";

export type { Job, JobContext, JobEvent };

export interface ClientOptions {
  /** Where the runner is. Default http://127.0.0.1:4821. */
  endpoint?: string;
  /** Sent as a bearer token, for a runner started with a secret. */
  secret?: string;
}

export class RunnerError extends Error {
  constructor(
    message: string,
    /** True when the runner couldn't be reached at all. */
    readonly offline = false,
  ) {
    super(message);
  }
}

export const DEFAULT_ENDPOINT = "http://127.0.0.1:4821";
/** Where the runner answers when it is serving the app itself. */
export const SERVED_ENDPOINT = "/__computah";

/** What the runner says about itself and the person asking. A development runner only sends `agent`. */
export interface Info {
  agent: string;
  level?: "owner" | "trusted" | "member" | "visitor";
  version?: "main" | "mine";
  hasOwn?: boolean;
  live?: boolean;
  stale?: boolean;
  proposals?: { id: string; name: string; changes: string[] }[];
  mode?: "swap" | "push";
  canJoin?: boolean;
  note?: string;
  ownUrl?: string;
}

/** Find the runner: the app's own address if the runner is serving it, otherwise this machine. */
export async function findEndpoint(): Promise<string> {
  try {
    const response = await fetch(`${SERVED_ENDPOINT}/me`, { cache: "no-store" });
    if (response.ok && ((await response.json()) as { name?: string }).name === "computah") return SERVED_ENDPOINT;
  } catch {
    // Not served by a runner.
  }
  return DEFAULT_ENDPOINT;
}

/** A thin client for the runner's HTTP API. */
export function createClient(options: ClientOptions = {}) {
  const base = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const auth: Record<string, string> = options.secret ? { authorization: `Bearer ${options.secret}` } : {};

  async function call<T>(path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers:
          body === undefined
            ? auth
            : {
                ...auth,
                "content-type": "application/json",
                "x-computah": "1",
              },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      });
    } catch {
      throw new RunnerError("The runner isn't running.", true);
    }
    const data = (await response.json().catch(() => ({}))) as {
      error?: string;
    } & T;
    if (!response.ok) throw new RunnerError(data.error ?? `The runner answered ${response.status}.`);
    return data;
  }

  return {
    info: () => call<Info>("/"),
    hello: () => call<{ ok: boolean; guest: boolean }>("/hello", {}),
    view: (version: "main" | "mine") => call<{ ok: boolean }>("/view", { version }),
    promote: (id: string) => call<{ ok: boolean }>(`/versions/${id}/promote`, {}),
    discard: (id: string) => call<{ ok: boolean }>(`/versions/${id}/discard`, {}),
    list: async () => (await call<{ jobs: Job[] }>("/jobs")).jobs,
    get: async (id: string) => (await call<{ job: Job }>(`/jobs/${id}`)).job,
    submit: async (text: string, context: JobContext, scope?: "everyone" | "me") =>
      (await call<{ job: Job }>("/jobs", { text, context, for: scope })).job,
    cancel: async (id: string) => (await call<{ job: Job }>(`/jobs/${id}/cancel`, {})).job,
    undo: async (id: string) => (await call<{ job: Job }>(`/jobs/${id}/undo`, {})).job,

    /**
     * Follow a job's events until it ends or `signal` aborts. Resolves when the
     * stream closes; rejects if the runner can't be reached.
     */
    async follow(id: string, onEvent: (event: JobEvent) => void, signal?: AbortSignal): Promise<void> {
      let response: Response;
      try {
        response = await fetch(`${base}/jobs/${id}/events`, {
          headers: auth,
          signal,
          cache: "no-store",
        });
      } catch {
        if (signal?.aborted) return;
        throw new RunnerError("The runner isn't running.", true);
      }
      if (!response.ok || !response.body) throw new RunnerError(`The runner answered ${response.status}.`);
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += value;
          let end = buffer.indexOf("\n\n");
          while (end !== -1) {
            const chunk = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            for (const event of parseChunk(chunk)) onEvent(event);
            end = buffer.indexOf("\n\n");
          }
        }
      } catch {
        if (!signal?.aborted) throw new RunnerError("Lost the connection to the runner.", true);
      }
    },
  };
}

/** The events in one server-sent-events block. Comments and malformed data are skipped. */
export function parseChunk(chunk: string): JobEvent[] {
  const events: JobEvent[] = [];
  for (const line of chunk.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      events.push(JSON.parse(line.slice(6)) as JobEvent);
    } catch {
      // Skip a line we can't read.
    }
  }
  return events;
}

/** A short CSS path to an element, for telling the agent what the user pointed at. */
export function selectorFor(element: Element): string {
  const parts: string[] = [];
  let node: Element | null = element;
  while (node && node !== document.documentElement && parts.length < 6) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      parts.unshift(`${part}#${node.id}`);
      break;
    }
    const names = [...node.classList].filter((name) => !name.startsWith("computah")).slice(0, 2);
    if (names.length) part += `.${names.join(".")}`;
    const parent: Element | null = node.parentElement;
    if (parent) {
      const same = [...parent.children].filter((child) => child.tagName === node?.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(" > ");
}

/** In development React keeps the component that rendered an element; read its name if it's there. */
export function componentFor(element: Element): string | undefined {
  const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"));
  let fiber = key ? (element as unknown as Record<string, { type?: unknown; return?: unknown } | undefined>)[key] : undefined;
  const names: string[] = [];
  for (let depth = 0; fiber && depth < 40 && names.length < 3; depth++) {
    const type = fiber.type as { displayName?: string; name?: string } | string | undefined;
    const name = typeof type === "function" || (type && typeof type === "object") ? (type.displayName ?? type.name) : undefined;
    if (name && /^[A-Z]/.test(name) && !names.includes(name)) names.push(name);
    fiber = fiber.return as typeof fiber;
  }
  return names.length ? names.join(" in ") : undefined;
}

export function describeElement(element: Element): NonNullable<JobContext["element"]> {
  const clone = element.cloneNode(true) as Element;
  for (const child of [...clone.querySelectorAll("script, style, svg")]) child.remove();
  return {
    selector: selectorFor(element),
    text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || undefined,
    html: clone.outerHTML.replace(/\s+/g, " ").slice(0, 1500),
    component: componentFor(element),
  };
}

export function pageContext(element?: Element | null): JobContext {
  const selection = window.getSelection()?.toString().trim();
  return {
    url: window.location.href,
    title: document.title || undefined,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    selection: selection ? selection.slice(0, 1500) : undefined,
    element: element ? describeElement(element) : undefined,
  };
}

/** A few words for what the agent is doing right now, from its latest tool call. */
export function activityLabel(event: JobEvent | undefined): string {
  if (!event) return "starting";
  if (event.type === "state") return event.state === "queued" ? "waiting its turn" : "reading the code";
  if (event.type === "text") return "thinking";
  if (event.type === "error") return "hit a problem";
  if (event.type === "release") return event.state === "building" ? "building it" : event.state === "live" ? "live" : "didn't build";
  const name = event.name.toLowerCase();
  const file = event.detail?.split("/").pop();
  if (/edit|write|patch|create/.test(name)) return file ? `editing ${file}` : "editing";
  if (/read|view|cat/.test(name)) return file ? `reading ${file}` : "reading";
  if (/grep|glob|search|find|list/.test(name)) return "searching the code";
  if (/bash|shell|exec|command/.test(name)) {
    const command = event.detail ?? "";
    if (/\b(tsc|typecheck|lint|biome|eslint)\b/.test(command)) return "checking its work";
    if (/\b(test|vitest|jest|pytest)\b/.test(command)) return "running tests";
    if (/\b(rg|grep|find|ls|cat|sed -n|head|tail)\b/.test(command)) return "reading the code";
    return "running a command";
  }
  if (/fetch|web/.test(name)) return "looking something up";
  return "working";
}
