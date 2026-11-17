import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  activityLabel,
  type ClientOptions,
  createClient,
  findEndpoint,
  type Info,
  type Job,
  type JobEvent,
  pageContext,
  RunnerError,
  SERVED_ENDPOINT,
} from "./client.js";
import { refreshPieces } from "./Piece.js";

export type Connection = "connecting" | "ready" | "offline" | "refused";

export interface BoxJob extends Job {
  /** What the agent is doing right now, while the job is live. */
  activity?: string;
  /** Every step so far, newest last. */
  steps: JobEvent[];
}

const isLive = (job: Job) => job.state === "queued" || job.state === "working";
const RETRY_MS = 3000;

/** Everything the box knows: the runner's state, the requests, and the actions on them. */
export interface BoxOptions extends ClientOptions {
  /** Whether your box is open. Until it is, the hook doesn't talk to a development runner. */
  active: boolean;
  /**
   * When the runner serves the app, a finished change is a new build of the page, so the hook
   * reloads the page to show it. Return true from this to hold a reload for now (say, while the
   * person is typing). `ready` then turns true, and `reload()` does it when you're ready.
   */
  holdReloads?: () => boolean;
}

export function useBox(options: BoxOptions) {
  const { secret, active } = options;
  const hold = useRef(options.holdReloads);
  hold.current = options.holdReloads;
  // Without an explicit endpoint, look for a runner serving this app before falling back to this machine.
  const [endpoint, setEndpoint] = useState(options.endpoint);
  useEffect(() => {
    if (options.endpoint) return setEndpoint(options.endpoint);
    let cancelled = false;
    void findEndpoint().then((found) => !cancelled && setEndpoint(found));
    return () => {
      cancelled = true;
    };
  }, [options.endpoint]);
  const served = endpoint === SERVED_ENDPOINT;
  const client = useMemo(() => createClient({ endpoint, secret }), [endpoint, secret]);
  const [info, setInfo] = useState<Info | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [refusal, setRefusal] = useState("");
  const [agent, setAgent] = useState("");
  const [jobs, setJobs] = useState<BoxJob[]>([]);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState("");
  const following = useRef(new Map<string, AbortController>());

  const patch = useCallback((id: string, change: (job: BoxJob) => BoxJob) => {
    setJobs((current) => current.map((job) => (job.id === id ? change(job) : job)));
  }, []);

  const follow = useCallback(
    (id: string) => {
      if (following.current.has(id)) return;
      const controller = new AbortController();
      following.current.set(id, controller);
      client
        .follow(
          id,
          (event) =>
            patch(id, (job) => {
              if (job.steps.some((step) => step.seq === event.seq)) return job;
              const steps = [...job.steps, event];
              const state = event.type === "state" ? event.state : job.state;
              const inPlace = event.type === "release" && event.inPlace ? true : job.inPlace;
              return { ...job, steps, state, inPlace, activity: activityLabel(event) };
            }),
          controller.signal,
        )
        .then(async () => {
          if (controller.signal.aborted) return;
          // The stream ended, so the job did too: take its final record.
          const final = await client.get(id);
          patch(id, (job) => ({ ...job, ...final, activity: undefined }));
        })
        .catch(() => setConnection("offline"))
        .finally(() => following.current.delete(id));
    },
    [client, patch],
  );

  const refresh = useCallback(async () => {
    try {
      let [info, list] = await Promise.all([client.info(), client.list()]);
      if (info.canJoin && info.level === "visitor") {
        // Not signed in, but this app takes guests: become one, then ask again.
        await client.hello();
        [info, list] = await Promise.all([client.info(), client.list()]);
      }
      setAgent(info.agent);
      setInfo(info);
      setConnection("ready");
      setJobs((current) => {
        const known = new Map(current.map((job) => [job.id, job]));
        return list.map((job) => ({
          ...job,
          steps: known.get(job.id)?.steps ?? [],
          activity: known.get(job.id)?.activity,
        }));
      });
      for (const job of list) if (isLive(job)) follow(job.id);
    } catch (error) {
      if (error instanceof RunnerError && !error.offline) {
        setRefusal(error.message);
        setConnection("refused");
      } else setConnection("offline");
    }
  }, [client, follow]);

  // Load when the box first opens, and keep trying while the runner is away.
  useEffect(() => {
    if (!endpoint || (!active && !served)) return;
    void refresh();
  }, [active, served, endpoint, refresh]);
  // The box was opened, so a request is probably coming: the runner can get a sandbox ready meanwhile.
  useEffect(() => {
    if (active && served && connection === "ready") void client.warm().catch(() => {});
  }, [active, served, connection, client]);
  useEffect(() => {
    if (!active || connection !== "offline") return;
    const timer = setInterval(() => void refresh(), RETRY_MS);
    return () => clearInterval(timer);
  }, [active, connection, refresh]);
  useEffect(() => {
    const streams = following.current;
    return () => {
      for (const controller of streams.values()) controller.abort();
      streams.clear();
    };
  }, []);

  const guard = useCallback(async <T>(action: () => Promise<T>): Promise<T | undefined> => {
    setProblem("");
    try {
      return await action();
    } catch (error) {
      if (error instanceof RunnerError && error.offline) setConnection("offline");
      else setProblem(error instanceof Error ? error.message : "Something went wrong.");
      return undefined;
    }
  }, []);

  const submit = useCallback(
    async (text: string, element?: Element | null, scope?: "everyone" | "me"): Promise<boolean> => {
      setSending(true);
      const job = await guard(() => client.submit(text, pageContext(element), scope));
      setSending(false);
      if (!job) return false;
      setJobs((current) => [{ ...job, steps: [], activity: activityLabel(undefined) }, ...current]);
      follow(job.id);
      return true;
    },
    [client, follow, guard],
  );

  const cancel = useCallback((id: string) => guard(() => client.cancel(id)), [client, guard]);
  const undo = useCallback(
    async (id: string) => {
      const job = await guard(() => client.undo(id));
      if (job) patch(id, (current) => ({ ...current, ...job }));
    },
    [client, guard, patch],
  );

  const act = useCallback(
    async (action: () => Promise<unknown>) => {
      if ((await guard(action)) !== undefined) await refresh();
    },
    [guard, refresh],
  );
  const promote = useCallback((id: string) => act(() => client.promote(id)), [act, client]);
  const discard = useCallback((id: string) => act(() => client.discard(id)), [act, client]);
  const view = useCallback(
    async (version: "main" | "mine") => {
      if ((await guard(() => client.view(version))) !== undefined) window.location.reload();
    },
    [client, guard],
  );

  // ---------- reloading onto the right copy of the page ----------
  //
  // When the runner serves the app (or a host does), a change isn't something hot reload shows:
  // it's a different build, and the page has to be loaded again to be on it. That happens up to
  // twice per change: onto a live copy when the agent starts, and onto the built one at the end.
  const [ready, setReady] = useState(false);
  const pushed = info?.mode === "push";
  const reload = useCallback(() => window.location.reload(), []);
  const reloadOrHold = useCallback(() => {
    if (hold.current?.()) setReady(true);
    else window.location.reload();
  }, []);

  const seen = useRef(new Map<string, string>());
  useEffect(() => {
    if (!served && !pushed) return;
    for (const job of jobs) {
      const before = seen.current.get(job.id);
      seen.current.set(job.id, job.state);
      if (before === undefined || before === job.state) continue;
      const settled = job.state === "done" || job.state === "undone" || (job.state === "failed" && before === "working");
      if (!settled) continue;
      // A change to a piece is swapped into this page as it is. Nothing to load again.
      if (job.inPlace) void refreshPieces();
      // A version served at its own address is opened from its link, not by reloading this page.
      else if (!(pushed && job.version !== "main")) reloadOrHold();
    }
  }, [jobs, served, pushed, reloadOrHold]);

  // While something is being worked on, keep asking who we are: that's how the hook learns a live copy is up.
  const working = jobs.some((job) => job.state === "working");
  const waiting = served && !!info?.waiting;
  useEffect(() => {
    if (!served || (!working && !waiting)) return;
    const timer = setInterval(() => void refresh(), 1300);
    return () => clearInterval(timer);
  }, [served, working, waiting, refresh]);

  useEffect(() => {
    if (!served || !working || !info?.live) return;
    // The live copy is up and this page isn't from it yet: move onto it, once per request.
    const id = jobs.find((job) => job.state === "working")?.id ?? "";
    if (sessionStorage.getItem("computah:live") === id || hold.current?.()) return;
    sessionStorage.setItem("computah:live", id);
    window.location.reload();
  }, [served, working, info?.live, jobs]);

  // Their own version was still being put together and they were shown everyone's meanwhile: once it's ready, move over.
  const wasWaiting = useRef(false);
  useEffect(() => {
    if (waiting) wasWaiting.current = true;
    else if (wasWaiting.current) {
      wasWaiting.current = false;
      reloadOrHold();
    }
  }, [waiting, reloadOrHold]);

  return {
    connection,
    refusal,
    agent,
    info,
    endpoint,
    served,
    jobs,
    sending,
    problem,
    submit,
    cancel,
    undo,
    promote,
    discard,
    view,
    refresh,
    /** True when a change is ready to see but its reload was held. Call `reload()` to show it. */
    ready,
    /** True while this person's own version is being put together and they're on everyone's meanwhile. */
    waiting,
    reload,
    dismissProblem: () => setProblem(""),
  };
}
