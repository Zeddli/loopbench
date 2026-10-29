import { z } from "zod";
import { listOwnedCampaigns, startHostedCampaign } from "@/hosted/evolution";
import {
  hostedJson,
  hostedRoute,
  readBody,
  requireMutation,
  requireSession,
} from "@/hosted/http";
import { parseUsdMicros } from "@/hosted/schema";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function summary(campaign: Awaited<ReturnType<typeof startHostedCampaign>>) {
  return {
    id: campaign.id,
    status: campaign.status,
    waitReason: campaign.waitReason,
    revision: campaign.revision,
    modelId: campaign.modelId,
    benchmarkId: campaign.benchmarkId,
    harnessId: campaign.harnessId,
    desiredControl: campaign.desiredControl,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
  };
}
export function GET(request: Request) {
  return hostedRoute((context) =>
    listOwnedCampaigns(
      { ownerScope: requireSession(request, context).ownerScope },
      context,
    ).map(summary),
  );
}
export function POST(request: Request) {
  return hostedRoute(async (context) => {
    const { session, idempotencyKey } = requireMutation(request, context);
    const body = await readBody(
      request,
      z
        .object({
          schemaVersion: z.literal(1),
          credentialId: z.uuid(),
          modelId: z.string().min(1).max(200),
          harnessId: z.enum(["pi-1.4.0", "pi-1.4.0-tokenfactory"]),
          benchmarkId: z.literal("coding-adversarial-v1"),
          inferenceAllowanceUsdMicros: z.string().regex(/^[1-9][0-9]{0,5}$/),
          acceptedPricingSnapshotId: z.uuid(),
          consent: z.literal(true),
        })
        .strict(),
    );
    const campaign = await startHostedCampaign(
      {
        ownerScope: session.ownerScope,
        credentialId: body.credentialId,
        modelId: body.modelId,
        harnessId: body.harnessId,
        benchmarkId: body.benchmarkId,
        inferenceAllowanceUsdMicros: parseUsdMicros(
          body.inferenceAllowanceUsdMicros,
        ),
        acceptedPricingSnapshotId: body.acceptedPricingSnapshotId,
        idempotencyKey,
      },
      context,
    );
    return hostedJson(
      {
        campaignId: campaign.id,
        status: campaign.status,
        revision: campaign.revision,
        snapshotUrl: `/api/hosted/campaigns/${campaign.id}`,
        eventsUrl: `/api/hosted/campaigns/${campaign.id}/events`,
      },
      202,
    );
  });
}
