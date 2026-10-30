import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { decryptCredential } from "./credentials";
import { getCampaign } from "./store";
import {
  reserveBudget,
  settleReservation,
  markReservationUncertain,
  releaseReservation,
} from "./budget";
import { withHostedTransaction } from "./database";
import { getPricingSnapshot, tokenCostUsdMicros } from "./pricing";
import { resolveGatewayToken } from "./gateway-tokens";
import { HostedError, now, type HostedContext } from "./schema";

const requestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(z.record(z.string(), z.unknown())).min(1).max(500),
    max_tokens: z.number().int().min(1).max(16384).optional(),
    max_completion_tokens: z.number().int().min(1).max(16384).optional(),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean() }).optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    tools: z
      .array(
        z.object({
          type: z.literal("function"),
          function: z.record(z.string(), z.unknown()),
        }),
      )
      .max(32)
      .optional(),
    tool_choice: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .optional(),
    parallel_tool_calls: z.boolean().optional(),
    response_format: z.record(z.string(), z.unknown()).optional(),
    reasoning_effort: z.string().optional(),
    chat_template_kwargs: z.record(z.string(), z.unknown()).optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .strict();
const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  prompt_tokens_details: z
    .object({ cached_tokens: z.number().int().nonnegative().nullish() })
    .nullish(),
});
type Usage = z.infer<typeof usageSchema>;
function safeError(error: unknown): Response {
  const value =
    error instanceof HostedError
      ? error
      : error instanceof z.ZodError || error instanceof SyntaxError
        ? new HostedError("VALIDATION_ERROR", "Invalid inference request.", 422)
        : new HostedError(
            "GATEWAY_UNAVAILABLE",
            "Inference is unavailable. Check the experiment status.",
            503,
          );
  return Response.json(
    { error: { code: value.code, message: value.message } },
    { status: value.status, headers: { "Cache-Control": "no-store" } },
  );
}
export async function handleChatCompletion(
  request: Request,
  context: HostedContext,
  transport: typeof fetch = fetch,
): Promise<Response> {
  let activeGrantId: string | null = null;
  try {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer "))
      throw new HostedError(
        "GATEWAY_SCOPE_INVALID",
        "Inference authorization required.",
        401,
      );
    const grant = resolveGatewayToken(authorization.slice(7), context);
    activeGrantId = grant.id;
    if (!request.body)
      throw new HostedError(
        "VALIDATION_ERROR",
        "Inference request body is required.",
        422,
      );
    const inbound = request.body.getReader(),
      chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const piece = await inbound.read();
        if (piece.done) break;
        length += piece.value.byteLength;
        if (length > 384000) {
          await inbound.cancel();
          throw new HostedError(
            "REQUEST_TOO_LARGE",
            "Model request is too large.",
            413,
          );
        }
        chunks.push(piece.value);
      }
    } finally {
      inbound.releaseLock();
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const body = requestSchema.parse(JSON.parse(text));
    if (
      grant.role !== "optimizer" &&
      (body.max_tokens ?? body.max_completion_tokens ?? 0) > 8192
    )
      throw new HostedError(
        "VALIDATION_ERROR",
        "This execution role permits at most 8192 output tokens.",
        422,
      );
    if (
      body.max_tokens !== undefined &&
      body.max_completion_tokens !== undefined
    )
      throw new HostedError(
        "VALIDATION_ERROR",
        "Specify one output token limit.",
        422,
      );
    for (const message of body.messages) {
      if (
        !["system", "developer", "user", "assistant", "tool"].includes(
          String(message.role),
        )
      )
        throw new HostedError(
          "VALIDATION_ERROR",
          "Unsupported message role.",
          422,
        );
      for (const key of Object.keys(message))
        if (
          ![
            "role",
            "content",
            "name",
            "tool_calls",
            "tool_call_id",
            "reasoning_content",
            "reasoning",
          ].includes(key)
        )
          throw new HostedError(
            "VALIDATION_ERROR",
            "Unsupported message field.",
            422,
          );
      if (
        message.content !== null &&
        typeof message.content !== "string" &&
        !z
          .array(
            z.object({ type: z.literal("text"), text: z.string() }).strict(),
          )
          .safeParse(message.content).success
      )
        throw new HostedError(
          "VALIDATION_ERROR",
          "Only text messages and function tool calls are supported.",
          422,
        );
      if (message.tool_calls !== undefined)
        z.array(
          z
            .object({
              id: z.string(),
              type: z.literal("function"),
              function: z
                .object({ name: z.string(), arguments: z.string() })
                .strict(),
            })
            .strict(),
        )
          .max(32)
          .parse(message.tool_calls);
    }
    if (
      body.model !== grant.model_id ||
      (body.max_tokens === undefined &&
        body.max_completion_tokens === undefined)
    )
      throw new HostedError(
        "MODEL_NOT_ALLOWED",
        "Use the pinned model with an explicit output limit.",
        422,
      );
    const requestKey =
      request.headers.get("X-LoopBench-Request-Key") ??
      request.headers.get("Gateway-Request-Key");
    if (!requestKey || !z.uuid().safeParse(requestKey).success)
      throw new HostedError(
        "REQUEST_KEY_REQUIRED",
        "A unique request UUID is required.",
        422,
      );
    const campaign = getCampaign(
      { ownerScope: grant.owner_scope, campaignId: grant.campaign_id },
      context,
    );
    if (!campaign?.acceptedPricingSnapshotId)
      throw new HostedError(
        "PRICING_UNAVAILABLE",
        "Price consent is required.",
        409,
      );
    // An accepted snapshot remains the billing contract; live refresh happens at worker checkpoints.
    const price = getPricingSnapshot(
      {
        ownerScope: grant.owner_scope,
        pricingSnapshotId: campaign.acceptedPricingSnapshotId,
      },
      context,
    );
    if (
      price.modelId !== body.model ||
      price.credentialId !== grant.credential_id
    )
      throw new HostedError(
        "MODEL_NOT_ALLOWED",
        "Price snapshot does not match this model.",
        422,
      );
    const outputBound = body.max_tokens ?? body.max_completion_tokens ?? 0;
    const promptBound = Buffer.byteLength(text) + 4096;
    const bound =
      tokenCostUsdMicros(promptBound, price.promptUsdPerToken) +
      tokenCostUsdMicros(outputBound, price.completionUsdPerToken);
    if (bound > context.config.inferenceMaxRequestUsdMicros)
      throw new HostedError(
        "INFERENCE_BUDGET",
        "Request exceeds its maximum inference allowance.",
        429,
      );
    const digest = createHash("sha256").update(text).digest("hex"),
      callId = randomUUID();
    const reservation = withHostedTransaction(context.db, () => {
      const replay = context.db
        .prepare(
          "SELECT id FROM provider_calls WHERE grant_id=? AND request_key=?",
        )
        .get(grant.id, requestKey);
      if (replay)
        throw new HostedError(
          "REQUEST_ALREADY_SENT",
          "This logical request already has an outcome or is awaiting reconciliation.",
          409,
        );
      resolveGatewayToken(authorization.slice(7), context);
      const hold = reserveBudget(
        {
          ownerScope: grant.owner_scope,
          campaignId: grant.campaign_id,
          kind: "inference",
          amountUsdMicros: bound,
          operationId: callId,
          operationKey: `inference:${grant.id}:${requestKey}`,
          operationKind: "provider_call",
          pricingSnapshotId: price.id,
        },
        context,
      );
      context.db
        .prepare(
          "INSERT INTO provider_calls(id,owner_scope,campaign_id,grant_id,request_key,request_digest,reservation_id,model_id,status,started_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          callId,
          grant.owner_scope,
          grant.campaign_id,
          grant.id,
          requestKey,
          digest,
          hold.id,
          body.model,
          "sending",
          now(context),
        );
      context.db
        .prepare("UPDATE gateway_grants SET calls_used=calls_used+1 WHERE id=?")
        .run(grant.id);
      return hold;
    });
    let finalized = false;
    function finish(
      usage: Usage | null,
      outcome: string,
      providerId: string | null = null,
    ) {
      if (finalized) return;
      finalized = true;
      withHostedTransaction(context.db, () => {
        if (usage)
          settleReservation(
            {
              ownerScope: grant.owner_scope,
              reservationId: reservation.id,
              actualUsdMicros:
                tokenCostUsdMicros(
                  usage.prompt_tokens,
                  price.promptUsdPerToken,
                ) +
                tokenCostUsdMicros(
                  usage.completion_tokens,
                  price.completionUsdPerToken,
                ),
              evidence: `provider-call:${callId}`,
            },
            context,
          );
        else
          markReservationUncertain(
            { ownerScope: grant.owner_scope, reservationId: reservation.id },
            context,
          );
        context.db
          .prepare(
            "UPDATE provider_calls SET status=?,finished_at=?,usage_json=?,provider_id=? WHERE id=?",
          )
          .run(
            usage ? outcome : "unknown",
            now(context),
            usage ? JSON.stringify(usage) : null,
            providerId,
            callId,
          );
      });
    }
    let upstream: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 110000);
    try {
      upstream = await transport(
        `${context.config.nebiusOrigin}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${decryptCredential({ ownerScope: grant.owner_scope, credentialId: grant.credential_id }, context)}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ...body,
            chat_template_kwargs: {
              enable_thinking:
                grant.role === "optimizer" &&
                body.chat_template_kwargs?.enable_thinking === true,
            },
            ...(body.stream ? { stream_options: { include_usage: true } } : {}),
          }),
          redirect: "error",
          signal: controller.signal,
        },
      );
    } catch {
      clearTimeout(timeout);
      finish(null, "unknown");
      throw new HostedError(
        "PROVIDER_UNAVAILABLE",
        "Token Factory request outcome is unknown; its allowance remains reserved.",
        503,
      );
    }
    if (!upstream.ok) {
      clearTimeout(timeout);
      // HTTP status alone does not establish the provider's billing outcome.
      finish(null, "unknown");
      throw new HostedError(
        upstream.status === 429 ? "PROVIDER_QUOTA" : "PROVIDER_REJECTED",
        "Token Factory rejected this request. No provider error body is exposed.",
        upstream.status === 429 ? 429 : 502,
      );
    }
    if (!body.stream) {
      try {
        const response = z
          .record(z.string(), z.unknown())
          .parse(await upstream.json());
        const usage = usageSchema.safeParse(response.usage);
        finish(
          usage.success ? usage.data : null,
          "completed",
          typeof response.id === "string" ? response.id : null,
        );
        return Response.json(response, {
          headers: {
            "Cache-Control": "no-store",
            "X-LoopBench-Call-Id": callId,
          },
        });
      } finally {
        clearTimeout(timeout);
        if (!finalized) finish(null, "unknown");
      }
    }
    if (!upstream.body) {
      clearTimeout(timeout);
      finish(null, "unknown");
      throw new HostedError(
        "PROVIDER_PROTOCOL",
        "Provider stream is missing.",
        502,
      );
    }
    const reader = upstream.body.getReader(),
      decoder = new TextDecoder();
    let pending = "",
      usage: Usage | null = null,
      providerId: string | null = null,
      doneFrame = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(destination) {
        try {
          const part = await reader.read();
          if (part.done) {
            clearTimeout(timeout);
            finish(doneFrame ? usage : null, "completed", providerId);
            destination.close();
            return;
          }
          pending += decoder.decode(part.value, { stream: true });
          if (pending.length > 2000000) throw new Error("Oversized SSE frame");
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") {
              doneFrame = true;
              continue;
            }
            try {
              const frame = z
                .record(z.string(), z.unknown())
                .parse(JSON.parse(data));
              const parsed = usageSchema.safeParse(frame.usage);
              if (parsed.success) usage = parsed.data;
              if (typeof frame.id === "string") providerId = frame.id;
            } catch {
              /* Non-JSON SSE comments don't carry usage. */
            }
          }
          destination.enqueue(part.value);
        } catch {
          clearTimeout(timeout);
          controller.abort();
          finish(null, "unknown");
          destination.error(
            new Error(
              "Token Factory stream interrupted; usage requires reconciliation.",
            ),
          );
        }
      },
      async cancel() {
        clearTimeout(timeout);
        controller.abort();
        await reader.cancel();
        finish(null, "unknown");
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
        "X-LoopBench-Call-Id": callId,
      },
    });
  } catch (error) {
    if (activeGrantId && error instanceof HostedError)
      context.db
        .prepare("UPDATE gateway_grants SET last_error_code=? WHERE id=?")
        .run(error.code, activeGrantId);
    return safeError(error);
  }
}
