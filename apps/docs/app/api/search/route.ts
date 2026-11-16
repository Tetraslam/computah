import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

// The whole index is built once and downloaded by the find window, which searches it in the browser.
export const revalidate = false;
export const { staticGET: GET } = createFromSource(source, { language: "english" });
