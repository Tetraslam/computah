"use client";

import dynamic from "next/dynamic";
import { Component, type ComponentType, type CSSProperties, type ReactNode } from "react";

/**
 * The parts of this site a visitor may change. Each piece is one file in `playground/`, loaded only in
 * the browser so a visitor's change can never break the server render. The map is static on purpose:
 * no computed import paths. `sizes` is the space kept for each piece before it loads, so nothing shifts.
 */
type Size = { wide: number; narrow: number };

function reserve({ wide, narrow }: Size) {
  return { "--reserve": `${wide}px`, "--reserve-narrow": `${narrow}px` } as CSSProperties;
}

function Reserve({ size }: { size: Size }) {
  return <div className="reserve" style={reserve(size)} aria-hidden="true" />;
}

const sizes = {
  home: { wide: 64, narrow: 64 },
  "start-here": { wide: 164, narrow: 225 },
  "people-and-trust": { wide: 280, narrow: 280 },
  "how-a-change-travels": { wide: 114, narrow: 114 },
  safety: { wide: 247, narrow: 290 },
  reference: { wide: 87, narrow: 87 },
} satisfies Record<string, Size>;

const pieces: Record<keyof typeof sizes, ComponentType> = {
  home: dynamic(() => import("../playground/home"), { ssr: false, loading: () => <Reserve size={sizes.home} /> }),
  "start-here": dynamic(() => import("../playground/start-here"), { ssr: false, loading: () => <Reserve size={sizes["start-here"]} /> }),
  "people-and-trust": dynamic(() => import("../playground/people-and-trust"), {
    ssr: false,
    loading: () => <Reserve size={sizes["people-and-trust"]} />,
  }),
  "how-a-change-travels": dynamic(() => import("../playground/how-a-change-travels"), {
    ssr: false,
    loading: () => <Reserve size={sizes["how-a-change-travels"]} />,
  }),
  safety: dynamic(() => import("../playground/safety"), { ssr: false, loading: () => <Reserve size={sizes.safety} /> }),
  reference: dynamic(() => import("../playground/reference"), { ssr: false, loading: () => <Reserve size={sizes.reference} /> }),
};

export type PieceName = keyof typeof sizes;

/** A visitor's change may throw. The card stays up and says so. */
class Catch extends Component<{ children: ReactNode; size: Size }, { broken: boolean }> {
  state = { broken: false };

  static getDerivedStateFromError() {
    return { broken: true };
  }

  render() {
    if (!this.state.broken) return this.props.children;
    return (
      <div className="piece-broken reserve" style={reserve(this.props.size)} role="alert">
        <p>this piece broke :( open the box and ask it to fix it</p>
        <button type="button" className="push small" onClick={() => this.setState({ broken: false })}>
          try again
        </button>
      </div>
    );
  }
}

export function Playground({ name }: { name: PieceName }) {
  const Piece = pieces[name];
  return (
    <section className="yours" aria-label="yours to change">
      <header className="titlebar">
        <span className="title">yours to change</span>
      </header>
      <div className="yours-body">
        <Catch size={sizes[name]}>
          <div className="reserve" style={reserve(sizes[name])}>
            <Piece />
          </div>
        </Catch>
      </div>
      <p className="yours-foot">
        this part is yours to mess with. open the box with <span className="kbd">Ctrl</span>+<span className="kbd">.</span> (or{" "}
        <span className="kbd">⌘</span>
        <span className="kbd">.</span> on a mac) and say how it should be different, and only you will see your version
      </p>
    </section>
  );
}
