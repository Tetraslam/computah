"use client";

import { useEffect, useRef } from "react";

const WIDGETS = "https://platform.twitter.com/widgets.js";
const URL = "https://twitter.com/patrickc/status/2116636967517798672";

/**
 * Patrick Collison's post that this library came from, as X's own embed. The words are in the
 * page too, so they're what shows until X's script has run, or if it never does (it's blocked
 * for a lot of people).
 */
export function Post() {
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const twitter = (window as { twttr?: { widgets?: { load(within?: Element | null): void } } }).twttr;
    // Coming back to this card: the script is already here, so ask it to draw this one again.
    if (twitter?.widgets) return void twitter.widgets.load(frame.current);
    if (document.querySelector(`script[src="${WIDGETS}"]`)) return;
    const script = document.createElement("script");
    script.src = WIDGETS;
    script.async = true;
    document.body.appendChild(script);
  }, []);

  return (
    <div className="post" ref={frame}>
      <blockquote className="twitter-tweet" data-dnt="true" data-theme="light" cite={URL}>
        <p>
          I'm now building an "improvements" feature into all of my personal vibecoded applications: a freeform text input that's hooked up
          to an agent that yolo implements whatever is submitted.
        </p>
        <p>
          It's an interesting experience -- the activation energy barrier to sanding any rough edge or implementing any new feature becomes
          extremely low. Someone else who uses one of the applications I created has already implemented 150 improvements over the course of
          a few days. This pattern feels like a new kind of tool -- liquid software? -- and every application that doesn't have this feature
          now has a slightly rigid and anachronistic flavor. Why can't I just tell it how I want it to be different?
        </p>
        <footer>
          Patrick Collison (@patrickc), <a href={URL}>oct 31, 2026</a>
        </footer>
      </blockquote>
    </div>
  );
}
