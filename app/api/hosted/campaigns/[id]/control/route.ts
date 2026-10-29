import { z } from "zod";
import { controlCampaign } from "@/hosted/evolution";
import { getCampaign } from '@/hosted/store';
import {
  hostedJson,
  hostedRoute,
  readBody,
  requireMutation,
  notFound,
} from "@/hosted/http";
export const runtime = "nodejs";
export function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return hostedRoute(async (context) => {
    const { id } = await params;
    const { session, idempotencyKey } = requireMutation(request, context);
    if (!getCampaign({ ownerScope: session.ownerScope, campaignId: id }, context)) return notFound();
    const body = await readBody(
      request,
      z
        .object({
          schemaVersion: z.literal(1),
          action: z.enum(["pause", "resume", "stop"]),
          expectedRevision: z.number().int().positive(),
        })
        .strict(),
    );
    const campaign = await controlCampaign(
      {
        ownerScope: session.ownerScope,
        campaignId: id,
        action: body.action,
        expectedRevision: body.expectedRevision,
        operationId: idempotencyKey,
      },
      context,
    );
    return hostedJson(
      {
        campaignId: campaign.id,
        status: campaign.status,
        desiredControl: campaign.desiredControl,
        revision: campaign.revision,
        action: body.action,
        pending: true,
      },
      202,
    );
  });
}
