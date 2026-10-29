import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { loadBenchmark } from "../core/benchmarks";
import { loadHostedConfig } from "../hosted/config";
import { openHostedDatabase } from "../hosted/database";
import { loadApprovedHarness } from "../hosted/harnesses";
import { verifyComputePolicy } from "../hosted/operations";
import { HostedError, type HostedContext } from "../hosted/schema";
import { loadTokenHarness } from "../hosted/tokenfactory-sandboxes";

export interface PreflightCheck {
  name: string;
  passed: boolean;
  message: string;
}
export interface HostedPreflightReport {
  schemaVersion: 1;
  checkedAt: string;
  ready: boolean;
  checks: PreflightCheck[];
  runtime: { nodeVersion: string; sqliteVersion: string | null };
  provenance: Record<string, string>;
  remoteVerification: "not_performed";
}
/** Local checks only: this function never contacts a provider or creates a sandbox. */
export async function runHostedPreflight(
  env: Record<string, string | undefined> = process.env,
): Promise<HostedPreflightReport> {
  const checks: PreflightCheck[] = [];
  const tokenFactory = env.LOOPBENCH_EXECUTION_PROVIDER === "tokenfactory";
  const provenance: Record<string, string> = {};
  let sqliteVersion: string | null = null;
  let context: HostedContext | undefined;
  const check = async (
    name: string,
    callback: () => Promise<string> | string,
  ) => {
    try {
      checks.push({ name, passed: true, message: await callback() });
    } catch (error) {
      checks.push({
        name,
        passed: false,
        message:
          error instanceof HostedError
            ? error.message
            : "The local readiness check failed. Check the release configuration.",
      });
    }
  };
  await check("node-runtime", () => {
    const major = Number(process.versions.node.split(".")[0]);
    if (major !== 24 && major !== 25) throw new Error("Node24or25required");
    return `Node ${process.versions.node}; deployment targets Node 24 LTS with a pinned patch.`;
  });
  await check("private-configuration", () => {
    const config = loadHostedConfig({
      ...env,
      LOOPBENCH_HOSTED_ENABLED: "true",
    });
    context = { config, db: openHostedDatabase({ path: config.dbPath }) };
    return "Private configuration loaded without exposing secret values.";
  });
  if (context) {
    const ctx = context;
    try {
      await check("sqlite-durability", () => {
        const integrity = ctx.db
          .prepare("PRAGMA quick_check")
          .get()?.quick_check;
        const foreignKeys = ctx.db
          .prepare("PRAGMA foreign_keys")
          .get()?.foreign_keys;
        const journal = ctx.db
          .prepare("PRAGMA journal_mode")
          .get()?.journal_mode;
        const synchronous = ctx.db
          .prepare("PRAGMA synchronous")
          .get()?.synchronous;
        if (
          integrity !== "ok" ||
          foreignKeys !== 1 ||
          journal !== "wal" ||
          synchronous !== 2
        )
          throw new Error("SQLite durability checks failed");
        sqliteVersion = String(
          ctx.db.prepare("SELECT sqlite_version() AS version").get()?.version,
        );
        return "Schema migrated; integrity, WAL, foreign keys and FULL durability verified.";
      });
      await check("provider-configuration", () => {
        if (tokenFactory) {
          if (!env.NEBIUS_API_KEY || !env.NEBIUS_PROJECT_ID)
            throw Error("TokenFactoryprojectrequired");
          return "Token Factory operator credentials and project are configured; no provider request was sent.";
        }
        if (!ctx.config.e2bApiKey || !ctx.config.e2bTemplateId)
          throw new Error("E2Bconfigurationrequired");
        return "E2B controller credential and immutable template reference are present; no provider request was sent.";
      });
      await check("public-gateway-origin", () => {
        if (tokenFactory)
          return "Token Factory guests use a loopback relay; public guest ingress is unnecessary. Browser HTTPS is validated by production configuration.";
        const gateway = new URL(ctx.config.gatewayOrigin);
        if (
          gateway.protocol !== "https:" ||
          gateway.origin !== ctx.config.gatewayOrigin ||
          gateway.username ||
          gateway.password ||
          /^(localhost|127\.|\[?::1\]?$)/.test(gateway.hostname)
        )
          throw new Error("PublicHTTPSgatewayrequired");
        return "Public HTTPS gateway origin is configured; DNS, TLS and remote reachability still require the deployment probe.";
      });
      await check("provider-limit-evidence", () => {
        if (tokenFactory)
          return "Token Factory uses two shared execution slots, 600-second operations and retained usage observations. Monetary sandbox units remain unconfirmed.";
        const evidence = verifyComputePolicy(ctx, env);
        provenance.computePolicyOperationId = evidence.operationId;
        return "Fresh operator evidence records the provider limit, scope, reset period and enforcement behavior. It is not a zero-overshoot guarantee.";
      });
      await check("approved-runtime-manifest", async () => {
        const approved = tokenFactory
          ? await loadTokenHarness(env.LOOPBENCH_TOKEN_RUNNER_MANIFEST)
          : await loadApprovedHarness({
              templateId: ctx.config.e2bTemplateId,
              manifestPath: env.LOOPBENCH_RUNNER_MANIFEST,
            });
        provenance.supervisorSha256 = approved.runtime.supervisorSha256;
        provenance.toolDefinitionsSha256 =
          approved.runtime.toolDefinitionsSha256;
        provenance.piVersion = approved.runtime.piVersion;
        provenance.sandboxNodeVersion = approved.runtime.nodeVersion;
        provenance.agentTemplateId = approved.runtime.templateId;
        provenance.verifierTemplateId = approved.runtime.verifierTemplateId;
        return "Approved manifest matches the configured template and actual supervisor/extension bytes.";
      });
      await check("lease-schema", () => {
        const columns = ctx.db
          .prepare("PRAGMA table_info(jobs)")
          .all()
          .map((row) => row.name);
        if (
          ![
            "lease_fence",
            "lease_owner",
            "lease_expires_at",
            "checkpoint_json",
          ].every((column) => columns.includes(column))
        )
          throw new Error("Worker schema incomplete");
        return "Durable job checkpoint and fencing columns are present.";
      });
      await check("ledger-obligations", () => {
        const blocked = Number(
          ctx.db
            .prepare(
              "SELECT COUNT(*) AS count FROM budget_accounts WHERE status!='active' OR unknown_reservation_count>0 OR settled_usd_micros+reserved_usd_micros>admission_limit_usd_micros",
            )
            .get()?.count ?? 0,
        );
        if (blocked)
          throw new HostedError(
            "RECONCILIATION_REQUIRED",
            "Existing budget uncertainty or a blocked account requires reconciliation.",
            503,
          );
        return "Persisted accounts have no unresolved uncertainty or blocked admission.";
      });
      if (process.platform !== "win32")
        await check("private-database-permissions", async () => {
          if (((await stat(ctx.config.dbPath)).mode & 0o077) !== 0)
            throw new Error("Private file permissions required");
          return "Database permissions exclude group and other users.";
        });
    } finally {
      ctx.db.close();
    }
  }
  await check("benchmark-identity", async () => {
    const benchmark = await loadBenchmark("coding-adversarial-v1");
    if (benchmark.tasks.length !== 6)
      throw new Error("Canonical six tasks required");
    provenance.benchmarkHash = benchmark.hash;
    provenance.graderSha256 = createHash("sha256")
      .update(await readFile(resolve(process.cwd(), "benchmarks/evaluate.mjs")))
      .digest("hex");
    return "Six-task benchmark and trusted evaluator identities verified without publishing hidden cases.";
  });
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    ready: checks.every((item) => item.passed),
    checks,
    runtime: { nodeVersion: process.versions.node, sqliteVersion },
    provenance,
    remoteVerification: "not_performed",
  };
}
async function main() {
  const report = await runHostedPreflight();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ready) process.exitCode = 1;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void main().catch(() => {
    process.stderr.write(
      "Hosted preflight failed before readiness could be established.\n",
    );
    process.exitCode = 1;
  });
