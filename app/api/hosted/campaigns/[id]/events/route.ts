import { readCampaignEvents } from "@/hosted/events";
import { hostedRoute, requireSession } from "@/hosted/http";
import { HostedError } from "@/hosted/schema";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return hostedRoute(async (context) => {
    const session = requireSession(request, context);
    const { id } = await params;
    const page = readCampaignEvents(
      {
        ownerScope: session.ownerScope,
        campaignId: id,
        after: new URL(request.url).searchParams.get("after"),
        limit: 100,
      },
      context,
    );
    const accept = request.headers.get("accept") ?? "*/*";
    if (!accept.includes("application/json") && !accept.includes("*/*"))
      throw new HostedError(
        "UNSUPPORTED_TRANSPORT",
        "Use application/json for event polling.",
        406,
      );
    return {
      items: page.items,
      nextCursor: page.nextCursor,
      resetRequired: page.resetRequired,
      snapshotUrl: `/api/hosted/campaigns/${id}`,
    };
  });
}
