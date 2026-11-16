"use client";

import { useState } from "react";

// A little card of your own. Everything here is plain React: ask the box to change any of it.
export default function Home() {
  const [presses, setPresses] = useState(0);
  const words = [
    "hi",
    "hi again",
    "okay you can stop pressing now",
    "you could change me into something else instead lol",
    "open the box and tell it what i should be :3",
  ];

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
      <div
        aria-hidden="true"
        style={{
          width: 64,
          height: 64,
          border: "1px solid #000",
          boxShadow: "2px 2px 0 #000",
          display: "grid",
          placeItems: "center",
          background: presses % 2 ? "#000" : "#fff",
          color: presses % 2 ? "#fff" : "#000",
          font: "28px/1 var(--words)",
        }}
      >
        {presses % 2 ? "☻" : "☺"}
      </div>
      <div style={{ flex: "1 1 200px" }}>
        <p style={{ margin: 0, font: "19px/1.35 var(--words)" }}>{words[Math.min(presses, words.length - 1)]}</p>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10 }}>
          <button type="button" className="push" onClick={() => setPresses(presses + 1)}>
            press
          </button>
          <span style={{ font: "12px/1 var(--ui)", fontVariantNumeric: "tabular-nums" }}>
            pressed {presses} {presses === 1 ? "time" : "times"}
          </span>
        </div>
      </div>
    </div>
  );
}
