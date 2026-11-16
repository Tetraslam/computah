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
