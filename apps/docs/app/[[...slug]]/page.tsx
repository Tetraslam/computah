import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CardNav } from "@/components/card-nav";
import { mdxComponents } from "@/components/mdx";
import { position, source } from "@/lib/source";

export default async function CardPage(props: PageProps<"/[[...slug]]">) {
  const { slug } = await props.params;
  const card = source.getPage(slug);
  if (!card) notFound();
  const { index, total, previous, next } = position(card);
  const entry = (other: typeof previous) => other && { url: other.url, title: other.data.title };
  const Body = card.data.body;
  const home = index === 0;

  return (
    <main className="desk">
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
