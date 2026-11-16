import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // Every card has a markdown twin at the same path plus ".md", for agents.
  async rewrites() {
    return [
      { source: "/index.md", destination: "/llms.mdx/index.md" },
      { source: "/:path*.md", destination: "/llms.mdx/:path*.md" },
    ];
  },
};

export default withMDX(config);
