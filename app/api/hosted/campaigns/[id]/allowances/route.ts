import { z } from "zod";
import { approveInferenceAllowance } from "@/hosted/budget";
import { getCampaign } from "@/hosted/store";
import {
  hostedJson,
  hostedRoute,
  notFound,
  readBody,
  requireMutation,
} from "@/hosted/http";
import { parseUsdMicros } from "@/hosted/schema";
export const runtime = "nodejs";
export function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return hostedRoute(async (context) => {
    const { id } = await params;
    const { session, idempotencyKey } = requireMutation(request, context);
    if (
      !getCampaign({ ownerScope: session.ownerScope, campaignId: id }, context)
    )
      return notFound();
    const body = await readBody(
      request,
      z
        .object({
          schemaVersion: z.literal(1),
          kind: z.literal("inference"),
          expectedRevision: z.number().int().positive(),
          newLimitUsdMicros: z.string().regex(/^[1-9][0-9]{0,5}$/),
          acceptedPricingSnapshotId: z.uuid(),
        })
        .strict(),
    );
    const result = approveInferenceAllowance(
      {
        ownerScope: session.ownerScope,
        campaignId: id,
        expectedRevision: body.expectedRevision,
        newLimitUsdMicros: parseUsdMicros(body.newLimitUsdMicros),
        acceptedPricingSnapshotId: body.acceptedPricingSnapshotId,
        operationId: idempotencyKey,
      },
      context,
    );
    return hostedJson({
      campaignId: id,
      newLimitUsdMicros: result.account.hardLimitUsdMicros.toString(),
      acceptedPricingSnapshotId: result.campaign.acceptedPricingSnapshotId,
      revision: result.campaign.revision,
      resumeRequired: true,
    });
  });
}
