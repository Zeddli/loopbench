import { z } from "zod";
import { decryptCredential, setCredentialVerification } from "./credentials";
import { HostedError, now, type HostedContext } from "./schema";
import { savePricingSnapshot, tokenCostUsdMicros } from "./pricing";
import { rateLimitCatalog } from "./rate-limit";

const richModel = z.object({
  id: z.string(),
  name: z.string().optional(),
  context_length: z.number().optional(),
  architecture: z.object({ modality: z.string().optional() }).optional(),
  pricing: z
    .object({
      prompt: z.string(),
      completion: z.string(),
      request: z.string().optional(),
      image: z.string().optional(),
      price_per_video_second: z.string().optional(),
    })
    .optional(),
});
export interface ModelDTO {
  id: string;
  name: string;
  enabled: boolean;
  capabilities: {
    text: boolean;
    tools: boolean;
    json: boolean;
    streaming: boolean;
    verification: "profile" | "live" | "unknown";
  };
  availability: "available" | "blocked";
  contextLength: number | null;
  maxOutputTokens: number;
  pricingSnapshotId: string | null;
  estimatedWorkloadUsdMicros: string | null;
  reason: string | null;
  pricing: { promptUsdPerToken: string; completionUsdPerToken: string } | null;
}
export interface ModelCatalog {
  credentialId: string;
  provider: "nebius-token-factory";
  checkedAt: number;
  authenticationVerifiedAt: number;
  models: ModelDTO[];
  pricingObservedAt: number;
  balanceStatus: "unknown";
  selectionPolicy: string;
  selectedModelId: string | null;
  warnings: string[];
}
export const workloadProfile = {
  id: "pi-tools-json-v1",
  inputTokens: 12000,
  outputTokens: 4000,
};
// Compatibility profiles establish the protocol to probe, not a fabricated live test.
const profiles = new Set([
  "nvidia/Nemotron-3_5-Lightning",
  "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
  "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
  "nvidia/Nemotron-3-Nano-30B-A3B",
]);
export function selectCheapestModel(
  { catalog }: { catalog: Pick<ModelCatalog, "models"> },
  _context?: HostedContext,
): ModelDTO | null {
  return (
    catalog.models
      .filter(
        (model) => model.enabled && model.estimatedWorkloadUsdMicros !== null,
      )
      .sort((a, b) => {
        const left = BigInt(a.estimatedWorkloadUsdMicros ?? "0"),
          right = BigInt(b.estimatedWorkloadUsdMicros ?? "0");
        return left < right
          ? -1
          : left > right
            ? 1
            : a.id === "nvidia/Nemotron-3_5-Lightning"
              ? -1
              : b.id === "nvidia/Nemotron-3_5-Lightning"
                ? 1
                : a.id.localeCompare(b.id);
      })[0] ?? null
  );
}
export function isMinimumCostModel(
  catalog: Pick<ModelCatalog, "models">,
  modelId: string,
): boolean {
  const lowest = selectCheapestModel({ catalog });
  const chosen = catalog.models.find(
    (model) => model.id === modelId && model.enabled,
  );
  return Boolean(
    lowest &&
    chosen &&
    chosen.estimatedWorkloadUsdMicros !== null &&
    chosen.estimatedWorkloadUsdMicros === lowest.estimatedWorkloadUsdMicros,
  );
}
export function parseModelCatalog(
  data: unknown,
  input: { ownerScope: string; credentialId: string },
  context: HostedContext,
): ModelCatalog {
  const parsed = z.object({ data: z.array(richModel).max(10000) }).parse(data);
  const models = parsed.data.map((model): ModelDTO => {
    const nemotron = /^nvidia\//i.test(model.id) && /nemotron/i.test(model.id);
    const compatible =
      nemotron &&
      profiles.has(model.id) &&
      (!model.architecture?.modality ||
        model.architecture.modality === "text->text");
    let pricingSnapshotId: string | null = null,
      estimatedWorkloadUsdMicros: string | null = null;
    let reason: string | null = !nemotron
      ? "Only NVIDIA Nemotron is supported for this pilot."
      : !compatible
        ? "This model needs a reviewed Pi tool/JSON compatibility profile."
        : null;
    if (compatible && model.pricing) {
      try {
        if (model.pricing.request && Number(model.pricing.request) !== 0)
          throw new Error("Unpriced request dimension");
        const snapshot = savePricingSnapshot(
          {
            ownerScope: input.ownerScope,
            credentialId: input.credentialId,
            modelId: model.id,
            promptUsdPerToken: model.pricing.prompt,
            completionUsdPerToken: model.pricing.completion,
          },
          context,
        );
        pricingSnapshotId = snapshot.id;
        estimatedWorkloadUsdMicros = (
          tokenCostUsdMicros(
            workloadProfile.inputTokens,
            model.pricing.prompt,
          ) +
          tokenCostUsdMicros(
            workloadProfile.outputTokens,
            model.pricing.completion,
          )
        ).toString();
      } catch {
        reason = "Current billable pricing cannot be safely reserved.";
      }
    } else if (compatible) reason = "Current verbose pricing is missing.";
    const enabled = compatible && pricingSnapshotId !== null;
    return {
      id: model.id,
      name: model.name ?? model.id,
      enabled,
      capabilities: {
        text: compatible,
        tools: compatible,
        json: compatible,
        streaming: compatible,
        verification: compatible ? "profile" : "unknown",
      },
      availability: enabled ? "available" : "blocked",
      contextLength: model.context_length ?? null,
      maxOutputTokens: 4096,
      pricingSnapshotId,
      estimatedWorkloadUsdMicros,
      reason,
      pricing: model.pricing
        ? {
            promptUsdPerToken: model.pricing.prompt,
            completionUsdPerToken: model.pricing.completion,
          }
        : null,
    };
  });
  const catalog: ModelCatalog = {
    credentialId: input.credentialId,
    provider: "nebius-token-factory",
    checkedAt: now(context),
    authenticationVerifiedAt: now(context),
    models,
    pricingObservedAt: now(context),
    balanceStatus: "unknown",
    selectionPolicy:
      "Minimum uncached cost for 12,000 input + 4,000 output tokens; verified Lightning wins a price tie.",
    selectedModelId: null,
    warnings: [
      "Balance is unknown. Model-list authentication does not verify inference access. A budgeted live tool, streaming and JSON probe runs before the first task.",
    ],
  };
  catalog.selectedModelId = selectCheapestModel({ catalog })?.id ?? null;
  return catalog;
}
export async function listEligibleModels(
  input: { ownerScope: string; credentialId: string; refresh?: boolean },
  context: HostedContext,
): Promise<ModelCatalog> {
  const key = decryptCredential(input, context);
  rateLimitCatalog(input, context);
  const response = await fetch(
    `${context.config.nebiusOrigin}/v1/models?verbose=true`,
    {
      headers: { Authorization: `Bearer ${key}` },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      cache: "no-store",
    },
  );
  if (!response.ok) {
    setCredentialVerification(
      {
        ...input,
        status:
          response.status === 401 || response.status === 403
            ? "invalid"
            : "unavailable",
      },
      context,
    );
    throw new HostedError(
      response.status === 429 ? "PROVIDER_QUOTA" : "PROVIDER_AUTH",
      "Token Factory could not verify this connection.",
      422,
    );
  }
  const catalog = parseModelCatalog(await response.json(), input, context);
  setCredentialVerification({ ...input, status: "verified" }, context);
  return catalog;
}
