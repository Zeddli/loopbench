import { listCampaigns } from "@/core/campaigns";
import { isHostedMode } from "@/hosted/http";
export const dynamic = "force-dynamic";
export async function GET() {
  if (isHostedMode())
    return Response.json(
      { error: "Not found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  return Response.json(await listCampaigns(), {
    headers: { "Cache-Control": "no-store" },
  });
}
