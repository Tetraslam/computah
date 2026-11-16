"use client";

import Link from "next/link";
import { HomeIcon, NextIcon, PreviousIcon } from "./bitmap";
import type { CardEntry } from "./desk";
import { arriveBy } from "./motion";

/** The bottom edge of a card: back, where you are in the stack, and on. */
export function CardNav({ previous, next, index, total }: { previous?: CardEntry; next?: CardEntry; index: number; total: number }) {
  return (
    <nav className="card-nav" aria-label="cards">
      <div className="previous">
        {previous ? (
          <Link
            className="push"
            href={previous.url}
            rel="prev"
            aria-label={`previous card: ${previous.title}`}
            onClick={() => arriveBy({ kind: "wipe", toward: "previous" })}
          >
            <PreviousIcon />
            <span className="label">{previous.title}</span>
          </Link>
        ) : (
          <span className="push" aria-disabled="true">
            <PreviousIcon />
            <span className="label">first card</span>
          </span>
        )}
      </div>
      <div className="where">
        {index > 0 && (
          <Link
            className="push"
            href="/"
            aria-label="home card"
            title="home card"
            onClick={(event) => arriveBy({ kind: "zoom", from: event.currentTarget.getBoundingClientRect() })}
          >
            <HomeIcon />
          </Link>
        )}
        <span>
          <span className="count-long">
            card {index + 1} of {total}
          </span>
          <span className="count-short">
            {index + 1} / {total}
          </span>
        </span>
      </div>
      <div className="next">
        {next ? (
          <Link
            className="push default"
            href={next.url}
            rel="next"
            aria-label={`next card: ${next.title}`}
            onClick={() => arriveBy({ kind: "wipe", toward: "next" })}
          >
            <span className="label">{next.title}</span>
            <NextIcon />
          </Link>
        ) : (
          <span className="push" aria-disabled="true">
            <span className="label">last card</span>
            <NextIcon />
          </span>
        )}
      </div>
    </nav>
  );
}
