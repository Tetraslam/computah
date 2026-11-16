import { agentFiles } from "@/lib/source";

export const revalidate = false;

export async function GET() {
  return (await agentFiles.serve("/llms.txt")) ?? new Response(null, { status: 404 });
}
