import { z } from "zod";
import {
  connectCredential,
  getCredential,
  listCredentials,
  revokeCredential,
} from "@/hosted/credentials";
import { listEligibleModels } from "@/hosted/models";
import { rateLimitCredentialConnect } from "@/hosted/rate-limit";
import {
  hostedJson,
  hostedRoute,
  idempotentEffect,
  notFound,
  readBody,
  requireMutation,
  requireSession,
} from "@/hosted/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return hostedRoute((context) =>
    listCredentials(
      { ownerScope: requireSession(request, context).ownerScope },
      context,
    ),
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
          provider: z.literal("nebius-token-factory"),
          label: z.string().min(1).max(80),
          apiKey: z.string().min(8).max(4096),
        })
        .strict(),
    );
    const credential = idempotentEffect(
      {
        ownerScope: session.ownerScope,
        key: idempotencyKey,
        method: "POST",
        route: "credentials",
        body,
        execute: () => {
          rateLimitCredentialConnect(
            { ownerScope: session.ownerScope, apiKey: body.apiKey },
            context,
          );
          const value = connectCredential(
            {
              ownerScope: session.ownerScope,
              apiKey: body.apiKey,
              label: body.label,
            },
            context,
          );
          return { effectId: value.id, value };
        },
        replay: (credentialId) =>
          getCredential(
            { ownerScope: session.ownerScope, credentialId },
            context,
          ) ?? notFound(),
      },
      context,
    );
    await listEligibleModels(
      { ownerScope: session.ownerScope, credentialId: credential.id },
      context,
    );
    return hostedJson(
      getCredential(
        { ownerScope: session.ownerScope, credentialId: credential.id },
        context,
      ),
      201,
    );
  });
}
export function DELETE(request: Request) {
  return hostedRoute(async (context) => {
    const { session, idempotencyKey } = requireMutation(request, context);
    const body = await readBody(
      request,
      z
        .object({
          schemaVersion: z.literal(1),
          credentialId: z.uuid(),
          expectedRevision: z.number().int().positive(),
        })
        .strict(),
    );
    const credential = idempotentEffect(
      {
        ownerScope: session.ownerScope,
        key: idempotencyKey,
        method: "DELETE",
        route: "credentials",
        body,
        execute: () => {
          const value = revokeCredential(
            {
              ownerScope: session.ownerScope,
              credentialId: body.credentialId,
              expectedRevision: body.expectedRevision,
            },
            context,
          );
          return { effectId: value.id, value };
        },
        replay: (credentialId) =>
          getCredential(
            { ownerScope: session.ownerScope, credentialId },
            context,
          ) ?? notFound(),
      },
      context,
    );
    return hostedJson(credential, 202);
  });
}
