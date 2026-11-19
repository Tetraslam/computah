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

export interface Theme {
  /** Text, borders and filled shapes. Default black. */
  ink?: string;
  /** Backgrounds. Default white. */
  paper?: string;
  /** Labels and buttons. Default: the system UI font. */
  font?: string;
  /** What you typed and what the agent answered. Default: a serif. */
  wordsFont?: string;
  /** Steps and commands. Default: the system monospace font. */
  monoFont?: string;
  /** Corners of the window and the field, for example "10px". Default square. */
  radius?: string;
  /** Corners of buttons. Default "6px". */
  controlRadius?: string;
  /** The window's shadow. Default: a hard 2px edge. "none" removes it. */
  shadow?: string;
  /** The title bar's background. Default: pinstripes. */
  titlebar?: string;
  /** The window's width. Default "420px". */
  width?: string;
  /** Default 2147483000. */
  zIndex?: number | string;
}

const THEME_VARS: Record<keyof Theme, string> = {
  ink: "--computah-ink",
  paper: "--computah-paper",
  font: "--computah-font",
  wordsFont: "--computah-words-font",
  monoFont: "--computah-mono-font",
  radius: "--computah-radius",
  controlRadius: "--computah-control-radius",
  shadow: "--computah-shadow",
  titlebar: "--computah-titlebar",
  width: "--computah-width",
  zIndex: "--computah-z-index",
};

/** A theme as CSS variables, for the box's root element. */
export function themeStyle(theme: Theme | undefined): CSSProperties {
  const style: Record<string, string> = {};
  for (const [key, name] of Object.entries(THEME_VARS)) {
    const value = theme?.[key as keyof Theme];
    if (value !== undefined && value !== "") style[name] = String(value);
  }
  return style as CSSProperties;
}

export interface ComputahProps extends ClientOptions {
  /** Keys that open and close the box. "mod" is ⌘ on a Mac and Ctrl elsewhere. Default "mod+.". */
  hotkey?: string;
  /** The window's title. Default "improvements". */
  title?: string;
  /** Show the small button that opens the box. Default true. */
  launcher?: boolean;
  /** Start open. Default false. */
  defaultOpen?: boolean;
  /**
   * Colours, fonts and shape, to match your app. Each one can also be set from CSS as
   * `--computah-<name>` on `[data-computah]`. For more than this, style the named parts with
   * `[data-computah]::part(window)` and friends, or build your own box on `useBox`.
   */
  theme?: Theme;
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

const OPEN_EVENT = "computah:open";

/** Open the box from anywhere in the app, for example from a button that says "change this". */
export function openBox() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

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
  theme,
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
  // Set on the client only: reading the clock during a server render breaks prerendering.
  const [now, setNow] = useState(0);
  const [mac, setMac] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const windowRef = useRef<HTMLElement | null>(null);
  // The window only exists once the runner has said who this is, so effects that measure it wait on this.
  const [windowShown, setWindowShown] = useState(false);
  const attachWindow = useCallback((element: HTMLElement | null) => {
    windowRef.current = element;
    setWindowShown(!!element);
  }, []);
  const rootElement = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<Element | null>(null);
  // Don't reload the page out from under a request that's half typed.
  const draftRef = useRef("");
  const box = useBox({ endpoint, secret, active: open, holdReloads: () => !!draftRef.current.trim() });
  draftRef.current = draft;
  const live = box.jobs.some((job) => job.state === "queued" || job.state === "working");

  // The size of the page's window, kept current, so a remembered position can be held inside it.
  const [viewport, setViewport] = useState({ width: 1e6, height: 1e6 });
  useEffect(() => {
    const measure = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // The box grows as requests are added, so its bottom edge is checked against the window whenever either changes size.
  useEffect(() => {
    const element = windowRef.current;
    if (!open || !position || !element || !windowShown) return;
    const settle = () => {
      const rect = element.getBoundingClientRect();
      const over = rect.bottom - (viewport.height - 8);
      if (over > 0.5 && rect.top > 0) setPosition((at) => (at ? { ...at, y: Math.max(0, Math.min(at.y, rect.top) - over) } : at));
    };
    settle();
    const watching = new ResizeObserver(settle);
    watching.observe(element);
    return () => watching.disconnect();
  }, [open, position, viewport, windowShown]);

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
    // The app can open the box from a button of its own, which is the only way in on a phone besides the launcher.
    window.addEventListener(OPEN_EVENT, show);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, show);
    };
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
    (rootElement.current ?? root).appendChild(outline);
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

