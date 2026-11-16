/**
 * The box's whole look, kept inside its shadow root. See BRIEF.md: black and
 * white only, 1-bit dither as the state language, stepped motion.
 */
export const STYLES = /* css */ `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }

.window, .launcher, .pick-hint {
  --ink: #000;
  --paper: #fff;
  --ui: system-ui, -apple-system, "Segoe UI", sans-serif;
  --words: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  --checker: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='2' height='2' shape-rendering='crispEdges'%3E%3Crect width='2' height='2' fill='%23fff'/%3E%3Crect width='1' height='1'/%3E%3Crect x='1' y='1' width='1' height='1'/%3E%3C/svg%3E") 0 0 / 2px 2px;
  --sparse: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='2' height='2' shape-rendering='crispEdges'%3E%3Crect width='2' height='2' fill='%23fff'/%3E%3Crect width='1' height='1'/%3E%3C/svg%3E") 0 0 / 2px 2px;
  --stripes: repeating-linear-gradient(var(--ink) 0 1px, var(--paper) 1px 2px);
  font: 12px/1.35 var(--ui);
  color: var(--ink);
  -webkit-font-smoothing: antialiased;
}

/* ---------- the window ---------- */

.window {
  position: fixed;
  z-index: 2147483000;
  left: 50%;
  bottom: 20px;
  transform: translateX(-50%);
  width: min(420px, calc(100vw - 24px));
  max-height: min(560px, calc(100vh - 40px));
  display: flex;
  flex-direction: column;
  background: var(--paper);
  border: 1px solid var(--ink);
  box-shadow: 2px 2px 0 var(--ink);
}
.window[data-picking] { visibility: hidden; }
.window[data-zooming] { visibility: hidden; }

.titlebar {
  position: relative;
  flex: none;
  height: 19px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-bottom: 1px solid var(--ink);
  background: var(--stripes) content-box;
  padding: 3px 2px;
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.titlebar:active { cursor: grabbing; }
.title {
  background: var(--paper);
  padding: 0 7px;
  font-weight: 700;
  line-height: 13px;
  letter-spacing: 0.01em;
}
.closebox {
  position: absolute;
  left: 8px;
  top: 3px;
  width: 13px;
  height: 13px;
  padding: 0;
  border: 1px solid var(--ink);
  background: var(--paper);
  box-shadow: 0 0 0 1px var(--paper);
  cursor: pointer;
}
.closebox:hover, .closebox:active { background: var(--ink); }
.closebox:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

/* ---------- requests ---------- */

.jobs {
  flex: 0 1 auto;
  min-height: 0;
  max-height: 244px;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column-reverse;
  border-bottom: 1px solid var(--ink);
  scrollbar-width: thin;
  scrollbar-color: var(--ink) var(--paper);
}
.job { padding: 9px 12px 8px; }
.job + .job { border-bottom: 1px dotted var(--ink); }
.request {
  margin: 0 0 5px;
  font: 14px/1.3 var(--words);
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
}
.status { display: flex; align-items: baseline; gap: 7px; }
.status-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.job[data-state="done"] .status-text { font: 13px/1.35 var(--words); }

.mark {
  flex: none;
  width: 9px;
  height: 9px;
  border: 1px solid var(--ink);
  transform: translateY(1px);
}
.job[data-state="queued"] .mark { background: var(--sparse); }
.job[data-state="working"] .mark {
  background: repeating-linear-gradient(90deg, var(--ink) 0 2px, var(--paper) 2px 4px);
  animation: march 480ms steps(4, jump-none) infinite;
}
.job[data-state="done"] .mark { background: var(--ink); }
.job[data-state="failed"] .mark {
  background:
    linear-gradient(45deg, transparent 42%, var(--ink) 42% 58%, transparent 58%),
    linear-gradient(-45deg, transparent 42%, var(--ink) 42% 58%, transparent 58%);
}
.job[data-state="cancelled"] .mark, .job[data-state="undone"] .mark { background: var(--paper); }
.job[data-state="undone"] .request, .job[data-state="cancelled"] .request { text-decoration: line-through; text-decoration-thickness: 1px; }
@keyframes march { to { background-position: 4px 0; } }

.actions { display: flex; gap: 12px; margin-top: 4px; padding-left: 16px; min-height: 16px; }
.clock { font-variant-numeric: tabular-nums; }
.quiet { font-size: 11px; }
.steps {
  margin: 6px 0 0;
  padding: 6px 8px;
  list-style: none;
  border: 1px solid var(--ink);
  max-height: 132px;
  overflow-y: auto;
  font: 11px/1.45 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  scrollbar-width: thin;
  scrollbar-color: var(--ink) var(--paper);
}
.steps li { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.proposals { flex: none; margin: 0; padding: 0; list-style: none; border-bottom: 1px solid var(--ink); background: var(--sparse); }
.proposal { margin: 6px; padding: 7px 9px 6px; border: 1px solid var(--ink); background: var(--paper); }
.proposal .actions { padding-left: 0; }
.who { font: 700 12px/1.3 var(--ui); margin-right: 3px; }
.footer { flex: none; margin: 0; padding: 6px 12px 7px; border-top: 1px dotted var(--ink); font-size: 11px; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }

/* ---------- asking ---------- */

.ask { flex: none; padding: 10px 12px 10px; }
.field {
  display: block;
  width: 100%;
  min-height: 32px;
  margin: 0;
  padding: 6px 8px;
  border: 1px solid var(--ink);
  border-radius: 0;
  background: var(--paper);
  color: var(--ink);
  font: 14px/1.35 var(--words);
  resize: none;
  outline: none;
  overflow-y: auto;
}
.field::placeholder { color: var(--ink); opacity: 1; font-style: italic; }
.field:focus { box-shadow: 0 0 0 1px var(--ink); }
.field::selection, .request::selection, .status-text::selection { background: var(--ink); color: var(--paper); }

.controls { display: flex; align-items: center; gap: 10px; margin-top: 9px; min-height: 26px; }
.spacer { flex: 1; }
.agent { white-space: nowrap; }

button { font: inherit; color: inherit; }
.plain, .default {
  height: 20px;
  padding: 0 11px;
  border: 1px solid var(--ink);
  border-radius: 6px;
  background: var(--paper);
  font-weight: 700;
  line-height: 18px;
  cursor: pointer;
  white-space: nowrap;
}
.default { min-width: 58px; box-shadow: 0 0 0 2px var(--paper), 0 0 0 4px var(--ink); border-radius: 5px; margin-right: 4px; }
.plain:hover, .default:hover:not(:disabled), .plain:active, .default:active:not(:disabled) { background: var(--ink); color: var(--paper); }
/* Disabled the way a 1-bit screen does it: the label and ring are dithered, not grayed. */
.default:disabled { cursor: default; color: transparent; background: var(--checker); -webkit-background-clip: text; background-clip: text; box-shadow: 0 0 0 2px var(--paper), 0 0 0 4px var(--ink); border-style: dotted; }
.plain:focus-visible, .default:focus-visible, .link:focus-visible, .chip-x:focus-visible, .launcher:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }

.link {
  padding: 0;
  border: 0;
  background: none;
  font-size: 11px;
  font-weight: 700;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.link:hover { background: var(--ink); color: var(--paper); text-decoration: none; }

.chip { display: inline-flex; align-items: center; height: 20px; border: 1px solid var(--ink); background: var(--ink); color: var(--paper); max-width: 190px; }
.chip-text { padding: 0 6px 0 7px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chip-x { width: 18px; height: 18px; padding: 0; border: 0; border-left: 1px solid var(--paper); background: var(--ink); color: var(--paper); font-weight: 700; line-height: 16px; cursor: pointer; }
.chip-x:hover { background: var(--paper); color: var(--ink); }

.problem { margin: 0; padding: 7px 12px; border-bottom: 1px solid var(--ink); background: var(--ink); color: var(--paper); display: flex; gap: 10px; align-items: baseline; }
.problem .link { color: var(--paper); margin-left: auto; }
.problem .link:hover { background: var(--paper); color: var(--ink); }

.notice { padding: 14px 14px 13px; }
.notice p { margin: 0 0 8px; font: 14px/1.35 var(--words); }
.notice p.quiet { margin: 8px 0 0; font: 11px/1.35 var(--ui); }
.command { display: block; padding: 6px 8px; border: 1px solid var(--ink); font: 12px/1.3 ui-monospace, "SF Mono", Menlo, Consolas, monospace; user-select: all; }

/* ---------- opening it ---------- */

.launcher {
  position: fixed;
  z-index: 2147483000;
  right: 16px;
  bottom: 16px;
  width: 30px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--ink);
  background: var(--paper);
  box-shadow: 2px 2px 0 var(--ink);
  cursor: pointer;
}
.launcher-mark { position: absolute; inset: 0 0 auto 0; height: 6px; border-bottom: 1px solid var(--ink); background: var(--stripes) content-box; padding: 1px; }
.launcher::after { content: ""; position: absolute; left: 4px; right: 4px; bottom: 4px; height: 5px; border: 1px solid var(--ink); }
.launcher:hover { background: var(--ink); }
.launcher:hover::after { border-color: var(--paper); }
.launcher:active { transform: translate(1px, 1px); box-shadow: 1px 1px 0 var(--ink); }

.zoom { position: fixed; z-index: 2147483001; border: 1px solid #000; outline: 1px solid #fff; pointer-events: none; }

/* ---------- pointing ---------- */

.pick { position: fixed; inset: 0; z-index: 2147483001; cursor: crosshair; }
.pick-frame { position: fixed; outline: 1px solid #000; box-shadow: 0 0 0 2px #fff, 0 0 0 3px #000; pointer-events: none; }
.pick-hint { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); padding: 4px 10px; border: 1px solid var(--ink); background: var(--paper); box-shadow: 2px 2px 0 var(--ink); font-weight: 700; white-space: nowrap; }

@media (prefers-reduced-motion: reduce) {
  .job[data-state="working"] .mark { animation: none; }
}
`;
