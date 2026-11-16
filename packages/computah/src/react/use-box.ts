import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  activityLabel,
  type ClientOptions,
  createClient,
  type Job,
  type JobEvent,
  pageContext,
  RunnerError,
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
  const { endpoint, secret, active } = options;
  const client = useMemo(
    () => createClient({ endpoint, secret }),
    [endpoint, secret],
  );
  const [connection, setConnection] = useState<Connection>("connecting");
  const [refusal, setRefusal] = useState("");
  const [agent, setAgent] = useState("");
  const [jobs, setJobs] = useState<BoxJob[]>([]);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState("");
  const following = useRef(new Map<string, AbortController>());

  const patch = useCallback((id: string, change: (job: BoxJob) => BoxJob) => {
    setJobs((current) =>
      current.map((job) => (job.id === id ? change(job) : job)),
    );
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
    if (!active) return;
    void refresh();
  }, [active, refresh]);
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

  const guard = useCallback(
    async <T>(action: () => Promise<T>): Promise<T | undefined> => {
      setProblem("");
      try {
        return await action();
      } catch (error) {
        if (error instanceof RunnerError && error.offline)
          setConnection("offline");
        else
          setProblem(
            error instanceof Error ? error.message : "Something went wrong.",
          );
        return undefined;
      }
    },
    [],
  );

  const submit = useCallback(
    async (text: string, element?: Element | null): Promise<boolean> => {
      setSending(true);
      const job = await guard(() => client.submit(text, pageContext(element)));
      setSending(false);
      if (!job) return false;
      setJobs((current) => [
        { ...job, steps: [], activity: activityLabel(undefined) },
        ...current,
      ]);
      follow(job.id);
      return true;
    },
    [client, follow, guard],
  );

  const cancel = useCallback(
    (id: string) => guard(() => client.cancel(id)),
    [client, guard],
  );
  const undo = useCallback(
    async (id: string) => {
      const job = await guard(() => client.undo(id));
      if (job) patch(id, (current) => ({ ...current, ...job }));
    },
    [client, guard, patch],
  );

  return {
    connection,
    refusal,
    agent,
    jobs,
    sending,
    problem,
    submit,
    cancel,
    undo,
    dismissProblem: () => setProblem(""),
  };
}
