/** What the box sends along with the request, so the agent knows where the user was. */
export interface JobContext {
  url?: string;
  title?: string;
  viewport?: { width: number; height: number };
  /** Text the user had selected on the page. */
  selection?: string;
  /** An element the user pointed at. */
  element?: {
    selector: string;
    text?: string;
    html?: string;
    component?: string;
  };
}

export type JobState = "queued" | "working" | "done" | "failed" | "cancelled" | "undone";

export interface Job {
  id: string;
  text: string;
  context: JobContext;
  state: JobState;
  agent: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** The agent's own closing words, in plain language. */
  summary?: string;
  error?: string;
  /** Files the job changed, relative to the repo root. */
  files?: string[];
  /** Tree snapshots taken before and after, used for undo. */
  before?: string;
  after?: string;
  commit?: string;
  /** Every commit the job made, oldest first: the change, then any fixes to make it build. */
  commits?: string[];
  /** True for work the runner started itself, such as catching a version up. Nobody typed it. */
  chore?: boolean;
  /** Who asked, when the runner knows. */
  by?: { id: string; name?: string };
  /** Which version of the app this changes: "main" for everyone's, or a person's own. */
  version?: string;
  /** Where the change is on its way to being served. Absent in development, where saving is releasing. */
  release?: "building" | "live" | "failed";
  releaseError?: string;
  /** Where the change can be seen, when it's served at an address of its own. */
  url?: string;
}

export type JobEventBody =
  | { type: "state"; state: JobState }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; detail?: string }
  | { type: "error"; message: string }
  | { type: "release"; state: "building" | "live" | "failed"; message?: string };

export type JobEvent = JobEventBody & { seq: number; at: number };

/** One thing an agent said or did, in the shape every adapter reduces to. */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; detail?: string }
  | { type: "error"; message: string }
  | { type: "result"; text: string };

export interface AgentCommand {
  command: string;
  args: string[];
  /** Written to the agent's stdin, then closed. */
  stdin?: string;
}

export interface Agent {
  name: string;
  /** The command that runs the agent once, headless, on `prompt` in `cwd`. */
  command(prompt: string, cwd: string): AgentCommand;
  /** Turn one line of the agent's output into events. Unknown lines yield nothing. */
  parse(line: string): AgentEvent[];
}
