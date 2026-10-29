import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withHostedTransaction } from "./database";
import { requireHostedEnabled } from "./config";
import {
  boundedJson,
  dbNumber,
  dbString,
  HostedError,
  jobStateSchema,
  now,
  objectJson,
  type HostedContext,
  type Job,
  type Lease,
} from "./schema";

function mapJob(row: Record<string, unknown>): Job {
  const kind = row.kind;
  if (
    kind !== "campaign_run" &&
    kind !== "campaign_reconcile" &&
    kind !== "campaign_cleanup"
  )
    throw new Error("Invalid job kind");
  return {
    id: dbString(row.id),
    ownerScope: dbString(row.owner_scope),
    campaignId: dbString(row.campaign_id),
    kind,
    state: jobStateSchema.parse(row.state),
    leaseFence: dbNumber(row.lease_fence),
    revision: dbNumber(row.revision),
    payload: objectJson(dbString(row.payload_json)),
    checkpoint: objectJson(dbString(row.checkpoint_json)),
  };
}
export function getJob(
  input: { ownerScope: string; jobId: string },
  context: HostedContext,
): Job | null {
  const row = context.db
    .prepare("SELECT * FROM jobs WHERE owner_scope=? AND id=?")
    .get(input.ownerScope, input.jobId);
  return row ? mapJob(row) : null;
}
export function enqueueJob(
  input: {
    ownerScope: string;
    campaignId: string;
    kind?: Job["kind"];
    payload?: Record<string, unknown>;
    availableAt?: number;
  },
  context: HostedContext,
): Job {
  return withHostedTransaction(context.db, () => {
    const campaign = context.db
      .prepare("SELECT id FROM campaigns WHERE owner_scope=? AND id=?")
      .get(input.ownerScope, input.campaignId);
    if (!campaign)
      throw new HostedError(
        "NOT_FOUND",
        "The requested resource was not found.",
        404,
      );
    const kind = input.kind ?? "campaign_run";
    if (kind === "campaign_run") {
      const row = context.db
        .prepare(
          "SELECT * FROM jobs WHERE owner_scope=? AND campaign_id=? AND kind='campaign_run' AND state IN ('queued','leased','running','waiting')",
        )
        .get(input.ownerScope, input.campaignId);
      if (row) return mapJob(row);
    }
    const id = randomUUID();
    const timestamp = now(context);
    context.db
      .prepare(
        "INSERT INTO jobs(id,owner_scope,campaign_id,kind,state,payload_json,available_at,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?,?,?)",
      )
      .run(
        id,
        input.ownerScope,
        input.campaignId,
        kind,
        boundedJson(input.payload ?? {}),
        input.availableAt ?? timestamp,
        timestamp,
        timestamp,
      );
    const result = getJob({ ownerScope: input.ownerScope, jobId: id }, context);
    if (!result) throw new Error("Job not persisted");
    return result;
  });
}
export function claimJob(
  input: { workerId: string; leaseDurationMs?: number; jobId?: string },
  context: HostedContext,
): Lease | null {
  requireHostedEnabled(context.config);
  if (input.jobId !== undefined) z.uuid().parse(input.jobId);
  if (!input.workerId || input.workerId.length > 120)
    throw new HostedError(
      "VALIDATION_ERROR",
      "A bounded worker identifier is required.",
    );
  const duration = input.leaseDurationMs ?? context.config.leaseDurationMs;
  if (!Number.isSafeInteger(duration) || duration < 1000 || duration > 300000)
    throw new HostedError("VALIDATION_ERROR", "Invalid lease duration.");
  return withHostedTransaction(context.db, () => {
    const timestamp = now(context);
    const row = context.db
      .prepare(
        "SELECT j.* FROM jobs j JOIN campaigns c ON c.owner_scope=j.owner_scope AND c.id=j.campaign_id WHERE ((j.state='queued' AND j.available_at<=?) OR (j.state IN ('leased','running') AND j.lease_expires_at<=?)) AND j.attempt_count<j.max_attempts AND (j.kind!='campaign_run' OR c.status IN ('queued','running','pausing','stopping')) AND (? IS NULL OR j.id=?) ORDER BY j.available_at,j.created_at,j.id LIMIT 1",
      )
      .get(timestamp, timestamp, input.jobId ?? null, input.jobId ?? null);
    if (!row) return null;
    const job = mapJob(row);
    const fence = job.leaseFence + 1;
    const expiresAt = timestamp + duration;
    context.db
      .prepare(
        "UPDATE jobs SET state='leased',lease_owner=?,lease_fence=?,lease_expires_at=?,heartbeat_at=?,attempt_count=attempt_count+1,updated_at=?,revision=revision+1 WHERE owner_scope=? AND id=? AND lease_fence=?",
      )
      .run(
        input.workerId,
        fence,
        expiresAt,
        timestamp,
        timestamp,
        job.ownerScope,
        job.id,
        job.leaseFence,
      );
    return {
      jobId: job.id,
      campaignId: job.campaignId,
      ownerScope: job.ownerScope,
      workerId: input.workerId,
      fence,
      expiresAt,
    };
  });
}
export function assertLease(lease: Lease, context: HostedContext): void {
  const row = context.db
    .prepare(
      "SELECT id FROM jobs WHERE owner_scope=? AND campaign_id=? AND id=? AND lease_owner=? AND lease_fence=? AND lease_expires_at>? AND state IN ('leased','running')",
    )
    .get(
      lease.ownerScope,
      lease.campaignId,
      lease.jobId,
      lease.workerId,
      lease.fence,
      now(context),
    );
  if (!row)
    throw new HostedError(
      "STALE_LEASE",
      "The worker lease is no longer current.",
      409,
    );
}
export function heartbeatJob(lease: Lease, context: HostedContext): Lease {
  return withHostedTransaction(context.db, () => {
    assertLease(lease, context);
    const timestamp = now(context);
    const expiresAt = timestamp + context.config.leaseDurationMs;
    context.db
      .prepare(
        "UPDATE jobs SET state='running',lease_expires_at=?,heartbeat_at=?,updated_at=?,revision=revision+1 WHERE owner_scope=? AND id=? AND lease_owner=? AND lease_fence=?",
      )
      .run(
        expiresAt,
        timestamp,
        timestamp,
        lease.ownerScope,
        lease.jobId,
        lease.workerId,
        lease.fence,
      );
    return { ...lease, expiresAt };
  });
}
export function updateJob(
  input: {
    lease: Lease;
    state?: Job["state"];
    checkpoint?: Record<string, unknown>;
    availableAt?: number;
    errorCode?: string;
  },
  context: HostedContext,
): Job {
  return withHostedTransaction(context.db, () => {
    assertLease(input.lease, context);
    context.db
      .prepare(
        "UPDATE jobs SET state=COALESCE(?,state),checkpoint_json=COALESCE(?,checkpoint_json),available_at=COALESCE(?,available_at),last_error_code=?,attempt_count=CASE WHEN ?='queued' AND ? IS NULL THEN 0 ELSE attempt_count END,updated_at=?,revision=revision+1 WHERE owner_scope=? AND id=? AND lease_owner=? AND lease_fence=?",
      )
      .run(
        input.state ?? null,
        input.checkpoint ? boundedJson(input.checkpoint) : null,
        input.availableAt ?? null,
        input.errorCode ?? null,
        input.state ?? null,
        input.errorCode ?? null,
        now(context),
        input.lease.ownerScope,
        input.lease.jobId,
        input.lease.workerId,
        input.lease.fence,
      );
    const result = getJob(
      { ownerScope: input.lease.ownerScope, jobId: input.lease.jobId },
      context,
    );
    if (!result) throw new Error("Job disappeared");
    return result;
  });
}
