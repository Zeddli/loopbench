import { randomUUID } from "node:crypto";
import { z } from "zod";
import { loadBenchmark } from "../core/benchmarks";
import { nodeRecordSchema, type NodeRecord } from "../core/types";
import { withHostedTransaction } from "./database";
import {
  createCampaign,
  getCampaign,
  listCampaigns,
  updateCampaign,
  requestDigest,
  type CreateCampaignInput,
} from "./store";
import { getBudgetSummary } from "./budget";
import { listArtifacts } from "./artifacts";
import { listEligibleModels } from "./models";
import { getPricingSnapshot } from "./pricing";
import {
  initializeGateway,
  revokeCampaignGatewayGrants,
} from "./gateway-tokens";
import { HostedError, now, type HostedContext, type Campaign } from "./schema";
import { hostedProposalSchema } from "./optimizer";
import { harnessArtifactSchema, type HarnessArtifact } from "./harnesses";
import { tokenHarnessId } from "./tokenfactory-sandboxes";

export function initializeEvolution(context: HostedContext): void {
  initializeGateway(context);
  context.db
    .exec(`CREATE TABLE IF NOT EXISTS hosted_versions(id TEXT PRIMARY KEY,owner_scope TEXT NOT NULL,campaign_id TEXT NOT NULL,parent_id TEXT,harness_json TEXT NOT NULL,node_json TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
  CREATE INDEX IF NOT EXISTS hosted_versions_owner ON hosted_versions(owner_scope,campaign_id,created_at,id);
  CREATE TABLE IF NOT EXISTS hosted_proposals(id TEXT PRIMARY KEY,owner_scope TEXT NOT NULL,campaign_id TEXT NOT NULL,parent_id TEXT NOT NULL,round INTEGER NOT NULL,ordinal INTEGER NOT NULL,proposal_json TEXT NOT NULL,harness_json TEXT NOT NULL,node_id TEXT,UNIQUE(campaign_id,round,ordinal)) STRICT;
  CREATE TABLE IF NOT EXISTS hosted_proposal_outcomes(owner_scope TEXT NOT NULL,campaign_id TEXT NOT NULL,round INTEGER NOT NULL,ordinal INTEGER NOT NULL,outcome_json TEXT NOT NULL,PRIMARY KEY(owner_scope,campaign_id,round,ordinal)) STRICT;
  CREATE TABLE IF NOT EXISTS hosted_attempts(id TEXT PRIMARY KEY,owner_scope TEXT NOT NULL,campaign_id TEXT NOT NULL,node_id TEXT NOT NULL,role TEXT NOT NULL,task_id TEXT NOT NULL,status TEXT NOT NULL,result_json TEXT,agent_intent_id TEXT NOT NULL,verifier_intent_id TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS hosted_sandbox_intents(id TEXT PRIMARY KEY,owner_scope TEXT NOT NULL,campaign_id TEXT NOT NULL,attempt_id TEXT NOT NULL,role TEXT NOT NULL,status TEXT NOT NULL,sandbox_id TEXT,template_id TEXT NOT NULL,reservation_id TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,creation_started_at INTEGER,confirmed_at INTEGER) STRICT;
  CREATE TABLE IF NOT EXISTS hosted_model_probes(campaign_id TEXT PRIMARY KEY,model_id TEXT NOT NULL,pricing_snapshot_id TEXT NOT NULL,verified_at INTEGER NOT NULL) STRICT;`);
}
export function listVersionNodes(
  input: { ownerScope: string; campaignId: string },
  context: HostedContext,
): NodeRecord[] {
  initializeEvolution(context);
  return context.db
    .prepare(
      "SELECT node_json FROM hosted_versions WHERE owner_scope=? AND campaign_id=? ORDER BY created_at,id",
    )
    .all(input.ownerScope, input.campaignId)
    .map((row) => nodeRecordSchema.parse(JSON.parse(String(row.node_json))));
}
export function getVersionHarness(
  input: { ownerScope: string; campaignId: string; nodeId: string },
  context: HostedContext,
): HarnessArtifact {
  const row = context.db
    .prepare(
      "SELECT harness_json FROM hosted_versions WHERE owner_scope=? AND campaign_id=? AND id=?",
    )
    .get(input.ownerScope, input.campaignId, input.nodeId);
  if (!row) throw new HostedError("NOT_FOUND", "Not found.", 404);
  return harnessArtifactSchema.parse(JSON.parse(String(row.harness_json)));
}
export async function startHostedCampaign(
  input: CreateCampaignInput,
  context: HostedContext,
): Promise<Campaign> {
  initializeEvolution(context);
  // Replays must return the original effect even when the provider is temporarily unavailable.
  const replay = context.db
    .prepare(
      "SELECT effect_id,request_digest FROM idempotency_records WHERE owner_scope=? AND key=? AND route='campaigns'",
    )
    .get(input.ownerScope, input.idempotencyKey);
  if (replay) {
    if (replay.request_digest !== requestDigest(input))
      throw new HostedError(
        "IDEMPOTENCY_CONFLICT",
        "Operation key already used.",
        409,
      );
    const old = getCampaign(
      { ownerScope: input.ownerScope, campaignId: String(replay.effect_id) },
      context,
    );
    if (old) return old;
  }
  if (
    input.benchmarkId !== "coding-adversarial-v1" ||
    !["pi-1.4.0", tokenHarnessId].includes(input.harnessId)
  )
    throw new HostedError(
      "CONFIGURATION_INVALID",
      "Choose the approved Pi harness and coding benchmark.",
      422,
    );
  if (!input.acceptedPricingSnapshotId)
    throw new HostedError(
      "PRICING_UNAVAILABLE",
      "Review the current model price.",
      422,
    );
  const accepted = getPricingSnapshot(
    {
      ownerScope: input.ownerScope,
      pricingSnapshotId: input.acceptedPricingSnapshotId,
    },
    context,
  );
  const catalog = await listEligibleModels(
    {
      ownerScope: input.ownerScope,
      credentialId: input.credentialId,
      refresh: true,
    },
    context,
  );
  if (catalog.selectedModelId !== input.modelId)
    throw new HostedError(
      "MODEL_NOT_ALLOWED",
      "This pilot uses the cheapest compatible Nemotron. Refresh and select the recommended model.",
      422,
    );
  const model = catalog.models.find((model) => model.id === input.modelId);
  if (
    !model?.pricingSnapshotId ||
    accepted.modelId !== input.modelId ||
    accepted.credentialId !== input.credentialId
  )
    throw new HostedError(
      "PRICING_UNAVAILABLE",
      "The price snapshot does not match the selection.",
      409,
    );
  const current = getPricingSnapshot(
    {
      ownerScope: input.ownerScope,
      pricingSnapshotId: model.pricingSnapshotId,
    },
    context,
  );
  if (current.hash !== accepted.hash)
    throw new HostedError(
      "PRICING_UNAVAILABLE",
      "Model prices changed. Review the current rates.",
      409,
    );
  await loadBenchmark(input.benchmarkId);
  return createCampaign(input, context);
}
export function controlCampaign(
  input: {
    ownerScope: string;
    campaignId: string;
    action: "pause" | "resume" | "stop";
    expectedRevision: number;
    operationId: string;
  },
  context: HostedContext,
): Campaign {
  initializeEvolution(context);
  z.uuid().parse(input.operationId);
  return withHostedTransaction(context.db, () => {
    const route = `campaigns/${input.campaignId}/control`,
      digest = requestDigest(input);
    const replay = context.db
      .prepare(
        "SELECT request_digest FROM idempotency_records WHERE owner_scope=? AND key=? AND route=?",
      )
      .get(input.ownerScope, input.operationId, route);
    if (replay) {
      if (replay.request_digest !== digest)
        throw new HostedError(
          "IDEMPOTENCY_CONFLICT",
          "Operation key reused.",
          409,
        );
      const result = getCampaign(input, context);
      if (!result) throw new HostedError("NOT_FOUND", "Not found.", 404);
      return result;
    }
    const campaign = getCampaign(input, context);
    if (!campaign) throw new HostedError("NOT_FOUND", "Not found.", 404);
    const status =
      input.action === "resume"
        ? "queued"
        : input.action === "stop"
          ? "stopping"
          : "pausing";
    const updated = updateCampaign(
      {
        ...input,
        status,
        desiredControl:
          input.action === "resume"
            ? "run"
            : input.action === "stop"
              ? "stop"
              : "pause",
        waitReason: null,
      },
      context,
    );
    if (input.action !== "resume")
      revokeCampaignGatewayGrants(campaign.id, context);
    if (
      input.action === "resume" ||
      input.action === "stop" ||
      campaign.status === "waiting" ||
      campaign.status === "paused"
    )
      context.db
        .prepare(
          "UPDATE jobs SET state='queued',available_at=?,attempt_count=0,updated_at=? WHERE owner_scope=? AND campaign_id=? AND state IN ('waiting','queued')",
        )
        .run(now(context), now(context), input.ownerScope, input.campaignId);
    context.db
      .prepare(
        "INSERT INTO idempotency_records(id,owner_scope,key,method,route,request_digest,effect_id,created_at) VALUES(?,?,?,'POST',?,?,?,?)",
      )
      .run(
        randomUUID(),
        input.ownerScope,
        input.operationId,
        route,
        digest,
        campaign.id,
        now(context),
      );
    return updated;
  });
}
export function getCampaignProjection(
  input: { ownerScope: string; campaignId: string },
  context: HostedContext,
) {
  initializeEvolution(context);
  return withHostedTransaction(context.db, () => {
    const campaign = getCampaign(input, context);
    if (!campaign) throw new HostedError("NOT_FOUND", "Not found.", 404);
    const proposals = context.db
      .prepare(
        "SELECT p.parent_id,p.proposal_json,p.node_id,p.round,o.outcome_json FROM hosted_proposals p LEFT JOIN hosted_proposal_outcomes o ON o.owner_scope=p.owner_scope AND o.campaign_id=p.campaign_id AND o.round=p.round AND o.ordinal=p.ordinal WHERE p.owner_scope=? AND p.campaign_id=? ORDER BY p.round,p.ordinal",
      )
      .all(input.ownerScope, input.campaignId)
      .map((row) => ({
        parentId: String(row.parent_id),
        hypothesis: hostedProposalSchema.parse(
          JSON.parse(String(row.proposal_json)),
        ).hypothesis,
        nodeId: row.node_id === null ? null : String(row.node_id),
        round: Number(row.round),
        ...(row.outcome_json
          ? z
              .object({
                outcome: z.literal("quarantined"),
                failurePhase: z.enum(["parent", "candidate"]),
                error: z.string().max(300),
              })
              .parse(JSON.parse(String(row.outcome_json)))
          : {}),
      }));
    const taskAttempts = context.db
      .prepare(
        "SELECT id,node_id,role,task_id,status,created_at,updated_at FROM hosted_attempts WHERE owner_scope=? AND campaign_id=? ORDER BY created_at DESC LIMIT 100",
      )
      .all(input.ownerScope, input.campaignId)
      .map((row) => ({
        id: String(row.id),
        nodeId: String(row.node_id),
        role: String(row.role),
        taskId: String(row.task_id),
        status: String(row.status),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      }));
    const sequence = Number(
      context.db
        .prepare(
          "SELECT COALESCE(MAX(sequence),0) AS seq FROM campaign_events WHERE owner_scope=? AND campaign_id=?",
        )
        .get(input.ownerScope, input.campaignId)?.seq ?? 0,
    );
    const accounts = getBudgetSummary(input, context);
    function budget(account: typeof accounts.compute) {
      const available =
        account.admissionLimitUsdMicros -
        account.settledUsdMicros -
        account.reservedUsdMicros;
      return {
        currency: "USD",
        unit: "micros",
        limitUsdMicros: account.hardLimitUsdMicros.toString(),
        admissionLimitUsdMicros: account.admissionLimitUsdMicros.toString(),
        settledEstimateUsdMicros: account.settledUsdMicros.toString(),
        reservedUsdMicros: account.reservedUsdMicros.toString(),
        availableForAdmissionUsdMicros: (available > 0n
          ? available
          : 0n
        ).toString(),
        unknownReservationCount: account.unknownReservationCount,
        estimateStatus:
          account.status === "blocked"
            ? "reconciliation_required"
            : account.unknownReservationCount
              ? "contains_unknown_usage"
              : "known_estimate",
        asOf: now(context),
      };
    }
    return {
      campaign: {
        id: campaign.id,
        status: campaign.status,
        waitReason: campaign.waitReason,
        desiredControl: campaign.desiredControl,
        revision: campaign.revision,
        modelId: campaign.modelId,
        benchmarkId: campaign.benchmarkId,
        harnessId: campaign.harnessId,
        createdAt: campaign.createdAt,
        updatedAt: campaign.updatedAt,
        config: {
          name: campaign.config.name,
          beamWidth: campaign.config.beamWidth,
          maxSiblingBranches: campaign.config.maxSiblingBranches ?? 6,
        },
        checkpoint: {
          phase: campaign.checkpoint.phase,
          round: campaign.checkpoint.round,
          level: campaign.checkpoint.level,
        },
      },
      nodes: listVersionNodes(input, context),
      proposals,
      taskAttempts,
      budgets: {
        compute:
          campaign.harnessId === tokenHarnessId
            ? undefined
            : budget(accounts.compute),
        inference: budget(accounts.inference),
      },
      artifacts: listArtifacts(input, context),
      eventCursor: Buffer.from(
        JSON.stringify({ v: 1, c: campaign.id, s: sequence }),
      ).toString("base64url"),
    };
  });
}
export function listOwnedCampaigns(
  input: { ownerScope: string },
  context: HostedContext,
) {
  return listCampaigns(input, context);
}
