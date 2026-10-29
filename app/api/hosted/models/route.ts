import { z } from "zod";
import { listEligibleModels } from "@/hosted/models";
import { hostedRoute, requireSession } from "@/hosted/http";
import { getCampaign } from "@/hosted/store";
import { notFound } from "@/hosted/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return hostedRoute((context) => {
    const session = requireSession(request, context);
    const params = new URL(request.url).searchParams;
    const campaignId = params.get("campaignId");
    const campaign = campaignId
      ? (getCampaign({ ownerScope: session.ownerScope, campaignId }, context) ??
        notFound())
      : null;
    const credentialId =
      campaign?.credentialId ?? z.uuid().parse(params.get("credentialId"));
    return listEligibleModels(
      {
        ownerScope: session.ownerScope,
        credentialId,
        refresh: params.get("refresh") === "true",
      },
      context,
    );
  });
}
