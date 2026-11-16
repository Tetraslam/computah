"use client";

import { useState } from "react";

// Try a value for the box's `hotkey` prop and see what it means on a Mac and everywhere else.
function label(hotkey: string, mac: boolean) {
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

export default function Reference() {
  const [hotkey, setHotkey] = useState("mod+.");
  const value = hotkey.trim() || "mod+.";

  return (
    <div>
      <label style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", font: "700 12px/1 var(--ui)" }}>
        hotkey=
        <input
          value={hotkey}
          onChange={(event) => setHotkey(event.target.value)}
          spellCheck={false}
          style={{
            width: 180,
            height: 28,
            padding: "0 8px",
            border: "1px solid #000",
            borderRadius: 0,
            background: "#fff",
            color: "#000",
            font: "14px/1 var(--mono)",
          }}
        />
      </label>
      <div style={{ display: "flex", gap: 24, marginTop: 14, flexWrap: "wrap" }}>
        {[true, false].map((mac) => (
          <div key={String(mac)}>
            <div style={{ font: "700 11px/1 var(--ui)" }}>{mac ? "on a mac" : "everywhere else"}</div>
            <div style={{ marginTop: 6, padding: "4px 10px", border: "1px solid #000", borderRadius: 4, font: "700 15px/1.2 var(--ui)" }}>
              {label(value, mac)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
