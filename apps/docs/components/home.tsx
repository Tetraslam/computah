import Link from "next/link";
import { stack } from "@/lib/source";

/** The demo recording, held still for anyone who asked for less motion. */
export function Recording() {
  return (
    <figure style={{ margin: 0 }}>
      <picture className="recording">
        <source srcSet="/demo-still.png" media="(prefers-reduced-motion: reduce)" />
        <img
          src="/demo.gif"
          width={560}
          height={608}
          alt="Typing a request into the box and watching a counter on the page become a stopwatch."
        />
      </picture>
      <figcaption className="recording-caption">me asking for a stopwatch and watching the counter turn into one</figcaption>
    </figure>
  );
}

/**
 * Patrick Collison's post that this library came from, quoted as words on the card. It's drawn
 * here and not loaded from X, so the page asks nothing of anyone else's servers to show it.
 */
export function Post() {
  return (
    <figure className="post">
      <figcaption className="post-head">
        <span className="post-who">
          <b>Patrick Collison</b> @patrickc
        </span>
        <time dateTime="2026-10-31">oct 31, 2026</time>
      </figcaption>
      <blockquote className="post-words" cite="https://x.com/patrickc/status/2116636967517798672">
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
      </blockquote>
      <a className="post-more" href="https://x.com/patrickc/status/2116636967517798672" rel="noreferrer">
        the rest of it is on x
      </a>
    </figure>
  );
}

/** Every card after this one, as a list of buttons that invert. */
export function Contents() {
  const cards = stack().slice(1);
  return (
    <ol className="contents">
      {cards.map((card, at) => (
        <li key={card.url}>
          <Link href={card.url}>
            <span className="number">{at + 2}</span>
            <span className="name">{card.data.title}</span>
            <span className="about">{card.data.description}</span>
          </Link>
        </li>
      ))}
    </ol>
  );
}
