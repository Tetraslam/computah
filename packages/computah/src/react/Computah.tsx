"use client";

import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { type ClientOptions, describeElement, type JobEvent } from "./client.js";
import { STYLES } from "./styles.js";
import { type BoxJob, useBox } from "./use-box.js";

export interface ComputahProps extends ClientOptions {
  /** Keys that open and close the box. "mod" is ⌘ on a Mac and Ctrl elsewhere. Default "mod+.". */
  hotkey?: string;
  /** The window's title. Default "improvements". */
  title?: string;
  /** Show the small button that opens the box. Default true. */
  launcher?: boolean;
  /** Start open. Default false. */
  defaultOpen?: boolean;
}

interface Saved {
  open?: boolean;
  draft?: string;
  x?: number;
  y?: number;
}

const STORE = "computah:box";
const load = (): Saved => {
  try {
    return JSON.parse(sessionStorage.getItem(STORE) ?? "{}") as Saved;
  } catch {
    return {};
  }
};
const save = (change: Saved) => {
  try {
    sessionStorage.setItem(STORE, JSON.stringify({ ...load(), ...change }));
  } catch {
    // Storage can be unavailable; the box still works without it.
  }
};

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function matchesHotkey(
  event: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  },
  hotkey: string,
  mac: boolean,
) {
  const parts = hotkey.toLowerCase().split("+");
  const key = parts.pop();
  const wantMeta = parts.includes("meta") || (parts.includes("mod") && mac);
  const wantCtrl = parts.includes("ctrl") || (parts.includes("mod") && !mac);
  return (
    event.key.toLowerCase() === key &&
    event.metaKey === wantMeta &&
    event.ctrlKey === wantCtrl &&
    event.shiftKey === parts.includes("shift") &&
    event.altKey === parts.includes("alt")
  );
}

