import { z } from "zod";
import { createSession, resolveSession, revokeSession } from "@/hosted/auth";
import {
  hostedJson,
  hostedRoute,
  readBody,
  requireMutation,
} from "@/hosted/http";
import type { SessionContext } from "@/hosted/schema";
import { rateLimitSessionBootstrap } from "@/hosted/rate-limit";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function dto(session: SessionContext | null) {
  return session
    ? {
        id: session.sessionId,
        status: "active",
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        revision: session.revision,
        policy: { maxActiveCampaigns: 1, provider: "nebius-token-factory" },
      }
    : null;
}
export function GET(request: Request) {
  return hostedRoute((context) => ({
    session: dto(resolveSession(request, context)),
  }));
}
export function POST(request: Request) {
  return hostedRoute(async (context) => {
    await readBody(request, z.object({ schemaVersion: z.literal(1) }).strict());
    rateLimitSessionBootstrap(request, context);
    const result = createSession(request, context);
    return hostedJson(
      { session: dto(result.session) },
      201,
      result.cookie ? { "Set-Cookie": result.cookie } : undefined,
    );
  });
}
export function DELETE(request: Request) {
  return hostedRoute(async (context) => {
    const { session } = requireMutation(request, context);
    const body = await readBody(
      request,
      z
        .object({
          schemaVersion: z.literal(1),
          expectedRevision: z.number().int().positive(),
        })
        .strict(),
    );
    const result = revokeSession(
      {
        ownerScope: session.ownerScope,
        expectedRevision: body.expectedRevision,
      },
      context,
    );
    return hostedJson(
      {
        accepted: true,
        affectedCampaignCount: result.affectedCampaignCount,
        cleanupStatus: "pending",
      },
      202,
      { "Set-Cookie": result.cookie },
    );
  });
}
