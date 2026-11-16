"use client";

import { useEffect, useState } from "react";

interface Where {
  url: string;
  title: string;
  size: string;
  selection: string;
}

function look(): Where {
  return {
    url: window.location.href,
    title: document.title,
    size: `${window.innerWidth}×${window.innerHeight}`,
    selection: window.getSelection()?.toString().trim().slice(0, 120) ?? "",
  };
}

// What the box sends along with a request, read live from this page: select some text or resize the window.
export default function StartHere() {
  const [where, setWhere] = useState<Where | null>(null);

  useEffect(() => {
    const update = () => setWhere(look());
    update();
    window.addEventListener("resize", update);
    document.addEventListener("selectionchange", update);
    return () => {
      window.removeEventListener("resize", update);
      document.removeEventListener("selectionchange", update);
    };
  }, []);

  const rows: [string, string][] = [
    ["page", where?.url ?? ""],
    ["title", where?.title ?? ""],
    ["window", where?.size ?? ""],
    ["selected", where?.selection || "nothing. select some words on this card."],
  ];

  return (
    <div>
      <p style={{ margin: 0, font: "16px/1.4 var(--words)" }}>If you sent a request from here right now, the agent would also get:</p>
      <dl style={{ margin: "10px 0 0", border: "1px solid #000" }}>
        {rows.map(([name, value], index) => (
          <div key={name} style={{ display: "flex", gap: 12, padding: "6px 10px", borderTop: index ? "1px dotted #000" : "none" }}>
            <dt style={{ flex: "none", width: 64, font: "700 12px/1.5 var(--ui)" }}>{name}</dt>
            <dd style={{ margin: 0, minWidth: 0, overflowWrap: "anywhere", font: "13px/1.5 var(--mono)" }}>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
