import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { HostedError, now, type HostedContext } from "./schema";

// Provider prices are dollars per token. Keep fractional microdollars exact.
export function decimalFraction(value: string): {
  numerator: bigint;
  denominator: bigint;
} {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value))
    throw new HostedError(
      "PRICING_UNAVAILABLE",
      "Unsupported provider price.",
      422,
    );
  const [whole, fraction = ""] = value.split(".");
  return {
    numerator: BigInt(whole + fraction),
    denominator: 10n ** BigInt(fraction.length),
  };
}
export function tokenCostUsdMicros(
  tokens: number,
  usdPerToken: string,
): bigint {
  if (!Number.isSafeInteger(tokens) || tokens < 0)
    throw new Error("Invalid token count");
  const { numerator, denominator } = decimalFraction(usdPerToken);
  return (
    (BigInt(tokens) * numerator * 1000000n + denominator - 1n) / denominator
  );
}
export const pricingSnapshotSchema = z.object({
  id: z.uuid(),
  ownerScope: z.string(),
  credentialId: z.uuid(),
  modelId: z.string(),
  promptUsdPerToken: z.string(),
  completionUsdPerToken: z.string(),
  observedAt: z.number(),
  expiresAt: z.number(),
  profile: z.literal("pi-tools-json-v1"),
  hash: z.string(),
});
export type PricingSnapshot = z.infer<typeof pricingSnapshotSchema>;
export function initializePricing(context: HostedContext): void {
  context.db
    .exec(`CREATE TABLE IF NOT EXISTS pricing_snapshots(id TEXT PRIMARY KEY,owner_scope TEXT NOT NULL,credential_id TEXT NOT NULL,model_id TEXT NOT NULL,hash TEXT NOT NULL,data_json TEXT NOT NULL,observed_at INTEGER NOT NULL,expires_at INTEGER NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS pricing_owner ON pricing_snapshots(owner_scope,credential_id,model_id,observed_at);`);
}
export function savePricingSnapshot(
  input: Omit<
    PricingSnapshot,
    "id" | "observedAt" | "expiresAt" | "profile" | "hash"
  >,
  context: HostedContext,
): PricingSnapshot {
  initializePricing(context);
  decimalFraction(input.promptUsdPerToken);
  decimalFraction(input.completionUsdPerToken);
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const previous = context.db
    .prepare(
      "SELECT data_json FROM pricing_snapshots WHERE owner_scope=? AND credential_id=? AND model_id=? AND hash=? AND expires_at>? ORDER BY observed_at DESC LIMIT 1",
    )
    .get(
      input.ownerScope,
      input.credentialId,
      input.modelId,
      hash,
      now(context),
    );
  // A successful catalog fetch is a new observation. Keep rates immutable while
  // giving unchanged-price worker refreshes a fresh expiry and provenance.
  void previous;
  const snapshot: PricingSnapshot = {
    ...input,
    id: randomUUID(),
    observedAt: now(context),
    expiresAt: now(context) + 15 * 60000,
    profile: "pi-tools-json-v1",
    hash,
  };
  context.db
    .prepare("INSERT INTO pricing_snapshots VALUES(?,?,?,?,?,?,?,?)")
    .run(
      snapshot.id,
      input.ownerScope,
      input.credentialId,
      input.modelId,
      hash,
      JSON.stringify(snapshot),
      snapshot.observedAt,
      snapshot.expiresAt,
    );
  return snapshot;
}
export function getPricingSnapshot(
  input: {
    ownerScope: string;
    pricingSnapshotId: string;
    allowExpired?: boolean;
  },
  context: HostedContext,
): PricingSnapshot {
  initializePricing(context);
  const row = context.db
    .prepare(
      "SELECT data_json FROM pricing_snapshots WHERE id=? AND owner_scope=?",
    )
    .get(input.pricingSnapshotId, input.ownerScope);
  if (!row) throw new HostedError("NOT_FOUND", "Not found.", 404);
  const result = pricingSnapshotSchema.parse(JSON.parse(String(row.data_json)));
  if (!input.allowExpired && result.expiresAt <= now(context))
    throw new HostedError(
      "PRICING_UNAVAILABLE",
      "Refresh model prices and approve the current price before continuing.",
      409,
    );
  return result;
}
