import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { HostedError } from "./schema";

export interface HostedConfig {
  enabled: boolean;
  production: boolean;
  dbPath: string;
  publicOrigin: string;
  sessionSigningKey: string;
  sessionSigningKeyId: string;
  sessionCookieName: string;
  sessionDurationMs: number;
  vaultActiveKeyId: string;
  vaultKeys: Record<string, string>;
  credentialFingerprintKey: string;
  nebiusOrigin: string;
  e2bApiKey: string;
  e2bTemplateId: string;
  gatewayOrigin: string;
  platformComputeHardLimitUsdMicros: bigint;
  platformComputeAdmissionLimitUsdMicros: bigint;
  campaignComputeLimitUsdMicros: bigint;
  inferenceDefaultAllowanceUsdMicros: bigint;
  inferenceMaxAllowanceUsdMicros: bigint;
  inferenceMaxRequestUsdMicros: bigint;
  maxActiveSandboxes: number;
  leaseDurationMs: number;
}
const keyringSchema = z
  .object({
    activeKeyId: z.string().min(1).max(80),
    keys: z.record(z.string(), z.string()),
  })
  .strict();
export function loadHostedConfig(
  env: Record<string, string | undefined> = process.env,
): HostedConfig {
  const enabled =
    env.LOOPBENCH_HOSTED_ENABLED === "1" ||
    env.LOOPBENCH_HOSTED_ENABLED === "true";
  const production = env.NODE_ENV === "production";
  const publicOrigin = env.LOOPBENCH_PUBLIC_ORIGIN ?? "http://localhost:3000";
  const dbPath = env.LOOPBENCH_HOSTED_DB_PATH ?? "";
  let vaultActiveKeyId = "";
  let vaultKeys: Record<string, string> = {};
  if (enabled) {
    try {
      const source =
        env.LOOPBENCH_VAULT_KEYRING_JSON ??
        (env.LOOPBENCH_VAULT_KEYRING_FILE
          ? readFileSync(env.LOOPBENCH_VAULT_KEYRING_FILE, "utf8")
          : "");
      const keyring = keyringSchema.parse(JSON.parse(source));
      vaultActiveKeyId = keyring.activeKeyId;
      vaultKeys = keyring.keys;
      if (
        !vaultKeys[vaultActiveKeyId] ||
        Object.values(vaultKeys).some(
          (key) => Buffer.from(key, "base64").length !== 32,
        )
      )
        throw new Error("Invalid keyring");
      const origin = new URL(publicOrigin);
      if (
        origin.origin !== publicOrigin ||
        (production
          ? origin.protocol !== "https:"
          : !["https:", "http:"].includes(origin.protocol))
      )
        throw new Error("Invalid origin");
      if (
        !production &&
        origin.protocol === "http:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
      )
        throw new Error("Local HTTP is loopback only");
      if (
        !dbPath ||
        !isAbsolute(dbPath) ||
        Buffer.byteLength(env.LOOPBENCH_SESSION_SIGNING_KEY ?? "") < 32 ||
        Buffer.byteLength(env.LOOPBENCH_CREDENTIAL_FINGERPRINT_KEY ?? "") < 32
      )
        throw new Error("Missing secrets");
    } catch {
      throw new HostedError(
        "HOSTED_DISABLED",
        "Hosted configuration is incomplete or invalid.",
        503,
      );
    }
  }
  return {
    enabled,
    production,
    dbPath,
    publicOrigin,
    sessionSigningKey: env.LOOPBENCH_SESSION_SIGNING_KEY ?? "",
    sessionSigningKeyId: env.LOOPBENCH_SESSION_SIGNING_KEY_ID ?? "primary",
    sessionCookieName: production
      ? "__Host-loopbench_session"
      : "loopbench_session",
    sessionDurationMs: 7 * 86400000,
    vaultActiveKeyId,
    vaultKeys,
    credentialFingerprintKey: env.LOOPBENCH_CREDENTIAL_FINGERPRINT_KEY ?? "",
    nebiusOrigin: "https://api.tokenfactory.nebius.com",
    e2bApiKey: env.E2B_API_KEY ?? "",
    e2bTemplateId: env.LOOPBENCH_E2B_TEMPLATE_ID ?? "",
    gatewayOrigin: env.LOOPBENCH_GATEWAY_ORIGIN ?? publicOrigin,
    platformComputeHardLimitUsdMicros: 100000000n,
    platformComputeAdmissionLimitUsdMicros: 90000000n,
    campaignComputeLimitUsdMicros: 5000000n,
    inferenceDefaultAllowanceUsdMicros: 200000n,
    inferenceMaxAllowanceUsdMicros: 500000n,
    inferenceMaxRequestUsdMicros: 50000n,
    maxActiveSandboxes: 2,
    leaseDurationMs: 60000,
  };
}
export function requireHostedEnabled(config: HostedConfig): void {
  if (!config.enabled)
    throw new HostedError(
      "HOSTED_DISABLED",
      "Hosted execution is disabled.",
      503,
    );
}
