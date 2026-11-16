"use client";

import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <div className="flex items-center gap-4">
      <button
        type="button"
        className="push"
        onClick={() => setCount(count + 1)}
      >
        Press
      </button>
      <span className="text-[15px] tabular-nums">
        pressed {count} {count === 1 ? "time" : "times"}
      </span>
    </div>
  );
}
