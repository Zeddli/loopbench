import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { resolveSession, requireBrowserMutation } from "./auth";
import { getHostedContext, withHostedTransaction } from "./database";
import {
  dbString,
  HostedError,
  now,
  type HostedContext,
  type SessionContext,
} from "./schema";

export const responseHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
export function hostedJson(
  data: unknown,
  status = 200,
  extraHeaders?: HeadersInit,
): Response {
  return Response.json(
    { schemaVersion: 1, data },
    { status, headers: { ...responseHeaders, ...extraHeaders } },
  );
}
export async function hostedRoute(
  handler: (context: HostedContext) => unknown | Promise<unknown>,
): Promise<Response> {
  try {
    const result = await handler(getHostedContext());
    return result instanceof Response ? result : hostedJson(result);
  } catch (error) {
    const known = error instanceof HostedError;
    return Response.json(
      {
        schemaVersion: 1,
        error: {
          code: known
            ? error.code
            : error instanceof z.ZodError
              ? "VALIDATION_ERROR"
              : "INTERNAL_ERROR",
          message: known
            ? error.message
            : error instanceof z.ZodError
              ? "The request is invalid."
              : "The request could not be completed.",
          requestId: randomUUID(),
          retryable: known && error.retryable,
        },
      },
      {
        status: known ? error.status : error instanceof z.ZodError ? 400 : 500,
        headers: responseHeaders,
      },
    );
  }
}
export function requireSession(
  request: Request,
  context: HostedContext,
): SessionContext {
  const session = resolveSession(request, context);
  if (!session)
    throw new HostedError(
      "NOT_FOUND",
      "The requested resource was not found.",
      404,
    );
  return session;
}
export function requireMutation(
  request: Request,
  context: HostedContext,
): { session: SessionContext; idempotencyKey: string } {
  const session = requireBrowserMutation(request, context);
  const idempotencyKey = z.uuid().parse(request.headers.get("Idempotency-Key"));
  return { session, idempotencyKey };
}
export async function readBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    throw new HostedError(
      "UNSUPPORTED_MEDIA_TYPE",
      "Use an application/json request.",
      415,
    );
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > 16384)
    throw new HostedError(
      "PAYLOAD_TOO_LARGE",
      "The request body is too large.",
      413,
    );
  if (!request.body)
    throw new HostedError(
      "VALIDATION_ERROR",
      "A request body is required.",
      400,
    );
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 16384) {
        await reader.cancel();
        throw new HostedError(
          "PAYLOAD_TOO_LARGE",
          "The request body is too large.",
          413,
        );
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HostedError(
      "VALIDATION_ERROR",
      "The request body must contain JSON.",
      400,
    );
  }
  return schema.parse(raw);
}
/** Persists only a keyed digest, including for secret-bearing credential bodies. */
export function idempotentEffect<T>(
  input: {
    ownerScope: string;
    key: string;
    method: string;
    route: string;
    body: unknown;
    execute: () => { effectId: string; value: T };
    replay: (id: string) => T;
  },
  context: HostedContext,
): T {
  const digest = createHmac("sha256", context.config.credentialFingerprintKey)
    .update(JSON.stringify(input.body))
    .digest("hex");
  return withHostedTransaction(context.db, () => {
    const prior = context.db
      .prepare(
        "SELECT * FROM idempotency_records WHERE owner_scope=? AND key=?",
      )
      .get(input.ownerScope, input.key);
    if (prior) {
      if (
        prior.request_digest !== digest ||
        prior.method !== input.method ||
        prior.route !== input.route
      )
        throw new HostedError(
          "IDEMPOTENCY_CONFLICT",
          "The operation key was already used for a different request.",
          409,
        );
      return input.replay(dbString(prior.effect_id));
    }
    const effect = input.execute();
    context.db
      .prepare(
        "INSERT INTO idempotency_records(id,owner_scope,key,method,route,request_digest,effect_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        input.ownerScope,
        input.key,
        input.method,
        input.route,
        digest,
        effect.effectId,
        now(context),
      );
    return effect.value;
  });
}
export function notFound(): never {
  throw new HostedError(
    "NOT_FOUND",
    "The requested resource was not found.",
    404,
  );
}
export function isHostedMode(): boolean {
  return (
    process.env.LOOPBENCH_HOSTED_ENABLED === "1" ||
    process.env.LOOPBENCH_HOSTED_ENABLED === "true"
  );
}
