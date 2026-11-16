"use client";

import { useEffect, useState } from "react";

function format(ms: number) {
  const tenths = Math.floor((ms % 1000) / 100);
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

export function Counter() {
  const [banked, setBanked] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const running = startedAt !== null;

  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [startedAt]);

  const elapsed = running ? banked + (now - startedAt) : banked;

  function start() {
    const t = Date.now();
    setNow(t);
    setStartedAt(t);
  }

  function stop() {
    setBanked(elapsed);
    setStartedAt(null);
  }

  function reset() {
    setBanked(0);
    setStartedAt(null);
    setNow(0);
  }

  return (
    <div className="flex items-center gap-4">
      <button type="button" className="push" onClick={running ? stop : start}>
        {running ? "Stop" : "Start"}
      </button>
      <button type="button" className="push" onClick={reset}>
        Reset
      </button>
      <span className="text-[15px] tabular-nums">{format(elapsed)}</span>
    </div>
  );
}