  const level = box.info?.level;
  const canChoose = box.served && (level === "owner" || level === "trusted");
  const pushed = box.info?.mode === "push";
  const { ready, waiting } = box;

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
  // Where it was dragged to is remembered, but the window it was dragged in may have been bigger
  // (or zoomed differently) than this one. It's always pulled back to where it can be seen and reached.
  const style: CSSProperties | undefined = position
    ? {
        left: Math.max(0, Math.min(position.x, viewport.width - Math.min(420, viewport.width - 24))),
        top: Math.max(0, Math.min(position.y, viewport.height - 120)),
        bottom: "auto",
        transform: "none",
      }
    : undefined;
  const keys = hotkeyLabel(hotkey, mac);

  return createPortal(
    <div ref={rootElement} style={{ display: "contents", ...themeStyle(theme) }}>
      <style>{STYLES}</style>
      {launcher && !open && (
        <button
          type="button"
          className="launcher"
          part="launcher"
          onClick={show}
          aria-label={`Open ${title} (${keys})`}
          title={`${title}  ${keys}`}
        >
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
        <section
          ref={attachWindow}
          className="window"
          part="window"
          data-picking={picking || undefined}
          role="dialog"
          aria-label={title}
          style={style}
        >
          <header className="titlebar" part="titlebar" onPointerDown={drag}>
            <button type="button" className="closebox" part="close" onClick={hide} aria-label="Close" />
            <span className="title" part="title">
              {title}
            </span>
          </header>

          {box.connection === "offline" || box.connection === "refused" ? (
            <div className="notice" part="notice" role="status">
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
                <ol className="jobs" part="requests" aria-live="polite">
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
                part="form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void send();
                }}
              >
                <textarea
                  ref={field}
                  className="field"
                  part="field"
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
                <div className="controls" part="controls">
                  {picked ? (
                    <span className="chip">
                      <span className="chip-text">about “{pickedLabel}”</span>
                      <button type="button" className="chip-x" onClick={() => setPicked(null)} aria-label="Forget the element">
                        ×
                      </button>
                    </span>
                  ) : (
                    <button type="button" className="plain" part="button" onClick={() => setPicking(true)}>
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
                  <button
                    type="submit"
                    className="default"
                    part="send"
                    disabled={!draft.trim() || box.sending || box.connection !== "ready"}
                  >
                    Send
                  </button>
                </div>
              </form>
              {waiting && (
                <p className="footer" role="status">
                  <span className="mark-working" aria-hidden="true" />
                  getting your version ready. this is everyone's for a moment.
                </p>
              )}
              {box.info?.note && <p className="footer">{box.info.note}</p>}
              {box.chatgpt &&
                (box.chatgpt.connected ? (
                  <p className="footer" part="chatgpt">
                    {box.chatgptJustConnected ? "You're using your ChatGPT plan." : "Using ChatGPT plan"}
                    {box.chatgpt.email && !box.chatgptJustConnected && <span className="quiet">{box.chatgpt.email}</span>}
                    <a className="link" href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">
                      Manage usage
                    </a>
                    {box.chatgptJustConnected ? (
                      <button type="button" className="link" onClick={box.dismissChatGPTWelcome}>
                        Got it
                      </button>
                    ) : (
                      <button type="button" className="link" onClick={() => void box.disconnectChatGPT()}>
                        disconnect
                      </button>
                    )}
                  </p>
                ) : box.chatgptPaste ? (
                  <form
                    className="footer"
                    part="chatgpt"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const field = event.currentTarget.elements.namedItem("address") as HTMLInputElement | null;
                      if (field?.value.trim()) void box.finishChatGPT(field.value);
                    }}
                  >
                    <span>
                      approve it in the tab that opened. it ends on a page that won't load, and that's fine: copy that page's address and
                      paste it here.
                    </span>
                    <input
                      className="field paste"
                      name="address"
                      aria-label="The address the sign-in ended on"
                      placeholder="http://127.0.0.1:1455/auth/callback?code=…"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button type="submit" className="plain">
                      finish
                    </button>
                    <button type="button" className="link" onClick={box.cancelChatGPT}>
                      cancel
                    </button>
                  </form>
                ) : (
                  <p className="footer" part="chatgpt">
                    {box.chatgpt.required ? "requests here use your own ChatGPT plan." : "you can use your own ChatGPT plan here."}
                    <button type="button" className="plain" data-oai-siwc-button="" onClick={() => void box.connectChatGPT()}>
                      Continue with ChatGPT
                    </button>
                  </p>
                ))}
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
    </div>,
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
    <li className="job" part="request" data-state={job.state}>
      <p className="request" part="request-text">
        {job.text}
      </p>
      <div className="status" part="status">
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
        {!job.chore && (job.state === "failed" || job.state === "cancelled" || job.state === "undone") && (
          <button type="button" className="link" onClick={props.onRetry}>
            ask again
          </button>
        )}
      </div>
      {props.expanded && (
        <ol className="steps" part="steps">
          {lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: steps are append-only, so the index is stable.
            <li key={index}>{line}</li>
          ))}
        </ol>
      )}
    </li>
  );
}
