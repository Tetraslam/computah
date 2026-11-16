"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { StackIcon } from "./bitmap";
import { Find } from "./find";
import { arriveBy, keyboardIsBusy, takeArrival, wipe, zoom } from "./motion";

export interface CardEntry {
  url: string;
  title: string;
  description?: string;
}

const markdownUrl = (url: string) => (url === "/" ? "/index.md" : `${url}.md`);

/**
 * Everything around the cards: the menu bar with the contents menu and find, the arrow keys,
 * and how a new card arrives. The cards themselves are server-rendered pages.
 */
export function Desk({ cards }: { cards: CardEntry[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  const [finding, setFinding] = useState(false);
  const findButton = useRef<HTMLButtonElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuList = useRef<HTMLUListElement>(null);
  const index = cards.findIndex((card) => card.url === pathname);
  const previous = index > 0 ? cards[index - 1] : undefined;
  const next = index >= 0 ? cards[index + 1] : undefined;

  // The cards one key away are fetched before the key is pressed.
  useEffect(() => {
    if (previous) router.prefetch(previous.url);
    if (next) router.prefetch(next.url);
  }, [previous, next, router]);

  // A new card arrives the way it was asked for. Runs before paint, so it never flashes in whole first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per card, on the path change itself.
  useLayoutEffect(() => {
    const arrival = takeArrival();
    const card = document.querySelector<HTMLElement>(".card");
    if (!arrival || !card) return;
    if (arrival.kind === "wipe") wipe(card, arrival.toward);
    else zoom(arrival.from, card);
  }, [pathname]);

  const go = useCallback(
    (card: CardEntry | undefined, toward: "next" | "previous") => {
      if (!card) return;
      arriveBy({ kind: "wipe", toward });
      router.push(card.url);
    },
    [router],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (menu) {
          setMenu(false);
          menuButton.current?.focus();
        }
        return;
      }
      if (finding || keyboardIsBusy(event)) return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        go(next, "next");
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        go(previous, "previous");
      } else if (event.key === "/") {
        event.preventDefault();
        setMenu(false);
        setFinding(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finding, menu, next, previous, go]);

  // The contents menu closes on any click outside it.
  useEffect(() => {
    if (!menu) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuList.current?.contains(target) && !menuButton.current?.contains(target)) setMenu(false);
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [menu]);

  const onMenuKey = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...(menuList.current?.querySelectorAll("a") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLAnchorElement);
    const to = event.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[to]?.focus();
  };

  const openMenu = () => {
    setMenu((open) => !open);
  };

  useEffect(() => {
    if (menu) menuList.current?.querySelector<HTMLAnchorElement>("a[data-active], a")?.focus();
  }, [menu]);

  return (
    <>
      <nav className="menubar" aria-label="the stack">
        <Link href="/" className="menu-item" aria-label="computah, the home card">
          <StackIcon />
          <span>computah</span>
        </Link>
        <div style={{ position: "relative", display: "flex" }}>
          <button
            ref={menuButton}
            type="button"
            className="menu-item"
            aria-expanded={menu}
            aria-haspopup="true"
            onClick={openMenu}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setMenu(true);
              }
            }}
          >
            cards
          </button>
          {menu && (
            <ul ref={menuList} className="menu" onKeyDown={onMenuKey}>
              {cards.map((card, at) => (
                <li key={card.url}>
                  <Link
                    href={card.url}
                    data-active={card.url === pathname || undefined}
                    aria-current={card.url === pathname ? "page" : undefined}
                    onClick={(event) => {
                      arriveBy({ kind: "zoom", from: event.currentTarget.getBoundingClientRect() });
                      setMenu(false);
                    }}
                  >
                    <span aria-hidden="true">{card.url === pathname ? "✓" : ""}</span>
                    <span>{card.title}</span>
                    <span className="number">{at + 1}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          ref={findButton}
          type="button"
          className="menu-item"
          aria-expanded={finding}
          onClick={() => {
            setMenu(false);
            setFinding((open) => !open);
          }}
        >
          find
        </button>
        <span className="spacer" />
        {index >= 0 && (
          <a className="menu-item menu-quiet" href={markdownUrl(pathname)} title="this card as markdown, for agents">
            .md
          </a>
        )}
        <a className="menu-item menu-quiet" href="/llms.txt" title="the whole stack, for agents">
          llms.txt
        </a>
      </nav>
      {finding && (
        <Find
          cards={cards}
          from={findButton.current?.getBoundingClientRect() ?? null}
          onClose={() => {
            setFinding(false);
            findButton.current?.focus();
          }}
        />
      )}
    </>
  );
}
