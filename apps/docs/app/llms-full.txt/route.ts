import { agentFiles } from "@/lib/source";

export const revalidate = false;

export async function GET() {
  return (await agentFiles.serve("/llms-full.txt")) ?? new Response(null, { status: 404 });
}
