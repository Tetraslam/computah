"use client";

import { useStaticSearch } from "fumadocs-core/search/client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CardEntry } from "./desk";
import { arriveBy, zoom } from "./motion";

interface Hit {
  id: string;
  url: string;
  card: string;
  heading?: string;
  text: string;
}

const strip = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // The index keeps a little markdown; a result is read as plain words.
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

/** Underline the words that matched, without trusting any markup from the index. */
function Marked({ text, query }: { text: string; query: string }) {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 1);
  if (!words.length) return <>{text}</>;
  const pattern = new RegExp(`(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return (
    <>
      {text.split(pattern).map((part, at) =>
        // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one string, in order.
        at % 2 === 1 ? <mark key={at}>{part}</mark> : <span key={at}>{part}</span>,
      )}
    </>
  );
}

/** HyperCard's find, as a floating window: type, and every card that says it is listed. */
export function Find({ cards, from, onClose }: { cards: CardEntry[]; from: DOMRect | null; onClose: () => void }) {
  const router = useRouter();
  const { search, onSearchChange, isLoading, data } = useStaticSearch({ from: "/api/search", delayMs: 80 });
  const [selected, setSelected] = useState(0);
  const field = useRef<HTMLInputElement>(null);
  const windowRef = useRef<HTMLElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useLayoutEffect(() => {
    field.current?.focus();
    if (from && windowRef.current) zoom(from, windowRef.current);
  }, [from]);

  const titles = useMemo(() => new Map(cards.map((card) => [card.url, card.title])), [cards]);
  const ledes = useMemo(() => new Map(cards.map((card) => [card.url, card.description ?? ""])), [cards]);

  const hits: Hit[] = useMemo(() => {
    if (!data || !search.trim()) return [];
    const out: Hit[] = [];
    let heading: string | undefined;
    for (const item of data.items) {
      if ("rows" in item) continue;
      const path = item.url.split("#")[0] || "/";
      const text = strip(item.content);
      if (item.type === "page") {
        heading = undefined;
        out.push({ id: item.id, url: item.url, card: titles.get(path) ?? text, text: ledes.get(path) ?? "" });
        continue;
      }
      if (item.type === "heading") heading = text;
      out.push({ id: item.id, url: item.url, card: titles.get(path) ?? path, heading: item.type === "text" ? heading : undefined, text });
    }
    // A card's lede is indexed twice (as its page and as its text): list each line once.
    const seen = new Set<string>();
    return out
      .filter((hit) => {
        const key = `${hit.card}|${hit.heading ?? ""}|${hit.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 40);
  }, [data, search, titles, ledes]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query starts at the top.
  useEffect(() => setSelected(0), [search]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: keep the chosen result in view whenever the choice moves.
  useEffect(() => {
    list.current?.querySelector("[data-selected]")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const open = (hit: Hit | undefined, element?: Element | null) => {
    if (!hit) return;
    if (element) arriveBy({ kind: "zoom", from: element.getBoundingClientRect() });
    router.push(hit.url);
    onClose();
  };

  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((at) => Math.min(at + 1, Math.max(hits.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((at) => Math.max(at - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      open(hits[selected], list.current?.querySelector("[data-selected]"));
    }
  };

  const query = search.trim();
  const state = !query ? "idle" : isLoading || !data ? "working" : hits.length ? "done" : "none";
  const status =
    state === "idle"
      ? "type some words and every card that has them shows up here"
      : state === "working"
        ? "looking through the cards"
        : state === "done"
          ? `${hits.length === 40 ? "40 or more" : hits.length} found`
          : "no card says that :(";

  return (
    <section ref={windowRef} className="find" role="dialog" aria-label="find" onKeyDown={onKey}>
      <header className="titlebar">
        <button type="button" className="closebox" onClick={onClose} aria-label="close" />
        <span className="title">find</span>
      </header>
      <div className="find-field">
        <input
          ref={field}
          type="text"
          enterKeyHint="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="find what?"
          aria-label="find what?"
          aria-controls="find-results"
          aria-activedescendant={hits[selected] ? `hit-${selected}` : undefined}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <p className="find-status" data-state={state} role="status">
        <span className="mark" aria-hidden="true" />
        {status}
      </p>
      {hits.length > 0 && (
        <ul ref={list} id="find-results" className="find-results" aria-label="results">
          {hits.map((hit, at) => (
            <li key={hit.id}>
              <Link
                id={`hit-${at}`}
                href={hit.url}
                data-selected={at === selected || undefined}
                onMouseEnter={() => setSelected(at)}
                onClick={(event) => {
                  event.preventDefault();
                  open(hit, event.currentTarget);
                }}
              >
                <span className="where">
                  {hit.card}
                  {hit.heading ? `, ${hit.heading}` : ""}
                </span>
                {hit.text && (
                  <span className="what">
                    <Marked text={hit.text} query={query} />
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="find-hint">
        <span className="kbd">↑</span> <span className="kbd">↓</span> to pick, <span className="kbd">return</span> to open,{" "}
        <span className="kbd">esc</span> to close
      </p>
    </section>
  );
}
