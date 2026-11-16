import { agentFiles } from "@/lib/source";

export const revalidate = false;
export const dynamicParams = false;

/** Every card as markdown, at its own path plus ".md" (see the rewrites in next.config.mjs). */
export async function GET(_request: Request, { params }: RouteContext<"/llms.mdx/[...path]">) {
  const { path } = await params;
  return (await agentFiles.serve(`/${path.join("/")}`)) ?? new Response("No such card.\n", { status: 404 });
}

export async function generateStaticParams() {
  const params: { path: string[] }[] = [];
  for (const file of await agentFiles.files()) {
    if (!/^\/llms(-full)?\.txt$/.test(file)) params.push({ path: decodeURI(file).slice(1).split("/") });
  }
  return params;
}
