"use client";

import { useEffect, useState } from "react";

/** How many changes visitors have made to this site, asked of the runner and kept fresh while the card is open. */
export function Tally() {
  const [stats, setStats] = useState<{ changes: number; today: number } | null>(null);
  useEffect(() => {
    let gone = false;
    const ask = () =>
      fetch("/__computah/stats", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((next) => !gone && next && typeof next.changes === "number" && setStats(next))
        // No runner here (plain development): the line just isn't shown.
        .catch(() => {});
    void ask();
    const timer = setInterval(() => document.visibilityState === "visible" && void ask(), 15_000);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, []);

  // The line keeps its height either way, so nothing below it moves when the number arrives.
  const times = (count: number) => `${count.toLocaleString("en-US")} ${count === 1 ? "time" : "times"}`;
  return (
    <p className="tally" aria-live="polite">
      {stats && stats.changes > 0 ? (
        <>
          visitors have changed this site <b>{times(stats.changes)}</b>
          {stats.today > 0 && stats.today < stats.changes ? <>, {stats.today.toLocaleString("en-US")} of them in the last day</> : null}
        </>
      ) : (
        "\u00a0"
      )}
    </p>
  );
}
