/**
 * A shiki theme for a 1-bit screen: every token is black on white. Structure is shown
 * the way a Macintosh text editor could show it, with weight and slant, never with color.
 */
export const onebit = {
  name: "onebit",
  type: "light" as const,
  fg: "#000000",
  bg: "#ffffff",
  colors: { "editor.foreground": "#000000", "editor.background": "#ffffff" },
  tokenColors: [
    { settings: { foreground: "#000000", background: "#ffffff" } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#000000", fontStyle: "italic" } },
    {
      scope: ["keyword", "storage", "storage.type", "storage.modifier", "keyword.control", "keyword.operator.new", "variable.language"],
      settings: { foreground: "#000000", fontStyle: "bold" },
    },
  ],
};
