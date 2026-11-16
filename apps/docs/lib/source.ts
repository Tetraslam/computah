import { llms, loader } from "fumadocs-core/source";
import { docs } from "@/.source/server";
import { changesMarkdown, readChanges } from "./changes";

export const source = loader({
  baseUrl: "/",
  source: docs.toFumadocsSource(),
});

export type Card = NonNullable<ReturnType<typeof source.getPage>>;

/** The cards in stack order, as the contents list and the arrows walk them. */
export function stack(): Card[] {
  const order: Card[] = [];
  const walk = (nodes: (typeof source.pageTree)["children"]) => {
    for (const node of nodes) {
      if (node.type === "page") {
        const page = source.getNodePage(node);
        if (page) order.push(page);
      } else if (node.type === "folder") {
        if (node.index) {
          const page = source.getNodePage(node.index);
          if (page) order.push(page);
        }
        walk(node.children);
      }
    }
  };
  walk(source.pageTree.children);
  return order;
}

export function position(card: Card) {
  const cards = stack();
  const index = cards.findIndex((other) => other.url === card.url);
  return { index, total: cards.length, previous: cards[index - 1], next: cards[index + 1] };
}

export const markdownUrl = (url: string) => (url === "/" ? "/index.md" : `${url}.md`);

export async function cardMarkdown(card: Card): Promise<string> {
  let body = await card.data.getText("processed");
  body = body
    .replace(/<Changes\s*\/>/, () => changesMarkdown(readChanges()))
    .replace(/<Contents\s*\/>/, () =>
      stack()
        .slice(1)
        .map((other, at) => `${at + 2}. [${other.data.title}](${markdownUrl(other.url)}): ${other.data.description ?? ""}`)
        .join("\n"),
    )
    .replace(/<Recording\s*\/>/, "![Typing a request into the box and watching a counter become a stopwatch](/demo.gif)")
    .replace(
      /<Playground name="([a-z-]+)"\s*\/>/g,
      "_On the web page, a small interactive piece sits here (`apps/docs/playground/$1.tsx`). Visitors can change it by typing into the box._",
    )
    .replace(/<Note title="([^"]*)">\n?([\s\S]*?)\n?<\/Note>/g, (_, title: string, text: string) =>
      [`**${title}:**`, ...text.trim().split("\n")].map((line) => (line ? `> ${line}` : ">")).join("\n"),
    )
    // Fumadocs keeps each heading's id as "[#id]"; agents don't need it.
    .replace(/^(#{1,6} .*?) \[#[\w-]+\]$/gm, "$1");
  const intro = card.data.description ? `${card.data.description}\n\n` : "";
  return `# ${card.data.title}\n\n${intro}${body.trim()}\n`;
}

export const agentFiles = llms(source, {
  renderPage: cardMarkdown,
});
