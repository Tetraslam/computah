"use client";

import { useState } from "react";

interface Caller {
  name: string;
  answer: string | null;
}

// Who the development runner answers, and what it says to everyone else. The reasons are the runner's own words.
const callers: Caller[] = [
  { name: "your app, on this machine", answer: null },
  { name: "another website in your browser", answer: "This page isn't allowed to use the runner." },
  { name: "another computer on your network", answer: "Only this machine may use the runner unless a secret is set." },
  { name: "a site pretending to be this machine", answer: "Unexpected Host header." },
  { name: "a request without the box's header", answer: "Missing x-computah header." },
  { name: "with --secret set, a wrong secret", answer: "Wrong or missing secret." },
];

export default function Safety() {
  const [chosen, setChosen] = useState(0);
  const caller = callers[chosen] ?? callers[0];

  return (
    <div>
      <p style={{ margin: 0, font: "16px/1.4 var(--words)" }}>Who's asking the runner to change your code?</p>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6, marginTop: 10 }}>
        {callers.map((each, index) => (
          <button
            key={each.name}
            type="button"
            className="push"
            data-on={index === chosen || undefined}
            aria-pressed={index === chosen}
            onClick={() => setChosen(index)}
          >
            {each.name}
          </button>
        ))}
      </div>
      <div
        role="status"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginTop: 14,
          padding: "8px 10px",
          border: "1px solid #000",
          background: caller?.answer ? "#fff" : "#000",
          color: caller?.answer ? "#000" : "#fff",
          font: "15px/1.35 var(--words)",
        }}
      >
        <span style={{ font: "700 12px/1 var(--ui)" }}>{caller?.answer ? "refused" : "answered"}</span>
        <span>{caller?.answer ?? "The runner takes the request and hands it to the agent."}</span>
      </div>
    </div>
  );
}
