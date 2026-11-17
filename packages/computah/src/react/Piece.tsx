"use client";

import * as React from "react";
import { type ComponentType, type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { SERVED_ENDPOINT } from "./client.js";

// A piece is one self-contained component of the app that a person can have their own version of
// without the app being rebuilt for them. The runner compiles their version of the file by
// itself, and this swaps it into the page in place of the one the app was built with.

type Factory = (
  require: (name: string) => unknown,
  module: { exports: Record<string, unknown> },
  exports: Record<string, unknown>,
  process: unknown,
) => void;

/** This person's own pieces, file to script name. Null until the runner has been asked. */
let table: Record<string, string> | null = null;
let asking: Promise<void> | null = null;
const listeners = new Set<() => void>();
const loaded = new Map<string, ComponentType | Error>();
const loading = new Map<string, Promise<void>>();

function ask(): Promise<void> {
  asking ??= fetch(`${SERVED_ENDPOINT}/pieces`, { cache: "no-store" })
    .then(async (response) => (response.ok ? (((await response.json()) as { pieces?: Record<string, string> }).pieces ?? {}) : {}))
    // No runner serving this app (plain development, say): everything is as built.
    .catch(() => ({}))
    .then((next) => {
      table = next;
      asking = null;
      for (const listener of listeners) listener();
    });
  return asking;
}

/** Ask the runner again which pieces this person has of their own. The box does this when a change lands. */
export function refreshPieces(): Promise<void> {
  return ask();
}

function provide(name: string): unknown {
  if (name === "react") return React;
  if (name === "react/jsx-runtime") return jsxRuntime;
  throw new Error(`A piece can only import react, and this one imports ${name}.`);
}

function load(id: string): Promise<void> {
  let pending = loading.get(id);
  if (pending) return pending;
  pending = new Promise<void>((resolve) => {
    const script = document.createElement("script");
    script.src = `${SERVED_ENDPOINT}/pieces/${id}.js`;
    script.async = true;
    const settle = (result: ComponentType | Error) => {
      loaded.set(id, result);
      script.remove();
      resolve();
    };
    script.onerror = () => settle(new Error("This piece couldn't be loaded."));
    script.onload = () => {
      try {
        const factory = (globalThis as { __computahPieces?: Record<string, Factory> }).__computahPieces?.[id];
        if (!factory) throw new Error("This piece couldn't be loaded.");
        const module = { exports: {} as Record<string, unknown> };
        factory(provide, module, module.exports, { env: { NODE_ENV: "production" } });
        const component = module.exports.default;
        if (typeof component !== "function") throw new Error("This piece has no component to show.");
        settle(component as ComponentType);
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
      }
    };
    document.head.appendChild(script);
  });
  loading.set(id, pending);
  return pending;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export interface PieceProps {
  /** The file this piece lives in, from the root of the repo, as in the runner's `pieces` setting. */
  file: string;
  /** The component as the app was built with it. Shown unless this person has a version of their own. */
  stock: ComponentType;
  /** Shown for the moment before it's known which version to show. Give it the piece's size so nothing jumps. */
  loading?: ReactNode;
}

/**
 * Show a piece: this person's own version of it if they have one, otherwise the app's. Their
 * version arrives without a rebuild or a page load, a moment after the agent has written it.
 * A piece that throws does so here, so wrap this in an error boundary if you'd like to catch it.
 */
export function Piece({ file, stock: Stock, loading: placeholder = null }: PieceProps) {
  const pieces = useSyncExternalStore(
    subscribe,
    () => table,
    () => null,
  );
  const [, redraw] = useState(0);
  // While a newer version of theirs loads, the one they were looking at stays up.
  const shown = useRef<ComponentType | null>(null);
  useEffect(() => {
    if (table === null) void ask();
  }, []);
  const id = pieces?.[file];
  useEffect(() => {
    if (id && !loaded.has(id)) void load(id).then(() => redraw((count) => count + 1));
  }, [id]);

  if (pieces === null) return placeholder;
  if (!id) {
    shown.current = null;
    return <Stock />;
  }
  const mine = loaded.get(id);
  if (mine instanceof Error) throw mine;
  if (mine) shown.current = mine;
  const Shown = shown.current;
  return Shown ? <Shown /> : placeholder;
}
