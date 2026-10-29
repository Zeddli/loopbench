import { getCampaignProjection } from "@/hosted/evolution";
import { getPublishedSnapshot } from "@/hosted/publication";
import { hostedRoute, notFound, requireSession } from "@/hosted/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return hostedRoute(async (context) => {
    const { id } = await params;
    const snapshotId = new URL(request.url).searchParams.get("snapshotId");
    if (snapshotId) {
      const snapshot = getPublishedSnapshot(snapshotId, context);
      if (!snapshot || snapshot.campaignId !== id) return notFound();
      return snapshot;
    }
    const session = requireSession(request, context);
    return getCampaignProjection(
      { ownerScope: session.ownerScope, campaignId: id },
      context,
    );
  });
}
