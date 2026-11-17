import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CardNav } from "@/components/card-nav";
import { mdxComponents } from "@/components/mdx";
import { position, source, stack } from "@/lib/source";

export default async function CardPage(props: PageProps<"/[[...slug]]">) {
  const { slug } = await props.params;
  const card = source.getPage(slug);
  if (!card) notFound();
  const { index, total, previous, next } = position(card);
  const entry = (other: typeof previous) => other && { url: other.url, title: other.data.title };
  const Body = card.data.body;
  const home = index === 0;

  return (
    <main className={home ? "desk" : "desk with-stack"}>
      {/* On a doc card the whole stack stays listed on the left, so any card is one click away. */}
      {!home && (
        <nav className="stack-list" aria-label="cards">
          <div className="titlebar">
            <span className="title">cards</span>
          </div>
          <ol>
            {stack().map((other, at) => (
              <li key={other.url}>
                <Link href={other.url} aria-current={other.url === card.url ? "page" : undefined}>
                  <span className="number">{at + 1}</span>
                  {other.data.title}
                </Link>
              </li>
            ))}
          </ol>
          <p className="stack-hint">type a card's number to jump to it</p>
        </nav>
      )}
      <article className={home ? "card home" : "card"}>
        <header>
          <h1 className="card-title">{card.data.title}</h1>
          {card.data.description && <p className="card-lede">{card.data.description}</p>}
          <hr className="rule" />
        </header>
        <div className="prose">
          <Body components={mdxComponents} />
        </div>
        <CardNav previous={entry(previous)} next={entry(next)} index={index} total={total} />
      </article>
    </main>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export const dynamicParams = false;

export async function generateMetadata(props: PageProps<"/[[...slug]]">): Promise<Metadata> {
  const { slug } = await props.params;
  const card = source.getPage(slug);
  if (!card) notFound();
  return {
    title: slug?.length ? card.data.title : { absolute: "computah" },
    description: card.data.description,
    alternates: { types: { "text/markdown": card.url === "/" ? "/index.md" : `${card.url}.md` } },
  };
}
