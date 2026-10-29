import { getHostedContext } from "@/hosted/database";
import { handleChatCompletion } from "@/hosted/gateway";
import { HostedError } from "@/hosted/schema";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try { return await handleChatCompletion(request, getHostedContext()); }
  catch (error) { return Response.json({error:{code:error instanceof HostedError?error.code:"GATEWAY_UNAVAILABLE",message:"Hosted inference is unavailable."}}, {status:503}); }
}
