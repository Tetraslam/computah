import { AppError } from "./app.js";

/** A place that builds and serves the app when a branch is pushed to it. */
export interface Host {
  name: string;
  /**
   * Wait until the host has finished with `sha` on `branch`. Resolve with where that build is
   * served, if the host says. Throw an AppError carrying the build's output if it failed.
   */
  deployed(input: { sha: string; branch: string; production: boolean }): Promise<{ url?: string }>;
}

export interface VercelOptions {
  /** A Vercel access token. Default: the VERCEL_TOKEN environment variable. */
  token?: string;
  /** The project's ID or name. */
  projectId: string;
  /** Needed when the project belongs to a team. */
  teamId?: string;
  /** How long to wait for a build. Default 10 minutes. */
  timeoutMs?: number;
  /** How long to wait for Vercel to notice the push at all. Default 90 seconds. */
  startTimeoutMs?: number;
  /** How often to ask. Default 3 seconds. */
  pollMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
}

interface Deployment {
  uid: string;
  url?: string | null;
  state?: string;
  readyState?: string;
}

/** Vercel, connected to the repository through its git integration: a push makes a deployment. */
export function vercel(options: VercelOptions): Host {
  const call = options.fetch ?? fetch;
  const api = async (path: string, query: Record<string, string>): Promise<unknown> => {
    const token = options.token ?? process.env.VERCEL_TOKEN;
    if (!token) throw new AppError("No Vercel token. Set VERCEL_TOKEN on the runner.");
    const url = new URL(`https://api.vercel.com${path}`);
    for (const [key, value] of Object.entries({ ...query, ...(options.teamId ? { teamId: options.teamId } : {}) }))
      url.searchParams.set(key, value);
    const response = await call(url, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new AppError(`Vercel answered ${response.status}.`);
    return response.json();
  };

  return {
    name: "vercel",
    async deployed({ sha }) {
      const started = Date.now();
      const pause = () => new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 3000));
      for (;;) {
        const listed = (await api("/v7/deployments", { projectId: options.projectId, sha, limit: "1" })) as
          | { deployments?: Deployment[] }
          | Deployment[];
        const deployment = (Array.isArray(listed) ? listed : (listed.deployments ?? []))[0];
        const state = deployment?.readyState ?? deployment?.state;
        if (deployment && state === "READY") return { url: deployment.url ? `https://${deployment.url}` : undefined };
        if (deployment && (state === "ERROR" || state === "CANCELED")) {
          throw new AppError(`The Vercel build ${state === "ERROR" ? "failed" : "was cancelled"}.\n${await buildLog(deployment.uid)}`);
        }
        const waited = Date.now() - started;
        if (!deployment && waited > (options.startTimeoutMs ?? 90_000)) {
          throw new AppError("Vercel never started a build for this push. Is the repository connected to the project?");
        }
        if (waited > (options.timeoutMs ?? 10 * 60_000)) throw new AppError("The Vercel build took too long.");
        await pause();
      }
    },
  };

  async function buildLog(id: string): Promise<string> {
    try {
      const events = (await api(`/v3/deployments/${id}/events`, { builds: "1", limit: "1000" })) as {
        payload?: { text?: string };
        text?: string;
      }[];
      const lines = (Array.isArray(events) ? events : []).map((event) => event.payload?.text ?? event.text ?? "").filter(Boolean);
      return lines.slice(-60).join("\n");
    } catch {
      return "(the build log couldn't be fetched)";
    }
  }
}
