import { z } from "zod";
import { nodeRecordSchema } from "@/core/types";

export function allowanceMicros(value: string): string | null {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) return null;
  const [whole = "0", fractional = ""] = value.split(".");
  const micros = BigInt(whole) * 1_000_000n + BigInt(fractional.padEnd(6, "0"));
  return micros > 0n && micros <= 500_000n ? micros.toString() : null;
}
export function preserveSelection(selected: string, ids: string[]): string {
  return ids.includes(selected) ? selected : (ids.at(-1) ?? "");
}
export function usd(value: string | null | undefined) {
  return value == null
    ? "Unknown"
    : `$${(Number(value) / 1_000_000).toFixed(4)}`;
}
export const credentialSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  maskedLabel: z.string().optional(),
  displayHint: z.string().optional(),
  status: z.string(),
  revision: z.number().optional(),
});
export function preferredCredential(
  credentials: z.infer<typeof credentialSchema>[],
) {
  return (
    credentials.find((credential) => credential.status === "verified") ??
    credentials.find((credential) =>
      ["unverified", "unavailable"].includes(credential.status),
    )
  );
}
export const modelSchema = z.object({
  id: z.string(),
  name: z.string(),
  availability: z.string(),
  enabled: z.boolean(),
  pricingSnapshotId: z.string().nullable(),
  estimatedWorkloadUsdMicros: z.string().nullable(),
  reason: z.string().nullable(),
  pricing: z
    .object({
      promptUsdPerToken: z.string(),
      completionUsdPerToken: z.string(),
    })
    .nullable(),
});
export const modelCatalogSchema = z.object({
  checkedAt: z.union([z.string(), z.number()]),
  selectedModelId: z.string().nullable(),
  models: z.array(modelSchema),
  warnings: z.array(z.string()),
  selectionPolicy: z.string(),
});
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;
export const harnessReadinessSchema = z.object({
  ready: z.boolean(),
  hash: z.string().nullable(),
  piVersion: z.string(),
  nodeVersion: z.string().nullable(),
  templateId: z.string().nullable(),
  reason: z.string().nullable(),
});
export const benchmarkManifestSchema = z.object({
  id: z.string(),
  hash: z.string(),
  taskCount: z.number(),
});
export const campaignSchema = z.object({
  id: z.string(),
  status: z.string(),
  revision: z.number(),
  modelId: z.string(),
  benchmarkId: z.string(),
  harnessId: z.string(),
  waitReason: z.string().nullable().optional(),
  desiredControl: z.string().optional(),
  createdAt: z.union([z.string(), z.number()]).optional(),
  updatedAt: z.union([z.string(), z.number()]).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
export type Campaign = z.infer<typeof campaignSchema>;
const budgetSchema = z.object({
  limitUsdMicros: z.string(),
  settledEstimateUsdMicros: z.string().optional(),
  reservedUsdMicros: z.string().optional(),
  unknownReservationCount: z.number().optional(),
  estimateStatus: z.string().optional(),
});
export const projectionSchema = z.object({
  campaign: campaignSchema,
  nodes: z.array(nodeRecordSchema).default([]),
  proposals: z
    .array(
      z.object({
        parentId: z.string(),
        hypothesis: z.string(),
        nodeId: z.string().nullable(),
        round: z.number(),
      }),
    )
    .default([]),
  taskAttempts: z
    .array(
      z
        .object({
          id: z.string(),
          taskId: z.string(),
          status: z.string(),
          outcome: z.string().nullable().optional(),
        })
        .passthrough(),
    )
    .default([]),
  budgets: z
    .object({ compute: budgetSchema.optional(), inference: budgetSchema })
    .optional(),
  artifacts: z
    .array(
      z.object({
        id: z.string(),
        kind: z.string(),
        state: z.string(),
        byteLength: z.number().optional(),
        downloadUrl: z.string().optional(),
      }),
    )
    .default([]),
  eventCursor: z.string().nullable().optional(),
});
export type Projection = z.infer<typeof projectionSchema>;

export async function api<T>(
  url: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { Accept: "application/json", ...init?.headers },
  });
  const envelope: unknown = await response.json();
  if (!response.ok) {
    const error = z
      .object({ error: z.object({ message: z.string() }) })
      .safeParse(envelope);
    throw new Error(
      error.success
        ? error.data.error.message
        : "The request could not be completed.",
    );
  }
  const parsed = z.object({ data: schema }).safeParse(envelope);
  if (!parsed.success)
    throw new Error("The server returned an unsupported response.");
  return parsed.data.data;
}
export function mutation(
  body: unknown,
  key = crypto.randomUUID(),
): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  };
}
let bootstrap: Promise<void> | undefined;
export function ensureSession(): Promise<void> {
  bootstrap ??= api(
    "/api/hosted/session",
    z.unknown(),
    mutation({ schemaVersion: 1 }),
  )
    .then(() => undefined)
    .catch((error: unknown) => {
      bootstrap = undefined;
      throw error;
    });
  return bootstrap;
}
