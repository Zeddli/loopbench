import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { HostedError, now, type HostedContext } from "./schema";
import { decimalFraction } from "./pricing";

const computePolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.literal("e2b"),
    operationId: z.uuid(),
    projectReference: z.string().min(1).max(200),
    hardLimitUsdMicros: z.literal("100000000"),
    scope: z.string().min(1).max(500),
    resetPeriod: z.string().min(1).max(500),
    enforcement: z.string().min(20).max(2000),
    verifiedAt: z.iso.datetime(),
  })
  .strict();
export type ComputePolicyEvidence = z.infer<typeof computePolicySchema>;
/** Local deployment gate. This attestation records an operator check, not an invoice guarantee. */
export function verifyComputePolicy(
  context: HostedContext,
  env: Record<string, string | undefined> = process.env,
): ComputePolicyEvidence {
  try {
    const filename = env.LOOPBENCH_E2B_LIMIT_EVIDENCE;
    if (!filename || !isAbsolute(filename))
      throw new Error("Evidence file required");
    const raw = readFileSync(filename, "utf8");
    if (Buffer.byteLength(raw) > 16384) throw new Error("Evidence too large");
    const evidence = computePolicySchema.parse(JSON.parse(raw));
    const verifiedAt = Date.parse(evidence.verifiedAt);
    if (
      verifiedAt > now(context) + 60000 ||
      now(context) - verifiedAt > 7 * 86400000
    )
      throw new Error("Stale evidence");
    const rate = decimalFraction(env.LOOPBENCH_E2B_USD_PER_SECOND ?? "");
    if (rate.numerator <= 0n)
      throw new Error("Verified positive rate required");
    return evidence;
  } catch {
    throw new HostedError(
      "RUNTIME_UNAVAILABLE",
      "Fresh E2B account-limit evidence and a verified compute rate are required before paid work.",
      503,
    );
  }
}
