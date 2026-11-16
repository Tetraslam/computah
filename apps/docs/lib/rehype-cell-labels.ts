/**
 * Give every table cell its column's header as `data-label`, so on a phone a table can stack
 * into one block per row and still say which column each value came from.
 */
interface Node {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
}

const text = (node: Node): string => (node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(text).join(""));

const elements = (node: Node, tag: string): Node[] => {
  const found: Node[] = [];
  const walk = (current: Node) => {
    if (current.type === "element" && current.tagName === tag) found.push(current);
    else for (const child of current.children ?? []) walk(child);
  };
  for (const child of node.children ?? []) walk(child);
  return found;
};

export function rehypeCellLabels() {
  return (tree: Node) => {
    for (const table of elements(tree, "table")) {
      const headers = elements(table, "th").map((cell) => text(cell).trim());
      for (const row of elements(table, "tr")) {
        elements(row, "td").forEach((cell, column) => {
          cell.properties = { ...cell.properties, dataLabel: headers[column] ?? "" };
        });
      }
    }
  };
}
