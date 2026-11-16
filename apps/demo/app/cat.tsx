"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";

// Seconds of no press before the cat meows, and the words for each escalation.
const IDLE_MS = 10_000;
const LINES = ["meow.", "MEOW.", "MEOW! MEOW!", "MEOW MEOW MEOW!!"];

// A short synthesized meow. Louder and longer the more it has been ignored.
function meow(ctx: AudioContext, level: number) {
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const peak = Math.min(0.04 + level * 0.04, 0.25);
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(640, t);
  osc.frequency.linearRampToValueAtTime(980, t + 0.16);
  osc.frequency.linearRampToValueAtTime(420, t + 0.5);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(peak, t + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.6);
}

export function Cat() {
  // level 0 right after a press; each idle window after that bumps it by one.
  // A new object on every press restarts the idle timer.
  const [run, setRun] = useState({ level: 0 });
  const level = run.level;
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".push")) {
        setRun({ level: 0 });
      }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  useEffect(() => {
    const id = window.setTimeout(
      () => setRun({ level: run.level + 1 }),
      IDLE_MS,
    );
    return () => window.clearTimeout(id);
  }, [run]);

  useEffect(() => {
    if (level === 0) return;
    try {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      ctxRef.current ??= new Ctx();
      if (ctxRef.current.state === "suspended") void ctxRef.current.resume();
      meow(ctxRef.current, level);
    } catch {
      // No audio here; the speech bubble still says it.
    }
  }, [level]);

  const awake = level > 0;
  const mouth = Math.min(level, 3);
  const line = LINES[Math.min(Math.max(level, 1), LINES.length) - 1];
  const bounce = Math.max(1.1 - level * 0.2, 0.35);

  return (
    <div className="flex items-end gap-4">
      <svg
        viewBox="0 0 96 88"
        width="96"
        height="88"
        aria-hidden="true"
        className={awake ? "cat cat-awake shrink-0" : "cat shrink-0"}
        style={{ "--bounce": `${bounce}s` } as CSSProperties}
      >
        {/* ears */}
        <polygon
          points="20,40 24,10 42,30"
          fill="#fff"
          stroke="#000"
          strokeWidth="3"
          strokeLinejoin="round"
        />
        <polygon
          points="76,40 72,10 54,30"
          fill="#fff"
          stroke="#000"
          strokeWidth="3"
          strokeLinejoin="round"
        />
        {/* head */}
        <ellipse
          cx="48"
          cy="52"
          rx="30"
          ry="25"
          fill="#fff"
          stroke="#000"
          strokeWidth="3"
        />
        {/* eyes: closed while asleep, open once it wants you */}
        {awake ? (
          <>
            <circle cx="37" cy="46" r="3.5" fill="#000" />
            <circle cx="59" cy="46" r="3.5" fill="#000" />
          </>
        ) : (
          <>
            <path
              d="M32 47 Q37 51 42 47"
              fill="none"
              stroke="#000"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
            <path
              d="M54 47 Q59 51 64 47"
              fill="none"
              stroke="#000"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          </>
        )}
        {/* nose and mouth open wider with each meow */}
        <polygon points="45,55 51,55 48,58" fill="#000" />
        {awake ? (
          <ellipse
            cx="48"
            cy="64"
            rx={2.5 + mouth * 0.6}
            ry={1.5 + mouth * 0.9}
            fill="#000"
          />
        ) : (
          <path
            d="M48 58 Q44 63 40 60 M48 58 Q52 63 56 60"
            fill="none"
            stroke="#000"
            strokeWidth="2"
            strokeLinecap="round"
          />
        )}
        {/* whiskers */}
        <path
          d="M18 54 L4 50 M18 60 L4 62 M78 54 L92 50 M78 60 L92 62"
          stroke="#000"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      {awake ? (
        <p
          key={level}
          role="status"
          className="cat-say relative mb-3 border border-black bg-white px-3 py-1.5 font-ui text-[13px] font-bold"
        >
          {line}
        </p>
      ) : (
        <p className="mb-3 font-ui text-[13px] italic">zzz</p>
      )}
    </div>
  );
}
