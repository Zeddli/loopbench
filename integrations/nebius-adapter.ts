import { pathToFileURL } from "node:url";
import { z } from "zod";

const requestSchema = z.object({
  protocol: z.literal("loopbench.task.v1"),
  task: z.object({ id: z.string(), prompt: z.string().min(1).max(120000) }),
  config: z.object({
    model: z.string().startsWith("nvidia/"),
    harness: z.string(),
    settings: z.record(z.string(), z.string()),
  }),
  instructions: z.string().max(16000),
});
const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
  }),
});

function positive(
  value: string | undefined,
  name: string,
  max: number,
): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > max)
    throw new Error(`${name} must be explicitly set between 0 and ${max}.`);
  return number;
}

/** One inference, no retries. Prices are supplied by the operator, never assumed. */
export async function runNebiusTask(
  raw: unknown,
  dependencies: {
    fetch: typeof fetch;
    env: Record<string, string | undefined>;
  } = { fetch, env: process.env },
) {
  const request = requestSchema.parse(raw);
  const { settings } = request.config;
  if (dependencies.env.NEBIUS_ALLOW_PAID !== "1")
    throw new Error(
      "Nebius inference is disabled. Set NEBIUS_ALLOW_PAID=1 explicitly to enable paid requests.",
    );
  const apiKey = dependencies.env.NEBIUS_API_KEY;
  if (!apiKey) throw new Error("NEBIUS_API_KEY is not configured.");
  const budget = positive(
    settings.maxCostUsd,
    "settings.maxCostUsd (per task)",
    0.05,
  );
  const inputRate = positive(
    settings.inputUsdPerMillion,
    "settings.inputUsdPerMillion",
    100,
  );
  const outputRate = positive(
    settings.outputUsdPerMillion,
    "settings.outputUsdPerMillion",
    100,
  );
  const maxTokens = positive(settings.maxTokens, "settings.maxTokens", 8192);
  if (!Number.isInteger(maxTokens))
    throw new Error("maxTokens must be an integer.");
  const baseUrl = new URL(
    dependencies.env.NEBIUS_BASE_URL ??
      "https://api.tokenfactory.nebius.com/v1/",
  );
  const allowedHosts = new Set([
    "api.tokenfactory.nebius.com",
    "api.tokenfactory.us-central1.nebius.com",
    "api.studio.nebius.com",
  ]);
  if (
    baseUrl.protocol !== "https:" ||
    !allowedHosts.has(baseUrl.hostname) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new Error(
      "NEBIUS_BASE_URL must be an HTTPS Nebius inference endpoint without credentials or query parameters.",
    );
  }
  const format = settings.responseFormat === "json"
    ? "Return only a JSON object matching the requested schema, without Markdown or explanations. "
    : "Return only executable JavaScript for the requested function, without Markdown or explanations. ";
  const system = format + request.instructions;
  // Byte count + overhead is deliberately conservative. This is an admission estimate,
  // not an account billing cap; provider token accounting and prices remain authoritative.
  const inputUpperEstimate =
    Buffer.byteLength(system + request.task.prompt, "utf8") + 1024;
  const estimate =
    (inputUpperEstimate * inputRate + maxTokens * outputRate) / 1_000_000;
  if (estimate > budget)
    throw new Error(
      `Request estimate $${estimate.toFixed(6)} exceeds per-task limit $${budget.toFixed(6)}. No request sent.`,
    );
  const endpoint = new URL(
    baseUrl.href.endsWith("/")
      ? "chat/completions"
      : `${baseUrl.pathname}/chat/completions`,
    baseUrl,
  );
  const response = await dependencies.fetch(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(90000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: request.config.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: request.task.prompt },
      ],
      max_tokens: maxTokens,
      temperature: 0,
    }),
  });
  // Provider error bodies can echo headers or prompt text; persist only status.
  if (!response.ok)
    throw new Error(
      `Nebius returned HTTP ${response.status}. Request was not retried.`,
    );
  const completion = completionSchema.parse(await response.json());
  const first = completion.choices[0];
  if (!first?.message.content)
    throw new Error("Nebius returned no answer text.");
  const costUsd =
    (completion.usage.prompt_tokens * inputRate +
      completion.usage.completion_tokens * outputRate) /
    1_000_000;
  return {
    output: first.message.content,
    inputTokens: completion.usage.prompt_tokens,
    outputTokens: completion.usage.completion_tokens,
    costUsd,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 250000)
        throw new Error("Adapter input exceeds 250 KB.");
    }
    process.stdout.write(
      JSON.stringify(await runNebiusTask(JSON.parse(input))),
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Nebius adapter failed"}\n`,
    );
    process.exitCode = 1;
  }
}
