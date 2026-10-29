import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { assertLease } from "./jobs";
import { HostedError, now, type HostedContext, type Lease } from "./schema";

export function initializeGateway(context: HostedContext): void {
  context.db
    .exec(`CREATE TABLE IF NOT EXISTS gateway_grants(id TEXT PRIMARY KEY,token_digest TEXT NOT NULL UNIQUE,owner_scope TEXT NOT NULL,campaign_id TEXT NOT NULL,credential_id TEXT NOT NULL,attempt_id TEXT,role TEXT NOT NULL,model_id TEXT NOT NULL,job_id TEXT NOT NULL,worker_id TEXT NOT NULL,fence INTEGER NOT NULL,expires_at INTEGER NOT NULL,max_calls INTEGER NOT NULL,calls_used INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'active') STRICT;
  CREATE INDEX IF NOT EXISTS gateway_campaign ON gateway_grants(campaign_id,status);
  CREATE TABLE IF NOT EXISTS provider_calls(id TEXT PRIMARY KEY,owner_scope TEXT NOT NULL,campaign_id TEXT NOT NULL,grant_id TEXT NOT NULL,request_key TEXT NOT NULL,request_digest TEXT NOT NULL,reservation_id TEXT NOT NULL,model_id TEXT NOT NULL,status TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,usage_json TEXT,provider_id TEXT,response_json TEXT,UNIQUE(grant_id,request_key)) STRICT;`);
  if (
    !context.db
      .prepare("PRAGMA table_info(gateway_grants)")
      .all()
      .some((column) => column.name === "last_error_code")
  )
    context.db.exec(
      "ALTER TABLE gateway_grants ADD COLUMN last_error_code TEXT",
    );
}
const scopeSchema = z.object({
  ownerScope: z.string(),
  campaignId: z.uuid(),
  credentialId: z.uuid(),
  attemptId: z.uuid().nullable().default(null),
  role: z.enum(["pi_attempt", "optimizer", "probe"]),
  modelId: z.string(),
  maxCalls: z.number().int().min(1).max(100),
  durationMs: z.number().int().min(1000).max(600000).default(600000),
});
export interface GatewayScope extends z.infer<typeof scopeSchema> {
  lease: Lease;
}
const digest = (token: string, context: HostedContext) =>
  createHmac("sha256", context.config.sessionSigningKey)
    .update("loopbench-gateway-v1\0" + token)
    .digest("hex");
