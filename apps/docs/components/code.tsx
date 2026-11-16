"use client";

import { type ComponentProps, isValidElement, useRef, useState } from "react";

const LANGUAGES: Record<string, string> = {
  sh: "shell",
  bash: "shell",
  tsx: "tsx",
  ts: "typescript",
  js: "javascript",
  json: "json",
  txt: "text",
};

/** A code block: black on white in a 1px frame, its name on a strip above, and a copy button. */
export function Code({ title, children, className, ...rest }: ComponentProps<"pre"> & { title?: string; icon?: string }) {
  const pre = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const inner = isValidElement<{ className?: string }>(children) ? children.props.className : undefined;
  const language = /language-(\w+)/.exec(`${className ?? ""} ${inner ?? ""}`)?.[1];
  const label = title ?? (language ? (LANGUAGES[language] ?? language) : "");
  // Shiki's own colors and focus trap are dropped: the theme is black on white anyway.
  const { style: _style, tabIndex: _tabIndex, icon: _icon, ...props } = rest as typeof rest & { icon?: string };

  const copy = async () => {
    const text = pre.current?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text.replace(/\n$/, ""));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // No clipboard (an insecure page): the text can still be selected by hand.
    }
  };

  return (
    <figure className="code">
      <figcaption className="code-head">
        <span>{label}</span>
        <span className="spacer" />
        <button type="button" className="push small" data-on={copied || undefined} onClick={copy} aria-live="polite">
          {copied ? "copied" : "copy"}
        </button>
      </figcaption>
      <pre ref={pre} className={className} {...props}>
        {children}
      </pre>
    </figure>
  );
}