export function hotkeyLabel(hotkey: string, mac: boolean) {
  return hotkey
    .split("+")
    .map((part) => {
      const name = part.toLowerCase();
      if (name === "mod") return mac ? "⌘" : "Ctrl";
      if (name === "meta") return "⌘";
      if (name === "shift") return mac ? "⇧" : "Shift";
      if (name === "alt") return mac ? "⌥" : "Alt";
      if (name === "ctrl") return mac ? "⌃" : "Ctrl";
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join(mac ? "" : "+");
}

/** The first paragraph of the agent's closing words, without code formatting. */
export function plainSummary(text: string | undefined) {
  const first = (text ?? "").trim().split(/\n\s*\n/)[0] ?? "";
  return first
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function elapsed(from: number | undefined, to: number) {
  const seconds = Math.max(0, Math.round((to - (from ?? to)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function stepLine(step: JobEvent): string | null {
  if (step.type === "tool") return step.detail ? `${step.name}  ${step.detail}` : step.name;
  if (step.type === "text") return plainSummary(step.text);
  if (step.type === "error") return step.message;
  return null;
}

/** The improvements box. Put one anywhere in your app. */
export function Computah({
  hotkey = "mod+.",
  title = "improvements",
  launcher = true,
  defaultOpen = false,
  endpoint,
  secret,
}: ComputahProps) {
  const [root, setRoot] = useState<ShadowRoot | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Element | null>(null);
  const [hover, setHover] = useState<DOMRect | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [scope, setScope] = useState<"everyone" | "me">("everyone");
  const [ready, setReady] = useState(false);
  // Set on the client only: reading the clock during a server render breaks prerendering.
  const [now, setNow] = useState(0);
  const [mac, setMac] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const windowRef = useRef<HTMLElement>(null);
  const returnFocus = useRef<Element | null>(null);
  const box = useBox({ endpoint, secret, active: open });
  const live = box.jobs.some((job) => job.state === "queued" || job.state === "working");

  // Mount a shadow root on the body, so the host app's styles and ours never meet.
  useEffect(() => {
    const host = document.createElement("div");
    host.setAttribute("data-computah", "");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const saved = load();
    setMac(isMac());
    setOpen(saved.open ?? defaultOpen);
    setDraft(saved.draft ?? "");
    if (saved.x !== undefined && saved.y !== undefined) setPosition({ x: saved.x, y: saved.y });
    setRoot(shadow);
    return () => host.remove();
  }, [defaultOpen]);

  const show = useCallback(() => {
    returnFocus.current = document.activeElement;
    setOpen(true);
    save({ open: true });
  }, []);
  const hide = useCallback(() => {
    setOpen(false);
    setPicking(false);
    save({ open: false });
    if (returnFocus.current instanceof HTMLElement) returnFocus.current.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!matchesHotkey(event, hotkey, isMac())) return;
      event.preventDefault();
      if (open) hide();
      else show();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hotkey, open, show, hide]);

  useEffect(() => {
    if (open && !picking) field.current?.focus({ preventScroll: true });
  }, [open, picking]);

  // Opening draws outline rectangles from the launcher's corner to the window, in steps.
  const zoomed = useRef(false);
  useLayoutEffect(() => {
    const element = windowRef.current;
    if (!open || !root || !element) {
      zoomed.current = false;
      return;
    }
    if (zoomed.current) return;
    zoomed.current = true;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || typeof element.animate !== "function") return;
    const to = element.getBoundingClientRect();
    const from = {
      left: window.innerWidth - 46,
      top: window.innerHeight - 38,
      width: 30,
      height: 22,
    };
    const outline = document.createElement("div");
    outline.className = "zoom";
    root.appendChild(outline);
    element.setAttribute("data-zooming", "");
    const frame = (rect: { left: number; top: number; width: number; height: number }) => ({
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    const animation = outline.animate([frame(from), frame(to)], {
      duration: 160,
      easing: "steps(4, jump-none)",
    });
    const finish = () => {
      outline.remove();
      element.removeAttribute("data-zooming");
    };
    animation.onfinish = finish;
    animation.oncancel = finish;
    return () => animation.cancel();
  }, [open, root]);

  // Grow the field with its text, up to a limit, without moving the window's bottom edge.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the height is re-measured whenever the text or visibility changes.
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(element.scrollHeight, 168)}px`;
  }, [draft, open]);

  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  // Pointing at an element: track what's under the pointer, take it on click.
  useEffect(() => {
    if (!picking) return;
    const under = (event: MouseEvent) =>
      document.elementsFromPoint(event.clientX, event.clientY).find((element) => !element.hasAttribute("data-computah")) ?? null;
    const move = (event: MouseEvent) => setHover(under(event)?.getBoundingClientRect() ?? null);
    const click = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setPicked(under(event));
      setPicking(false);
    };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setPicking(false);
    };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("click", click, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("click", click, true);
      window.removeEventListener("keydown", key, true);
      setHover(null);
    };
  }, [picking]);

  // When the runner serves the app, a change arrives as a new copy of the page, so the page is reloaded:
  // once onto the live copy when work starts, and once onto the built one when it's done.
  const level = box.info?.level;
  const canChoose = box.served && (level === "owner" || level === "trusted");
  const seen = useRef(new Map<string, string>());
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const pushed = box.info?.mode === "push";
  useEffect(() => {
    if (!box.served && !pushed) return;
    for (const job of box.jobs) {
      const before = seen.current.get(job.id);
      seen.current.set(job.id, job.state);
      if (before === undefined || before === job.state) continue;
      const settled = job.state === "done" || job.state === "undone" || (job.state === "failed" && before === "working");
      if (!settled) continue;
      // A version served at its own address is opened from its link, not by reloading this page.
      if (pushed && job.version !== "main") continue;
      if (draftRef.current.trim()) setReady(true);
      else window.location.reload();
    }
  }, [box.jobs, box.served, pushed]);
  const working = box.jobs.some((job) => job.state === "working");
  useEffect(() => {
    if (!box.served || !working) return;
    const refresh = box.refresh;
    const timer = setInterval(() => void refresh(), 1200);
    return () => clearInterval(timer);
  }, [box.served, working, box.refresh]);
  useEffect(() => {
    if (!box.served || !working || !box.info?.live) return;
    // The live copy is up and this page isn't from it yet: move onto it, once per job.
    const id = box.jobs.find((job) => job.state === "working")?.id ?? "";
    if (sessionStorage.getItem("computah:live") === id || draftRef.current.trim()) return;
    sessionStorage.setItem("computah:live", id);
    window.location.reload();
  }, [box.served, working, box.info?.live, box.jobs]);

  const send = async () => {
    const text = draft.trim();
    if (!text || box.sending || box.connection !== "ready") return;
    if (await box.submit(text, picked?.isConnected ? picked : null, canChoose ? scope : undefined)) {
      setDraft("");
      setPicked(null);
      save({ draft: "" });
    }
  };

  const onFieldKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      hide();
    }
  };

  const drag = (event: PointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const element = windowRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const offset = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    const move = (moved: globalThis.PointerEvent) => {
      const x = Math.min(Math.max(0, moved.clientX - offset.x), window.innerWidth - rect.width);
      const y = Math.min(Math.max(0, moved.clientY - offset.y), window.innerHeight - 24);
      setPosition({ x, y });
      save({ x, y });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    event.preventDefault();
  };

  if (!root) return null;
  // No runner to talk to (a deployed page that nothing serves through computah): show nothing.
  if (box.endpoint === "") return null;
  // Someone who can't change the app never sees the box.
  if (box.served && (!box.info || level === "visitor")) return null;

  const pickedLabel = picked ? (describeElement(picked).text?.slice(0, 28) ?? picked.tagName.toLowerCase()) : "";
  const style: CSSProperties | undefined = position ? { left: position.x, top: position.y, bottom: "auto", transform: "none" } : undefined;
  const keys = hotkeyLabel(hotkey, mac);

  return createPortal(
    <>
      <style>{STYLES}</style>
      {launcher && !open && (
        <button type="button" className="launcher" onClick={show} aria-label={`Open ${title} (${keys})`} title={`${title}  ${keys}`}>
          <span className="launcher-mark" aria-hidden="true" />
        </button>
      )}
      {picking && (
        <div className="pick" aria-hidden="true">
          {hover && (
            <div
              className="pick-frame"
              style={{
                left: hover.left,
                top: hover.top,
                width: hover.width,
                height: hover.height,
              }}
            />
          )}
          <div className="pick-hint">click what you mean · esc to cancel</div>
        </div>
      )}
      {open && (
        <section ref={windowRef} className="window" data-picking={picking || undefined} role="dialog" aria-label={title} style={style}>
          <header className="titlebar" onPointerDown={drag}>
            <button type="button" className="closebox" onClick={hide} aria-label="Close" />
            <span className="title">{title}</span>
          </header>

          {box.connection === "offline" || box.connection === "refused" ? (
            <div className="notice" role="status">
              {box.connection === "offline" ? (
                <>
                  <p>the runner isn't running. start it in your project:</p>
                  <code className="command">npx computah</code>
                  <p className="quiet">this box will notice when it's up.</p>
                </>
              ) : (
                <>
                  <p>the runner refused this page.</p>
                  <p className="quiet">{box.refusal}</p>
                </>
              )}
            </div>
          ) : (
            <>
              {(box.info?.proposals?.length ?? 0) > 0 && (
                <ul className="proposals">
                  {box.info?.proposals?.map((proposal) => (
                    <li key={proposal.id} className="proposal">
                      <p className="request">
                        <span className="who">{proposal.name}</span> {proposal.changes.join("; ")}
                      </p>
                      <div className="actions">
                        <button type="button" className="link" onClick={() => void box.promote(proposal.id)}>
                          make it everyone's
                        </button>
                        <button type="button" className="link" onClick={() => void box.discard(proposal.id)}>
                          discard
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {ready && (
                <p className="problem" role="status">
                  your change is ready.
                  <button type="button" className="link" onClick={() => window.location.reload()}>
                    show it
                  </button>
                </p>
              )}
              {box.jobs.length > 0 && (
                <ol className="jobs" aria-live="polite">
                  {box.jobs.slice(0, 20).map((job) => (
                    <JobRow
                      key={job.id}
                      job={job}
                      now={now}
                      expanded={expanded === job.id}
                      onToggle={() => setExpanded(expanded === job.id ? null : job.id)}
                      onStop={() => void box.cancel(job.id)}
                      onUndo={() => void box.undo(job.id)}
                      onRetry={() => {
                        setDraft(job.text);
                        field.current?.focus();
                      }}
                    />
                  ))}
                </ol>
              )}
              {box.problem && (
                <p className="problem" role="alert">
                  {box.problem}
                  <button type="button" className="link" onClick={box.dismissProblem}>
                    ok
                  </button>
                </p>
              )}
              <form
                className="ask"
                onSubmit={(event) => {
                  event.preventDefault();
                  void send();
                }}
              >
                <textarea
                  ref={field}
                  className="field"
                  rows={1}
                  value={draft}
                  placeholder={box.jobs.length ? "what else should change?" : "what should change?"}
                  aria-label="What should change?"
                  onChange={(event) => {
                    setDraft(event.target.value);
                    save({ draft: event.target.value });
                  }}
                  onKeyDown={onFieldKey}
                />
                <div className="controls">
                  {picked ? (
                    <span className="chip">
                      <span className="chip-text">about “{pickedLabel}”</span>
                      <button type="button" className="chip-x" onClick={() => setPicked(null)} aria-label="Forget the element">
                        ×
                      </button>
                    </span>
                  ) : (
                    <button type="button" className="plain" onClick={() => setPicking(true)}>
                      point at it
                    </button>
                  )}
                  <span className="spacer" />
                  {canChoose ? (
                    <button
                      type="button"
                      className="link"
                      onClick={() => setScope(scope === "everyone" ? "me" : "everyone")}
                      title="Who gets this change"
                    >
                      {scope === "everyone" ? "for everyone" : "just for me"}
                    </button>
                  ) : (
                    <span className="quiet agent">
                      {box.connection !== "ready" ? "connecting" : level === "member" ? "only you will see it" : box.agent}
                    </span>
                  )}
                  <button type="submit" className="default" disabled={!draft.trim() || box.sending || box.connection !== "ready"}>
                    Send
                  </button>
                </div>
              </form>
              {box.info?.note && <p className="footer">{box.info.note}</p>}
              {pushed && box.info?.ownUrl && (
                <p className="footer">
                  you have a version of your own.
                  <a className="link" href={box.info.ownUrl}>
                    open it
                  </a>
                </p>
              )}
              {box.served && !pushed && box.info?.hasOwn && (
                <p className="footer">
                  {box.info.version === "mine" ? "you're on your own version." : "you're on everyone's version."}
                  <button type="button" className="link" onClick={() => void box.view(box.info?.version === "mine" ? "main" : "mine")}>
                    {box.info.version === "mine" ? "see everyone's" : "back to mine"}
                  </button>
                  {box.info.stale && <span className="quiet">yours is behind everyone's.</span>}
                </p>
              )}
            </>
          )}
        </section>
      )}
    </>,
    root,
  );
}

function JobRow(props: {
  job: BoxJob;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  onStop: () => void;
  onUndo: () => void;
  onRetry: () => void;
}) {
  const { job, now } = props;
  const live = job.state === "queued" || job.state === "working";
  const lines = job.steps.map(stepLine).filter((line): line is string => Boolean(line));
  const status =
    job.state === "queued"
      ? "waiting its turn"
      : job.state === "working"
        ? (job.activity ?? "working")
        : job.state === "done"
          ? plainSummary(job.summary) || "done."
          : job.state === "failed"
            ? job.error || "it didn't work."
            : job.state === "cancelled"
              ? "stopped. nothing was changed."
              : "undone.";

  return (
    <li className="job" data-state={job.state}>
      <p className="request">{job.text}</p>
      <div className="status">
        <span className="mark" aria-hidden="true" />
        <span className="status-text">{status}</span>
        {job.version && job.version !== "main" && !live && !job.url && <span className="quiet">yours</span>}
        {live && now > 0 && <span className="quiet clock">{elapsed(job.startedAt ?? job.createdAt, now)}</span>}
      </div>
      <div className="actions">
        {lines.length > 0 && (
          <button type="button" className="link" onClick={props.onToggle} aria-expanded={props.expanded}>
            {props.expanded ? "hide steps" : `${lines.length} ${lines.length === 1 ? "step" : "steps"}`}
          </button>
        )}
        {live && (
          <button type="button" className="link" onClick={props.onStop}>
            stop
          </button>
        )}
        {job.state === "done" && job.url && (
          <a className="link" href={job.url}>
            open your version
          </a>
        )}
        {job.state === "done" && (job.files?.length ?? 0) > 0 && (
          <button type="button" className="link" onClick={props.onUndo}>
            undo
          </button>
        )}
        {(job.state === "failed" || job.state === "cancelled" || job.state === "undone") && (
          <button type="button" className="link" onClick={props.onRetry}>
            ask again
          </button>
        )}
      </div>
      {props.expanded && (
        <ol className="steps">
          {lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: steps are append-only, so the index is stable.
            <li key={index}>{line}</li>
          ))}
        </ol>
      )}
    </li>
  );
}