export function issueGatewayToken(
  input: z.input<typeof scopeSchema> & { lease: Lease },
  context: HostedContext,
): { id: string; token: string; expiresAt: number } {
  initializeGateway(context);
  assertLease(input.lease, context);
  const scope = scopeSchema.parse(input);
  if (
    scope.ownerScope !== input.lease.ownerScope ||
    scope.campaignId !== input.lease.campaignId
  )
    throw new HostedError("NOT_FOUND", "Not found.", 404);
  const id = randomUUID(),
    token = randomBytes(32).toString("base64url"),
    expiresAt = now(context) + scope.durationMs;
  context.db
    .prepare(
      "INSERT INTO gateway_grants(id,token_digest,owner_scope,campaign_id,credential_id,attempt_id,role,model_id,job_id,worker_id,fence,expires_at,max_calls) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      id,
      digest(token, context),
      scope.ownerScope,
      scope.campaignId,
      scope.credentialId,
      scope.attemptId,
      scope.role,
      scope.modelId,
      input.lease.jobId,
      input.lease.workerId,
      input.lease.fence,
      expiresAt,
      scope.maxCalls,
    );
  return { id, token, expiresAt };
}
export function revokeGatewayGrant(id: string, context: HostedContext): void {
  initializeGateway(context);
  context.db
    .prepare("UPDATE gateway_grants SET status='revoked' WHERE id=?")
    .run(id);
}
export function revokeCampaignGatewayGrants(
  campaignId: string,
  context: HostedContext,
): void {
  initializeGateway(context);
  context.db
    .prepare("UPDATE gateway_grants SET status='revoked' WHERE campaign_id=?")
    .run(campaignId);
}
const grantSchema = z.object({
  id: z.string(),
  owner_scope: z.string(),
  campaign_id: z.string(),
  credential_id: z.string(),
  attempt_id: z.string().nullable(),
  role: z.string(),
  model_id: z.string(),
  job_id: z.string(),
  worker_id: z.string(),
  fence: z.number(),
  expires_at: z.number(),
  max_calls: z.number(),
  calls_used: z.number(),
  status: z.string(),
});
export function resolveGatewayToken(token: string, context: HostedContext) {
  initializeGateway(context);
  const row = context.db
    .prepare("SELECT * FROM gateway_grants WHERE token_digest=?")
    .get(digest(token, context));
  const grant = grantSchema.safeParse(row);
  if (
    !grant.success ||
    grant.data.status !== "active" ||
    grant.data.expires_at <= now(context)
  )
    throw new HostedError(
      "GATEWAY_SCOPE_INVALID",
      "Inference scope is invalid or expired.",
      401,
    );
  const value = grant.data;
  assertLease(
    {
      jobId: value.job_id,
      campaignId: value.campaign_id,
      ownerScope: value.owner_scope,
      workerId: value.worker_id,
      fence: value.fence,
      expiresAt: value.expires_at,
    },
    context,
  );
  const campaign = context.db
    .prepare(
      "SELECT desired_control,status FROM campaigns WHERE id=? AND owner_scope=?",
    )
    .get(value.campaign_id, value.owner_scope);
  const credential = context.db
    .prepare("SELECT status FROM credentials WHERE id=? AND owner_scope=?")
    .get(value.credential_id, value.owner_scope);
  if (
    !campaign ||
    campaign.desired_control !== "run" ||
    !["queued", "running"].includes(String(campaign.status)) ||
    credential?.status !== "verified"
  )
    throw new HostedError(
      "GATEWAY_SCOPE_REVOKED",
      "Inference scope is no longer active.",
      403,
    );
  if (value.calls_used >= value.max_calls) {
    context.db
      .prepare(
        "UPDATE gateway_grants SET last_error_code='ATTEMPT_CALL_LIMIT' WHERE id=? AND (last_error_code IS NULL OR last_error_code='ATTEMPT_CALL_LIMIT')",
      )
      .run(value.id);
    throw new HostedError(
      "ATTEMPT_CALL_LIMIT",
      "This task reached its model-call allowance.",
      429,
    );
  }
  return value;
}
export function confirmCompletedAttemptCalls(
  input: { ownerScope: string; campaignId: string; attemptId: string },
  context: HostedContext,
): boolean {
  initializeGateway(context);
  return Boolean(
    context.db
      .prepare(
        "SELECT g.id FROM gateway_grants g WHERE g.owner_scope=? AND g.campaign_id=? AND g.attempt_id=? AND g.role='pi_attempt' AND g.calls_used>0 AND g.last_error_code IS NULL AND NOT EXISTS(SELECT 1 FROM provider_calls p WHERE p.grant_id=g.id AND p.status!='completed')",
      )
      .get(input.ownerScope, input.campaignId, input.attemptId),
  );
}
export function confirmScopedCallLimit(
  input: { ownerScope: string; campaignId: string; attemptId: string },
  context: HostedContext,
): boolean {
  initializeGateway(context);
  return Boolean(
    context.db
      .prepare(
        "SELECT g.id FROM gateway_grants g WHERE g.owner_scope=? AND g.campaign_id=? AND g.attempt_id=? AND g.last_error_code='ATTEMPT_CALL_LIMIT' AND g.calls_used>=g.max_calls AND NOT EXISTS(SELECT 1 FROM provider_calls p WHERE p.grant_id=g.id AND p.status!='completed')",
      )
      .get(input.ownerScope, input.campaignId, input.attemptId),
  );
}
