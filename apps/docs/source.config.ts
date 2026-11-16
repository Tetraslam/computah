import { pageSchema } from "fumadocs-core/source/schema";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { onebit } from "./lib/onebit";
import { rehypeCellLabels } from "./lib/rehype-cell-labels";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: pageSchema,
    postprocess: { includeProcessedMarkdown: true },
  },
});

export default defineConfig({
  mdxOptions: {
    // One 1-bit theme in place of the default pair, its styles inlined; the language as a class for the code strip.
    rehypeCodeOptions: { themes: { light: onebit }, defaultColor: "light", addLanguageClass: true, icon: false },
    rehypePlugins: [rehypeCellLabels],
  },
});
