import { listTrees } from "@/core/store";
import { isHostedMode } from "@/hosted/http";
export const dynamic = "force-dynamic";
export async function GET() {
  if (isHostedMode())
    return Response.json(
      { error: "Not found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  return Response.json(await listTrees(), {
    headers: { "Cache-Control": "no-store" },
  });
}
