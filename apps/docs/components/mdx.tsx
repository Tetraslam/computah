import type { MDXComponents } from "mdx/types";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { Changes } from "./changes";
import { Code } from "./code";
import { Contents, Recording } from "./home";
import { Playground } from "./playground";
import { Post } from "./post";

/** A boxed aside with its label knocked out of a dithered strip. Used for what isn't done yet. */
function Note({ title = "note", children }: { title?: string; children: ReactNode }) {
  return (
    <aside className="note">
      <div className="note-head">
        <span>{title}</span>
      </div>
      <div className="note-body">{children}</div>
    </aside>
  );
}

function Anchor({ href = "", ...props }: ComponentProps<"a">) {
  if (href.startsWith("/") || href.startsWith("#")) return <Link href={href} {...props} />;
  return <a href={href} rel="noreferrer" {...props} />;
}

export const mdxComponents: MDXComponents = {
  pre: Code,
  a: Anchor,
  table: (props) => (
    <div className="table-frame">
      <table {...props} />
    </div>
  ),
  Note,
  Changes,
  Contents,
  Recording,
  Post,
  Playground,
};

declare global {
  type MDXProvidedComponents = typeof mdxComponents;
}
