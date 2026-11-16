"use client";

import { useState } from "react";

type Level = "owner" | "trusted" | "member" | "visitor";

const levels: Level[] = ["owner", "trusted", "member", "visitor"];

// What each level may do, as the runner decides it.
const abilities: { what: string; who: Level[] }[] = [
  { what: "sees the box", who: ["owner", "trusted", "member"] },
  { what: "changes the app for everyone", who: ["owner", "trusted"] },
  { what: "changes a version of their own", who: ["owner", "trusted", "member"] },
  { what: "undoes their own changes", who: ["owner", "trusted", "member"] },
  { what: "undoes any change to everyone's version", who: ["owner", "trusted"] },
  { what: "undoes changes to other people's own versions", who: ["owner"] },
  { what: "makes someone's version everyone's", who: ["owner"] },
  { what: "has a daily limit", who: ["member"] },
];

export default function PeopleAndTrust() {
  const [level, setLevel] = useState<Level>("member");

  return (
    <div>
      <fieldset aria-label="Who are you?" style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: 0, padding: 0, border: 0 }}>
        {levels.map((each) => (
          <button
            key={each}
            type="button"
            aria-pressed={each === level}
            className="push"
            data-on={each === level || undefined}
            onClick={() => setLevel(each)}
          >
            {each}
          </button>
        ))}
      </fieldset>
      <ul style={{ listStyle: "none", margin: "14px 0 0", padding: 0 }}>
        {abilities.map((ability) => {
          const yes = ability.who.includes(level);
          return (
            <li
              key={ability.what}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "5px 0",
                borderTop: "1px dotted #000",
                font: "15px/1.3 var(--words)",
                textDecoration: yes ? "none" : "line-through",
              }}
            >
              <span
                aria-hidden="true"
                style={{ flex: "none", width: 10, height: 10, border: "1px solid #000", background: yes ? "#000" : "#fff" }}
              />
              <span>{ability.what}</span>
              <span style={{ marginLeft: "auto", font: "700 11px/1 var(--ui)" }}>{yes ? "yes" : "no"}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
