import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { withHostedTransaction } from "./database";
import { requireHostedEnabled } from "./config";
import { appendCampaignEvent } from "./events";
import { assertLease, enqueueJob } from "./jobs";
import {
  boundedJson,
  campaignStatusSchema,
  dbNumber,
  dbString,
  HostedError,
  moneyJson,
  now,
  objectJson,
  waitReasonSchema,
  type Campaign,
  type CampaignStatus,
  type HostedContext,
  type Lease,
  type WaitReason,
} from "./schema";

export const PLATFORM_OWNER_SCOPE = "00000000-0000-4000-8000-000000000001";
export const PLATFORM_COMPUTE_ACCOUNT_ID =
  "00000000-0000-4000-8000-000000000002";
export function requestDigest(value: unknown): string {
  function canonical(input: unknown): unknown {
    if (typeof input === "bigint") return input.toString();
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return input;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function mapCampaign(row: Record<string, unknown>): Campaign {
  const desiredControl = row.desired_control;
  if (
    desiredControl !== "run" &&
    desiredControl !== "pause" &&
    desiredControl !== "stop"
  )
    throw new Error("Invalid campaign control");
  return {
    id: dbString(row.id),
    ownerScope: dbString(row.owner_scope),
    status: campaignStatusSchema.parse(row.status),
    waitReason:
      row.wait_reason === null ? null : waitReasonSchema.parse(row.wait_reason),
    desiredControl,
    controlRevision: dbNumber(row.control_revision),
    revision: dbNumber(row.revision),
    credentialId: dbString(row.credential_id),
    modelId: dbString(row.model_id),
    benchmarkId: dbString(row.benchmark_id),
    harnessId: dbString(row.harness_id),
    computeAccountId: dbString(row.compute_account_id),
    inferenceAccountId: dbString(row.inference_account_id),
    acceptedPricingSnapshotId:
      row.accepted_pricing_snapshot_id === null
        ? null
        : dbString(row.accepted_pricing_snapshot_id),
    pricingConsentRevision: dbNumber(row.pricing_consent_revision),
    config: objectJson(dbString(row.config_json)),
    checkpoint: objectJson(dbString(row.checkpoint_json)),
    createdAt: dbNumber(row.created_at),
    updatedAt: dbNumber(row.updated_at),
  };
}
export function getCampaign(
  input: { ownerScope: string; campaignId: string },
  context: HostedContext,
): Campaign | null {
  const row = context.db
    .prepare("SELECT * FROM campaigns WHERE owner_scope=? AND id=?")
    .get(input.ownerScope, input.campaignId);
  return row ? mapCampaign(row) : null;
}
export function listCampaigns(
  input: { ownerScope: string; limit?: number; before?: number },
  context: HostedContext,
): Campaign[] {
  const limit = z
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(input.limit ?? 50);
  return context.db
    .prepare(
      "SELECT * FROM campaigns WHERE owner_scope=? AND updated_at<=? ORDER BY updated_at DESC,id LIMIT ?",
    )
    .all(input.ownerScope, input.before ?? Number.MAX_SAFE_INTEGER, limit)
    .map(mapCampaign);
}
export function ensurePlatformAccount(context: HostedContext): void {
  const timestamp = now(context);
  context.db
    .prepare(
      "INSERT INTO budget_accounts(id,owner_scope,kind,hard_limit_usd_micros,admission_limit_usd_micros,created_at,updated_at) VALUES(?,?,'platform_compute',100000000,90000000,?,?) ON CONFLICT DO NOTHING",
    )
    .run(
      PLATFORM_COMPUTE_ACCOUNT_ID,
      PLATFORM_OWNER_SCOPE,
      timestamp,
      timestamp,
    );
}
export interface CreateCampaignInput {
  ownerScope: string;
  credentialId: string;
  modelId: string;
  benchmarkId: string;
  harnessId: string;
  inferenceAllowanceUsdMicros: bigint;
  acceptedPricingSnapshotId?: string;
  config?: Record<string, unknown>;
  idempotencyKey: string;
}
export function createCampaign(
  input: CreateCampaignInput,
  context: HostedContext,
): Campaign {
  requireHostedEnabled(context.config);
  const digest = requestDigest(input);
  const key = z.string().min(8).max(200).parse(input.idempotencyKey);
  moneyJson(input.inferenceAllowanceUsdMicros);
  if (
    input.inferenceAllowanceUsdMicros <= 0n ||
    input.inferenceAllowanceUsdMicros >
      context.config.inferenceMaxAllowanceUsdMicros
  )
    throw new HostedError(
      "ALLOWANCE_INVALID",
      "The inference allowance exceeds the permitted range.",
      422,
    );
  return withHostedTransaction(context.db, () => {
    const replay = context.db
      .prepare(
        "SELECT request_digest,effect_id,method,route FROM idempotency_records WHERE owner_scope=? AND key=?",
      )
      .get(input.ownerScope, key);
    if (replay) {
      if (
        replay.request_digest !== digest ||
        replay.method !== "POST" ||
        replay.route !== "campaigns"
      )
        throw new HostedError(
          "IDEMPOTENCY_CONFLICT",
          "The operation key was already used for a different request.",
          409,
        );
      const campaign = getCampaign(
        {
          ownerScope: input.ownerScope,
          campaignId: dbString(replay.effect_id),
        },
        context,
      );
      if (!campaign) throw new Error("Missing idempotent campaign");
      return campaign;
    }
    const credential = context.db
      .prepare(
        "SELECT id FROM credentials WHERE owner_scope=? AND id=? AND status='verified'",
      )
      .get(input.ownerScope, input.credentialId);
    const session = context.db
      .prepare(
        "SELECT id FROM sessions WHERE owner_scope=? AND status='active' AND expires_at>?",
      )
      .get(input.ownerScope, now(context));
    if (!credential || !session)
      throw new HostedError(
        "NOT_FOUND",
        "The requested resource was not found.",
        404,
      );
    if (
      context.db
        .prepare(
          "SELECT id FROM campaigns WHERE owner_scope=? AND status IN ('queued','running','pausing','paused','waiting','stopping')",
        )
        .get(input.ownerScope)
    )
      throw new HostedError(
        "ACTIVE_CAMPAIGN_EXISTS",
        "This browser already has an active experiment.",
        409,
      );
    const timestamp = now(context);
    const id = randomUUID();
    const computeId = randomUUID();
    const inferenceId = randomUUID();
    context.db
      .prepare(
        "INSERT INTO campaigns(id,owner_scope,credential_id,model_id,benchmark_id,harness_id,status,desired_control,compute_account_id,inference_account_id,accepted_pricing_snapshot_id,config_json,request_digest,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued','run',?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.ownerScope,
        input.credentialId,
        input.modelId,
        input.benchmarkId,
        input.harnessId,
        computeId,
        inferenceId,
        input.acceptedPricingSnapshotId ?? null,
        boundedJson(input.config ?? {}),
        digest,
        timestamp,
        timestamp,
      );
    ensurePlatformAccount(context);
    const insertAccount = context.db.prepare(
      "INSERT INTO budget_accounts(id,owner_scope,campaign_id,credential_id,kind,hard_limit_usd_micros,admission_limit_usd_micros,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
    );
    insertAccount.run(
      computeId,
      input.ownerScope,
      id,
      null,
      "campaign_compute",
      context.config.campaignComputeLimitUsdMicros,
      context.config.campaignComputeLimitUsdMicros,
      timestamp,
      timestamp,
    );
    insertAccount.run(
      inferenceId,
      input.ownerScope,
      id,
      input.credentialId,
      "campaign_inference",
      input.inferenceAllowanceUsdMicros,
      input.inferenceAllowanceUsdMicros,
      timestamp,
      timestamp,
    );
    enqueueJob({ ownerScope: input.ownerScope, campaignId: id }, context);
    appendCampaignEvent(
      {
        ownerScope: input.ownerScope,
        campaignId: id,
        type: "campaign.created",
        payload: { status: "queued" },
      },
      context,
    );
    context.db
      .prepare(
        "INSERT INTO idempotency_records(id,owner_scope,key,method,route,request_digest,effect_id,created_at) VALUES(?,?,?,'POST','campaigns',?,?,?)",
      )
      .run(randomUUID(), input.ownerScope, key, digest, id, timestamp);
    const result = getCampaign(
      { ownerScope: input.ownerScope, campaignId: id },
      context,
    );
    if (!result) throw new Error("Campaign not persisted");
    return result;
  });
}
const transitions: Record<CampaignStatus, readonly CampaignStatus[]> = {
  queued: ["running", "waiting", "pausing", "stopping", "failed"],
  running: ["waiting", "pausing", "stopping", "completed", "failed"],
  pausing: ["paused", "waiting", "stopping", "failed"],
  paused: ["queued", "stopping"],
  waiting: ["queued", "stopping", "failed"],
  stopping: ["stopped"],
  stopped: [],
  completed: [],
  failed: [],
};
export function updateCampaign(
  input: {
    ownerScope: string;
    campaignId: string;
    expectedRevision: number;
    status?: CampaignStatus;
    waitReason?: WaitReason | null;
    desiredControl?: Campaign["desiredControl"];
    checkpoint?: Record<string, unknown>;
    lease?: Lease;
  },
  context: HostedContext,
): Campaign {
  return withHostedTransaction(context.db, () => {
    if (input.lease) {
      assertLease(input.lease, context);
      if (
        input.lease.ownerScope !== input.ownerScope ||
        input.lease.campaignId !== input.campaignId
      )
        throw new HostedError(
          "STALE_LEASE",
          "The lease does not authorize this campaign.",
          409,
        );
    }
    const campaign = getCampaign(input, context);
    if (!campaign)
      throw new HostedError(
        "NOT_FOUND",
        "The requested resource was not found.",
        404,
      );
    if (campaign.revision !== input.expectedRevision)
      throw new HostedError(
        "REVISION_CONFLICT",
        "The experiment changed. Refresh and try again.",
        409,
        false,
        { currentRevision: campaign.revision },
      );
    if (
      input.status &&
      input.status !== campaign.status &&
      !transitions[campaign.status].includes(input.status)
    )
      throw new HostedError(
        "INVALID_TRANSITION",
        "The experiment cannot enter that state.",
        409,
      );
    if (
      campaign.desiredControl === "stop" &&
      input.desiredControl &&
      input.desiredControl !== "stop"
    )
      throw new HostedError(
        "INVALID_TRANSITION",
        "Stopping is irreversible.",
        409,
      );
    const status = input.status ?? campaign.status;
    const waitReason =
      input.waitReason === undefined
        ? status === "waiting"
          ? campaign.waitReason
          : null
        : input.waitReason;
    if (status === "waiting" && !waitReason)
      throw new HostedError(
        "VALIDATION_ERROR",
        "A waiting experiment needs a reason.",
      );
    context.db
      .prepare(
        "UPDATE campaigns SET status=?,wait_reason=?,desired_control=?,control_revision=control_revision+?,checkpoint_json=?,updated_at=?,revision=revision+1 WHERE owner_scope=? AND id=? AND revision=?",
      )
      .run(
        status,
        waitReason,
        input.desiredControl ?? campaign.desiredControl,
        input.desiredControl && input.desiredControl !== campaign.desiredControl
          ? 1
          : 0,
        boundedJson(input.checkpoint ?? campaign.checkpoint),
        now(context),
        input.ownerScope,
        input.campaignId,
        input.expectedRevision,
      );
    appendCampaignEvent(
      {
        ownerScope: input.ownerScope,
        campaignId: input.campaignId,
        type: "campaign.updated",
        payload: { status, waitReason, revision: campaign.revision + 1 },
      },
      context,
    );
    const result = getCampaign(input, context);
    if (!result) throw new Error("Campaign missing after update");
    return result;
  });
}
