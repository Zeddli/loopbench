import {
  listPublishedSnapshots,
  getLatestPublishedSnapshot,
} from "@/hosted/publication";
import { HostedError } from "@/hosted/schema";
import { listOwnedCampaigns } from "@/hosted/evolution";
import { hostedRoute, requireSession } from "@/hosted/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  const seed = new URL(request.url).searchParams.get("latestForSnapshot");
  if (seed)
    return hostedRoute((context) => {
      const snapshot = getLatestPublishedSnapshot(seed, context);
      if (!snapshot)
        throw new HostedError(
          "NOT_FOUND",
          "The requested resource was not found.",
          404,
        );
      return snapshot;
    });
  return hostedRoute((context) =>
    new URL(request.url).searchParams.get("scope") === "mine"
      ? listOwnedCampaigns(
          { ownerScope: requireSession(request, context).ownerScope },
          context,
        ).map((campaign) => ({
          id: campaign.id,
          modelId: campaign.modelId,
          harnessId: campaign.harnessId,
          benchmarkId: campaign.benchmarkId,
          status: campaign.status,
          waitReason: campaign.waitReason,
          revision: campaign.revision,
        }))
      : listPublishedSnapshots(context),
  );
}
