import { transform } from "sucrase";
import { AppError } from "./app.js";

/** What a piece may import. Anything else needs the app's bundler, so that change gets a full build. */
const PROVIDED = new Set(["react", "react/jsx-runtime"]);

/**
 * A piece is one file of the app holding one browser-only React component that imports nothing
 * but react. A file like that doesn't need the app rebuilt to be changed: it's compiled alone,
 * in milliseconds, and the page swaps it into the build that is already running.
 *
 * Returns the script the page loads, or null when the file isn't self-contained and so can't be
 * served this way. Throws what a build would have thrown when the file doesn't parse.
 */
export function compilePiece(id: string, file: string, source: string): string | null {
  // A dynamic import would be resolved by the browser, which knows nothing of the app's modules.
  if (/\bimport\s*\(/.test(source)) return null;
  let code: string;
  try {
    code = transform(source, {
      transforms: ["typescript", "jsx", "imports"],
      jsxRuntime: "automatic",
      production: true,
      filePath: file,
    }).code;
  } catch (error) {
    throw new AppError(`${file} doesn't parse. ${error instanceof Error ? error.message : ""}`.trim());
  }
  for (const [, , name] of code.matchAll(/\brequire\((['"])([^'"]+)\1\)/g)) if (!PROVIDED.has(name as string)) return null;
  if (!/\bexports\.default\b|exports\s*,\s*['"]default['"]/.test(code)) throw new AppError(`${file} has to export a default component.`);
  return `(globalThis.__computahPieces=globalThis.__computahPieces||{})[${JSON.stringify(id)}]=function(require,module,exports,process){\n${code}\n};\n`;
}
