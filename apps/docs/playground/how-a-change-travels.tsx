"use client";

import { useState } from "react";

interface Step {
  name: string;
  says: string;
}

// The road a change takes when the runner serves the app. Flip "the build fails" to see the fix loop.
function road(fails: boolean, tries: number): Step[] {
  const steps: Step[] = [
    { name: "waits", says: "your request waits for the one before it to finish" },
    { name: "live copy", says: "you get moved onto a hot-reloading copy and watch the agent work, and nobody else sees it" },
    { name: "commit", says: "the agent finishes and its change becomes one commit on your version's branch" },
    { name: "build", says: "a fresh copy gets installed, built and started on a free port" },
  ];
  if (fails) {
    for (let attempt = 1; attempt <= Math.min(tries, 3); attempt++) {
      steps.push({ name: `fix ${attempt}`, says: `it didn't build, so the agent gets the error and tries again (try ${attempt})` });
    }
    if (tries > 3) {
      steps.push({
        name: "revert",
        says: "three tries and it still doesn't build, so the whole change comes back out and nobody else ever saw it",
      });
      return steps;
    }
  }
  steps.push({
    name: "swap",
    says: "the next page anyone loads comes from the new build, and pages already open keep the copy that served them",
  });
  return steps;
}

export default function HowAChangeTravels() {
  const [at, setAt] = useState(0);
  const [fails, setFails] = useState(false);
  const [tries, setTries] = useState(1);
  const steps = road(fails, tries);
  const step = Math.min(at, steps.length - 1);

  return (
    <div>
      <ol style={{ display: "flex", flexWrap: "wrap", gap: 6, listStyle: "none", margin: 0, padding: 0 }}>
        {steps.map((each, index) => (
          <li key={each.name}>
            <button
              type="button"
              className="push small"
              data-on={index === step || undefined}
              onClick={() => setAt(index)}
              style={{ borderStyle: index > step ? "dotted" : "solid" }}
            >
              {each.name}
            </button>
          </li>
        ))}
      </ol>
      <p style={{ margin: "14px 0 0", minHeight: "2.8em", font: "16px/1.4 var(--words)" }}>{steps[step]?.says}</p>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
        <button type="button" className="push" onClick={() => setAt(Math.max(step - 1, 0))} disabled={step === 0}>
          back
        </button>
        <button type="button" className="push default" onClick={() => setAt(Math.min(step + 1, steps.length - 1))}>
          next
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={fails}
          className="push"
          data-on={fails || undefined}
          onClick={() => setFails(!fails)}
          style={{ marginLeft: "auto" }}
        >
          the build fails
        </button>
      </div>
      {fails && (
        <fieldset
          aria-label="Fixed on which try?"
          style={{ display: "flex", alignItems: "center", gap: 6, margin: "10px 0 0", padding: 0, border: 0 }}
        >
          <span style={{ font: "12px/1 var(--ui)", marginRight: 4 }}>fixed on try</span>
          {[1, 2, 3, 4].map((each) => (
            <button
              key={each}
              type="button"
              aria-pressed={each === tries}
              className="push small"
              data-on={each === tries || undefined}
              onClick={() => setTries(each)}
            >
              {each > 3 ? "never" : each}
            </button>
          ))}
        </fieldset>
      )}
    </div>
  );
}
