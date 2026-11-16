"use client";

/**
 * The two ways a new card arrives, both stepped and never eased, both 160ms as in the box:
 * - a wipe, when you step to the previous or next card (HyperCard's "visual effect wipe");
 * - zoom rectangles, when you jump to a card from a list, drawn from what you clicked.
 * Under reduced motion the card is just there.
 */

export type Arrival = { kind: "wipe"; toward: "next" | "previous" } | { kind: "zoom"; from: DOMRect };

let pending: Arrival | null = null;

export function arriveBy(arrival: Arrival) {
  pending = arrival;
}

export function takeArrival(): Arrival | null {
  const arrival = pending;
  pending = null;
  return arrival;
}

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Rect = { left: number; top: number; width: number; height: number };
const frame = (rect: Rect) => ({ left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });

/** Draw four outline rectangles from one rectangle to another while `element` waits hidden. */
export function zoom(from: Rect, element: HTMLElement) {
  if (reduced() || typeof element.animate !== "function") return;
  const box = element.getBoundingClientRect();
  // Only the part of the target that's on screen: a long card zooms to the window, not past it.
  const top = Math.max(box.top, 0);
  const bottom = Math.min(box.bottom, window.innerHeight);
  const to = { left: box.left, top, width: box.width, height: Math.max(bottom - top, 24) };
  const outline = document.createElement("div");
  outline.className = "zoom";
  document.body.appendChild(outline);
  element.style.visibility = "hidden";
  const animation = outline.animate([frame(from), frame(to)], { duration: 160, easing: "steps(4, jump-none)" });
  const finish = () => {
    outline.remove();
    element.style.visibility = "";
  };
  animation.onfinish = finish;
  animation.oncancel = finish;
}

export function wipe(element: HTMLElement, toward: "next" | "previous") {
  if (reduced() || typeof element.animate !== "function") return;
  const start = toward === "next" ? "inset(-8px -8px -8px 100%)" : "inset(-8px 100% -8px -8px)";
  element.animate([{ clipPath: start }, { clipPath: "inset(-8px -8px -8px -8px)" }], {
    duration: 160,
    easing: "steps(4, jump-start)",
  });
}

/** True when the keyboard belongs to something else: a field, a menu, or the improvements box. */
export function keyboardIsBusy(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return true;
  const active = document.activeElement;
  if (!active) return false;
  // The box lives in a shadow root on <div data-computah>; focus inside it shows up as that host.
  if (active.closest("[data-computah]")) return true;
  if (active instanceof HTMLElement && active.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName);
}
