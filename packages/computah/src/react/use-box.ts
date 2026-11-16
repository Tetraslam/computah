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
export function useBox(options: ClientOptions & { active: boolean }) {
  const { secret, active } = options;
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
              return { ...job, steps, state, activity: activityLabel(event) };
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
      const [info, list] = await Promise.all([client.info(), client.list()]);
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

  return {
    connection,
    refusal,
    agent,
    info,
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
    dismissProblem: () => setProblem(""),
  };
}
