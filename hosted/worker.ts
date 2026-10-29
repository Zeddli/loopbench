import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { loadBenchmark } from "../core/benchmarks";
import { canonicalSubmissionPolicy } from "./task-workspaces";
import { continueRoundEnvelope, executionFailureCode } from "./round-recovery";
import {
  tokenHarnessId,
  loadTokenHarness,
  makeTokenSandboxContext,
} from "./tokenfactory-sandboxes";
import { generateCurriculumBenchmark } from "../core/curriculum";
import {
  nodeRecordSchema,
  taskResultSchema,
  type NodeRecord,
  type TaskResult,
} from "../core/types";
import {
  loadApprovedHarness,
  hashHarnessArtifact,
  harnessArtifactSchema,
  type HarnessArtifact,
} from "./harnesses";
import { runTaskAttempt, type TaskAttemptResult } from "./attempts";
import {
  initializeEvolution,
  getVersionHarness,
  listVersionNodes,
} from "./evolution";
import { getCampaign, updateCampaign } from "./store";
import { assertLease, claimJob, heartbeatJob, updateJob } from "./jobs";
import { appendCampaignEvent } from "./events";
import { reserveBudget, releaseReservation, getBudgetSummary } from "./budget";
import {
  issueGatewayToken,
  revokeGatewayGrant,
  revokeCampaignGatewayGrants,
  confirmScopedCallLimit,
  confirmCompletedAttemptCalls,
} from "./gateway-tokens";
import { getPricingSnapshot } from "./pricing";
import { listEligibleModels } from "./models";
import {
  adaptiveBranchCount,
  hostedProposalSchema,
  probeNemotron,
  proposeHarnessBranches,
} from "./optimizer";
import { saveArtifact } from "./artifacts";
import { makeSandboxContext, sandboxLifetimeBound } from "./runtime-sandboxes";
import {
  HostedError,
  now,
  type Campaign,
  type HostedContext,
  type Lease,
  type WaitReason,
} from "./schema";
import { withHostedTransaction } from "./database";
import { verifyComputePolicy } from "./operations";

const checkpointSchema = z.object({
  phase: z
    .enum(["probe", "baseline", "propose", "parent", "candidate", "challenge"])
    .default("probe"),
  round: z.number().int().nonnegative().default(0),
  level: z.number().int().nonnegative().default(0),
  failedLevels: z.array(z.number().int().positive()).default([]),
  proposalFailures: z.number().int().nonnegative().default(0),
  proposalFeedback: z.string().max(2000).optional(),
  benchmarkPath: z.string().optional(),
  championId: z.string().nullable().default(null),
  roundParentId: z.string().nullable().default(null),
  activeNodeId: z.string().nullable().default(null),
  proposalIndex: z.number().int().nonnegative().default(0),
  taskIndex: z.number().int().nonnegative().default(0),
  parentTasks: z.array(taskResultSchema).default([]),
  candidateTasks: z.array(taskResultSchema).default([]),
  roundEnvelopeId: z.string().optional(),
  mastered: z.boolean().default(false),
});
type Checkpoint = z.infer<typeof checkpointSchema>;
export interface WorkerDependencies {
  jobId?: string;
  loadHarness: typeof loadApprovedHarness;
  runTaskAttempt: typeof runTaskAttempt;
  probe: typeof probeNemotron;
  propose: typeof proposeHarnessBranches;
  verifyComputePolicy: typeof verifyComputePolicy;
  refreshPrices: typeof refreshPrices;
}
function campaignFor(lease: Lease, context: HostedContext): Campaign {
  const campaign = getCampaign(lease, context);
  if (!campaign) throw new HostedError("NOT_FOUND", "Not found.", 404);
  return campaign;
}
function checkpoint(lease: Lease, point: Checkpoint, context: HostedContext) {
  const campaign = campaignFor(lease, context);
  updateCampaign(
    { ...lease, expectedRevision: campaign.revision, checkpoint: point, lease },
    context,
  );
}
function nodeById(nodes: NodeRecord[], id: string | null): NodeRecord {
  const node = nodes.find((node) => node.id === id);
  if (!node) throw new Error("Missing version ancestry");
  return node;
}
function persistNode(
  node: NodeRecord,
  harness: HarnessArtifact,
  lease: Lease,
  context: HostedContext,
) {
  assertLease(lease, context);
  context.db
    .prepare(
      "INSERT INTO hosted_versions(id,owner_scope,campaign_id,parent_id,harness_json,node_json,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET node_json=excluded.node_json",
    )
    .run(
      node.id,
      lease.ownerScope,
      lease.campaignId,
      node.parentId,
      JSON.stringify(harness),
      JSON.stringify(node),
      Date.parse(node.createdAt),
    );
}
function createNode(input: {
  id: string;
  parentId: string | null;
  hypothesis: string;
  harness: HarnessArtifact;
  campaign: Campaign;
  benchmark: { id: string; hash: string; sourcePath: string; tasks: unknown[] };
  point: Checkpoint;
  learning?: NodeRecord["learning"];
}): NodeRecord {
  return nodeRecordSchema.parse({
    id: input.id,
    treeId: input.campaign.id,
    parentId: input.parentId,
    hypothesis: input.hypothesis,
    createdAt: new Date().toISOString(),
    completedAt: null,
    harnessHash: hashHarnessArtifact(input.harness),
    config: {
      adapterId:
        input.campaign.harnessId === tokenHarnessId
          ? "tokenfactory-pi"
          : "e2b-pi",
      domain: "coding",
      model: input.campaign.modelId,
      harness: "Pi 1.4.0",
      benchmarkId: input.benchmark.id,
      benchmarkHash: input.benchmark.hash,
      benchmarkPath: input.benchmark.sourcePath,
      lineageId: input.campaign.id,
      settings: {
        piVersion: input.harness.runtime.piVersion,
        nodeVersion: input.harness.runtime.nodeVersion,
        templateId: input.harness.runtime.templateId,
        verifierTemplateId: input.harness.runtime.verifierTemplateId,
        supervisorSha256: input.harness.runtime.supervisorSha256,
        toolDefinitionsSha256: input.harness.runtime.toolDefinitionsSha256,
        networkPolicy:
          input.campaign.harnessId === tokenHarnessId
            ? "guest network disabled; host-mediated inference relay; verifier no network"
            : "deny-all-egress; agent gateway HTTPS only; verifier no egress",
        executionProvider:
          input.campaign.harnessId === tokenHarnessId ? "tokenfactory" : "e2b",
        comparisonId: input.id,
        instructions: input.harness.systemPrompt,
        agentCallLimit: String(input.campaign.config.maxCallsPerTask ?? 8),
        submissionPolicy: canonicalSubmissionPolicy,
        completionPolicy:
          "settled output requires a canonical submission; trusted missing-leaf receipts fail the task, available artifacts receive fresh verification; provider failures never scored",
        inferenceProtocol: "nebius-non-thinking-v1",
      },
    },
    status: "running",
    totalTasks: input.benchmark.tasks.length,
    tasks: [],
    score: null,
    comparison: null,
    error: null,
    learning: input.learning,
    event: input.point.phase === "challenge" ? "challenge" : "evaluation",
    curriculum: {
      level: input.point.level,
      benchmarkHash: input.benchmark.hash,
      benchmarkId: input.benchmark.id,
    },
  });
}
function availableInference(campaign: Campaign, context: HostedContext) {
  const account = getBudgetSummary(
    { ownerScope: campaign.ownerScope, campaignId: campaign.id },
    context,
  ).inference;
  return (
    account.admissionLimitUsdMicros -
    account.settledUsdMicros -
    account.reservedUsdMicros
  );
}
async function refreshPrices(campaign: Campaign, context: HostedContext) {
  if (!campaign.acceptedPricingSnapshotId)
    throw new HostedError(
      "PRICING_UNAVAILABLE",
      "Price consent required.",
      409,
    );
  const old = getPricingSnapshot(
    {
      ownerScope: campaign.ownerScope,
      pricingSnapshotId: campaign.acceptedPricingSnapshotId,
      allowExpired: true,
    },
    context,
  );
  if (old.expiresAt - now(context) > 660000) return;
  const live = await listEligibleModels(
    {
      ownerScope: campaign.ownerScope,
      credentialId: campaign.credentialId,
      refresh: true,
    },
    context,
  );
  const model = live.models.find((model) => model.id === campaign.modelId);
  if (!model?.enabled || !model.pricingSnapshotId)
    throw new HostedError(
      "PRICING_UNAVAILABLE",
      "Pinned model is no longer available.",
      409,
    );
  const price = getPricingSnapshot(
    {
      ownerScope: campaign.ownerScope,
      pricingSnapshotId: model.pricingSnapshotId,
    },
    context,
  );
  if (price.hash !== old.hash)
    throw new HostedError(
      "PRICING_UNAVAILABLE",
      "Prices changed. Explicit price consent is required.",
      409,
    );
  // Same rates may refresh observation without changing model or spending permission.
  context.db
    .prepare(
      "UPDATE campaigns SET accepted_pricing_snapshot_id=? WHERE id=? AND owner_scope=? AND accepted_pricing_snapshot_id=? AND pricing_consent_revision=? AND desired_control='run'",
    )
    .run(
      price.id,
      campaign.id,
      campaign.ownerScope,
      old.id,
      campaign.pricingConsentRevision,
    );
}
/** One durable step. Long-running Pi work is supervised remotely and heartbeats independently. */
export async function runHostedStep(
  lease: Lease,
  context: HostedContext,
  dependencies: Partial<WorkerDependencies> = {},
): Promise<void> {
  initializeEvolution(context);
  assertLease(lease, context);
  let campaign = campaignFor(lease, context);
  if (campaign.desiredControl !== "run") {
    revokeCampaignGatewayGrants(campaign.id, context);
    const count = Number(
      context.db
        .prepare(
          "SELECT COUNT(*) AS n FROM hosted_sandbox_intents WHERE campaign_id=? AND status!='terminated' AND status!='prepared'",
        )
        .get(campaign.id)?.n ?? 0,
    );
    const tokenCount = context.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='token_sandbox_intents'",
      )
      .get()
      ? Number(
          context.db
            .prepare(
              "SELECT COUNT(*) AS n FROM token_sandbox_intents WHERE campaign_id=? AND status!='terminated'",
            )
            .get(campaign.id)?.n ?? 0,
        )
      : 0;
    if (count + tokenCount > 0) {
      updateJob(
        { lease, state: "queued", availableAt: now(context) + 15000 },
        context,
      );
      return;
    }
    if (campaign.desiredControl === "stop")
      updateCampaign(
        {
          ...lease,
          expectedRevision: campaign.revision,
          status: "stopped",
          lease,
        },
        context,
      );
    else
      updateCampaign(
        {
          ...lease,
          expectedRevision: campaign.revision,
          status: "paused",
          lease,
        },
        context,
      );
    updateJob(
      {
        lease,
        state: campaign.desiredControl === "stop" ? "completed" : "waiting",
      },
      context,
    );
    return;
  }
  if (campaign.status === "queued")
    campaign = updateCampaign(
      {
        ...lease,
        expectedRevision: campaign.revision,
        status: "running",
        lease,
      },
      context,
    );
  const tokenFactory = campaign.harnessId === tokenHarnessId;
  if (
    tokenFactory &&
    (!process.env.NEBIUS_API_KEY || !process.env.NEBIUS_PROJECT_ID)
  )
    throw new HostedError(
      "RUNTIME_UNAVAILABLE",
      "Configure the operator Token Factory sandbox project.",
      503,
    );
  if (
    !tokenFactory &&
    (!context.config.e2bApiKey || !context.config.e2bTemplateId)
  )
    throw new HostedError(
      "RUNTIME_UNAVAILABLE",
      "Configure the operator E2B account and approved template.",
      503,
    );
  if (!tokenFactory)
    (dependencies.verifyComputePolicy ?? verifyComputePolicy)(context);
  const origin = new URL(context.config.gatewayOrigin);
  if (
    !tokenFactory &&
    (origin.protocol !== "https:" ||
      ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
  )
    throw new HostedError(
      "RUNTIME_UNAVAILABLE",
      "E2B requires a reachable public HTTPS inference gateway.",
      503,
    );
  const approved = tokenFactory
    ? await loadTokenHarness()
    : await (dependencies.loadHarness ?? loadApprovedHarness)({
        templateId: context.config.e2bTemplateId,
        manifestPath: process.env.LOOPBENCH_RUNNER_MANIFEST,
      });
  if (!tokenFactory) sandboxLifetimeBound(context);
  await (dependencies.refreshPrices ?? refreshPrices)(campaign, context);
  campaign = campaignFor(lease, context);
  const point = checkpointSchema.parse(campaign.checkpoint);
  if (point.phase === "probe") {
    await (dependencies.probe ?? probeNemotron)({ campaign, lease }, context);
    assertLease(lease, context);
    context.db
      .prepare("INSERT OR REPLACE INTO hosted_model_probes VALUES(?,?,?,?)")
      .run(
        campaign.id,
        campaign.modelId,
        campaign.acceptedPricingSnapshotId,
        now(context),
      );
    point.phase = "baseline";
    checkpoint(lease, point, context);
    return;
  }
  const benchmark = await loadBenchmark(
    point.benchmarkPath ?? "coding-adversarial-v1",
  );
  const nodes = listVersionNodes(lease, context);
  if (point.phase === "propose") {
    const parent = nodeById(nodes, point.championId),
      harness = getVersionHarness({ ...lease, nodeId: parent.id }, context);
    const sameSuite = nodes.filter(
      (node) => node.config.benchmarkHash === benchmark.hash,
    );
    const width = adaptiveBranchCount(sameSuite);
    const bound = tokenFactory
      ? null
      : sandboxLifetimeBound(context) *
        BigInt(width * benchmark.tasks.length * 4);
    // Preflight full fresh-parent + candidate + verifier compute, then transfer child holds.
    if (availableInference(campaign, context) < 10000n)
      throw new HostedError(
        "INFERENCE_BUDGET",
        "Insufficient inference allowance to propose another measured round.",
        429,
      );
    const envelope =
      bound === null
        ? undefined
        : reserveBudget(
            {
              ownerScope: lease.ownerScope,
              campaignId: lease.campaignId,
              kind: "compute",
              amountUsdMicros: bound,
              operationId: `round-${point.round + 1}`,
              operationKey: `round:${point.round + 1}`,
              operationKind: "round_envelope",
              lease,
            },
            context,
          );
    const proposals = await (dependencies.propose ?? proposeHarnessBranches)(
      {
        campaign,
        lease,
        parent,
        nodes,
        harness,
        width,
        round: point.round + 1,
        feedback: point.proposalFeedback,
      },
      context,
    );
    withHostedTransaction(context.db, () => {
      assertLease(lease, context);
      for (const [ordinal, item] of proposals.entries())
        context.db
          .prepare("INSERT INTO hosted_proposals VALUES(?,?,?,?,?,?,?,?,NULL)")
          .run(
            randomUUID(),
            lease.ownerScope,
            lease.campaignId,
            parent.id,
            point.round + 1,
            ordinal,
            JSON.stringify(item.proposal),
            JSON.stringify(item.harness),
          );
      point.round++;
      point.proposalFailures = 0;
      delete point.proposalFeedback;
      point.roundParentId = parent.id;
      point.proposalIndex = 0;
      point.phase = "parent";
      point.taskIndex = 0;
      point.parentTasks = [];
      point.candidateTasks = [];
      point.activeNodeId = null;
      point.roundEnvelopeId = envelope?.id;
      point.mastered = parent.score === 1;
      checkpoint(lease, point, context);
      appendCampaignEvent(
        {
          ...lease,
          type: "round.proposed",
          payload: { round: point.round, parentId: parent.id, width },
          lease,
        },
        context,
      );
    });
    return;
  }
  let harness = approved,
    versionId = point.activeNodeId,
    hypothesis = "Pi / Nemotron baseline on six coding contracts",
    parentId: string | null = null,
    learning: NodeRecord["learning"] | undefined;
  if (point.phase === "parent" || point.phase === "candidate") {
    const row = context.db
      .prepare(
        "SELECT * FROM hosted_proposals WHERE owner_scope=? AND campaign_id=? AND round=? AND ordinal=?",
      )
      .get(
        lease.ownerScope,
        lease.campaignId,
        point.round,
        point.proposalIndex,
      );
    if (!row) throw new Error("Missing persisted sibling proposal");
    const proposal = hostedProposalSchema.parse(
      JSON.parse(String(row.proposal_json)),
    );
    parentId = point.roundParentId;
    harness =
      point.phase === "parent"
        ? getVersionHarness({ ...lease, nodeId: String(parentId) }, context)
        : harnessArtifactSchema.parse(JSON.parse(String(row.harness_json)));
    hypothesis = proposal.hypothesis;
    learning = {
      learnedFrom: proposal.learnedFrom,
      diagnosis: proposal.diagnosis,
      change: proposal.change,
      prediction: proposal.prediction,
      proposer: `Nemotron / Token Factory (${campaign.modelId})`,
      round: point.round,
    };
  } else if (point.phase === "challenge") {
    parentId = point.championId;
    harness = getVersionHarness(
      { ...lease, nodeId: String(parentId) },
      context,
    );
    hypothesis = `Independent curriculum level ${point.level}: test the current harness on harder cases`;
  }
  if (!versionId) {
    versionId = randomUUID();
    point.activeNodeId = versionId;
    if (point.phase !== "parent")
      persistNode(
        createNode({
          id: versionId,
          parentId,
          hypothesis,
          harness,
          campaign,
          benchmark,
          point,
          learning,
        }),
        harness,
        lease,
        context,
      );
    checkpoint(lease, point, context);
  }
  // A candidate becomes a visible graph node only when its actual harness starts running.
  if (
    point.phase === "candidate" &&
    !nodes.some((node) => node.id === versionId)
  )
    persistNode(
      createNode({
        id: versionId,
        parentId,
        hypothesis,
        harness,
        campaign,
        benchmark,
        point,
        learning,
      }),
      harness,
      lease,
      context,
    );
  const task = benchmark.tasks[point.taskIndex];
  if (!task) throw new Error("Invalid task checkpoint");
  const role = point.phase === "parent" ? "parent" : "candidate";
  const previous = context.db
    .prepare(
      "SELECT * FROM hosted_attempts WHERE campaign_id=? AND node_id=? AND role=? AND task_id=? ORDER BY created_at DESC LIMIT 1",
    )
    .get(campaign.id, versionId, role, task.id);
  if (previous?.status === "running")
    throw new HostedError(
      "RECONCILIATION_REQUIRED",
      "A previous task was interrupted. Its sandbox must be reconciled before a deliberate retry.",
      503,
    );
  const recovered =
    previous && ["passed", "benchmark_failed"].includes(String(previous.status))
      ? z
          .object({
            attemptId: z.string(),
            taskId: z.string(),
            status: z.enum([
              "passed",
              "benchmark_failed",
              "infrastructure_failed",
            ]),
            error: z.string().nullable(),
            submissionHash: z.string().nullable(),
            artifacts: z.array(z.string()),
            cleanupPending: z.boolean(),
            failureCode: z.string().optional(),
            terminationReason: z
              .enum([
                "agent_completed",
                "attempt_call_limit",
                "output_token_limit",
              ])
              .optional(),
          })
          .parse(JSON.parse(String(previous.result_json)))
      : null;
  const attemptId = recovered?.attemptId ?? randomUUID(),
    agentIntentId = randomUUID(),
    verifierIntentId = randomUUID(),
    started = recovered ? Number(previous?.created_at) : now(context);
  if (!recovered && point.roundEnvelopeId) {
    const currentEnvelopeId = point.roundEnvelopeId;
    // Fund the agent AND its independent verifier before paying for a new Pi run.
    const siblings = Number(
      context.db
        .prepare(
          "SELECT COUNT(*) AS n FROM hosted_proposals WHERE campaign_id=? AND round=?",
        )
        .get(campaign.id, point.round)?.n ?? 0,
    );
    const tasks = benchmark.tasks.length;
    const remainingTasks =
      (point.phase === "parent" ? tasks * 2 : tasks) -
      point.taskIndex +
      Math.max(0, siblings - point.proposalIndex - 1) * tasks * 2;
    withHostedTransaction(context.db, () => {
      const envelope = continueRoundEnvelope(
        {
          ...lease,
          envelopeId: currentEnvelopeId,
          round: point.round,
          minimumUsdMicros: sandboxLifetimeBound(context) * 2n,
          remainingUsdMicros:
            sandboxLifetimeBound(context) * BigInt(remainingTasks * 2),
          lease,
        },
        context,
      );
      if (envelope.id !== point.roundEnvelopeId) {
        point.roundEnvelopeId = envelope.id;
        checkpoint(lease, point, context);
      }
    });
  }
  if (!recovered)
    context.db
      .prepare(
        "INSERT INTO hosted_attempts VALUES(?,?,?,?,?,?,'running',NULL,?,?,?,?)",
      )
      .run(
        attemptId,
        lease.ownerScope,
        campaign.id,
        versionId,
        role,
        task.id,
        agentIntentId,
        verifierIntentId,
        started,
        started,
      );
  const result: TaskAttemptResult =
    recovered ??
    (await (dependencies.runTaskAttempt ?? runTaskAttempt)(
      {
        attemptId,
        ownerScope: lease.ownerScope,
        campaignId: campaign.id,
        taskId: task.id,
        benchmarkHash: benchmark.hash,
        benchmarkPath: benchmark.sourcePath,
        harness,
        model: { id: campaign.modelId, contextWindow: 131072, maxTokens: 4096 },
        gatewayOrigin: `${context.config.gatewayOrigin.replace(/\/$/, "")}/api/inference/v1`,
        agentIntentId,
        verifierIntentId,
      },
      {
        sandboxes: tokenFactory
          ? makeTokenSandboxContext({ lease }, context)
          : makeSandboxContext(
              { lease, parentReservationId: point.roundEnvelopeId },
              context,
            ),
        async assertFence() {
          assertLease(lease, context);
        },
        async grant() {
          const value = issueGatewayToken(
            {
              ownerScope: lease.ownerScope,
              campaignId: campaign.id,
              credentialId: campaign.credentialId,
              modelId: campaign.modelId,
              role: "pi_attempt",
              attemptId,
              maxCalls: z
                .number()
                .int()
                .min(2)
                .max(24)
                .parse(campaign.config.maxCallsPerTask ?? 8),
              lease,
            },
            context,
          );
          return {
            token: value.token,
            async revoke() {
              revokeGatewayGrant(value.id, context);
            },
          };
        },
        async event(type, payload) {
          appendCampaignEvent({ ...lease, type, payload, lease }, context);
        },
        async saveArtifact(kind, contents) {
          return saveArtifact(
            {
              ...lease,
              kind,
              contents,
              visibility:
                kind === "pi-events" || kind === "platform-diagnostic"
                  ? "internal_only"
                  : "owner",
            },
            context,
          ).id;
        },
        async poll() {
          await delay(1200);
          assertLease(lease, context);
          if (campaignFor(lease, context).desiredControl !== "run")
            throw new HostedError(
              "CAMPAIGN_NOT_RUNNING",
              "Experiment control requested.",
              409,
            );
        },
        async scopedCallLimitConfirmed() {
          return confirmScopedCallLimit(
            {
              ownerScope: lease.ownerScope,
              campaignId: campaign.id,
              attemptId,
            },
            context,
          );
        },
        async completedProviderCallsConfirmed() {
          return confirmCompletedAttemptCalls(
            {
              ownerScope: lease.ownerScope,
              campaignId: campaign.id,
              attemptId,
            },
            context,
          );
        },
      },
    ));
  assertLease(lease, context);
  context.db
    .prepare(
      "UPDATE hosted_attempts SET status=?,result_json=?,updated_at=? WHERE id=? AND owner_scope=?",
    )
    .run(
      result.status,
      JSON.stringify(result),
      now(context),
      attemptId,
      lease.ownerScope,
    );
  if (result.status === "infrastructure_failed" || result.cleanupPending) {
    // Infrastructure failures do not become benchmark wrong answers or accepted comparisons.
    withHostedTransaction(context.db, () => {
      const active = listVersionNodes(lease, context).find(
        (node) => node.id === versionId,
      );
      if (active)
        persistNode(
          {
            ...active,
            status: "failed",
            error: result.cleanupPending
              ? "Sandbox cleanup pending"
              : "Execution could not complete trusted verification",
            score: null,
            completedAt: new Date().toISOString(),
          },
          harness,
          lease,
          context,
        );
      // Failure and checkpoint reset are atomic, so resume cannot rewrite a failed node.
      point.activeNodeId = null;
      point.taskIndex = 0;
      point.parentTasks = [];
      point.candidateTasks = [];
      if (point.phase === "candidate") point.phase = "parent";
      checkpoint(lease, point, context);
    });
    const gatewayError = context.db
      .prepare(
        "SELECT last_error_code FROM gateway_grants WHERE attempt_id=? AND last_error_code IS NOT NULL ORDER BY expires_at DESC LIMIT 1",
      )
      .get(attemptId);
    const code = executionFailureCode(
      result.failureCode,
      gatewayError ? String(gatewayError.last_error_code) : undefined,
    );
    throw new HostedError(
      result.cleanupPending ? "RECONCILIATION_REQUIRED" : code,
      result.error ??
        "Task execution did not complete. Check provider calls and runtime availability.",
      503,
    );
  }
  const taskResult: TaskResult = {
    taskId: task.id,
    passed: result.status === "passed",
    durationMs: now(context) - started,
    output: "",
    error: result.error,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  };
  if (
    !taskResult.passed &&
    point.level > 0 &&
    !point.failedLevels.includes(point.level)
  )
    point.failedLevels.push(point.level);
  if (point.phase === "parent") point.parentTasks.push(taskResult);
  else point.candidateTasks.push(taskResult);
  point.taskIndex++;
  if (point.phase !== "parent") {
    const active = nodeById(listVersionNodes(lease, context), versionId);
    persistNode(
      { ...active, tasks: point.candidateTasks },
      harness,
      lease,
      context,
    );
  }
  if (point.taskIndex < benchmark.tasks.length) {
    checkpoint(lease, point, context);
    return;
  }
  if (point.phase === "parent") {
    point.phase = "candidate";
    point.taskIndex = 0;
    checkpoint(lease, point, context);
    return;
  }
  const active = nodeById(listVersionNodes(lease, context), versionId),
    score =
      point.candidateTasks.filter((task) => task.passed).length /
      benchmark.tasks.length;
  const parentScore =
    point.parentTasks.filter((task) => task.passed).length /
    benchmark.tasks.length;
  const paired = point.phase === "candidate";
  const finished: NodeRecord = {
    ...active,
    tasks: point.candidateTasks,
    score,
    status: paired
      ? score > parentScore
        ? "accepted"
        : "rejected"
      : "baseline",
    completedAt: new Date().toISOString(),
    comparison: paired
      ? {
          parentScore,
          candidateScore: score,
          delta: score - parentScore,
          method: "paired",
          parentTasks: point.parentTasks,
          reason:
            score > parentScore
              ? "Improved against a fresh parent run on identical acceptance cases"
              : score === parentScore
                ? "Tie against a fresh parent run"
                : "Regressed against a fresh parent run",
        }
      : null,
  };
  persistNode(finished, harness, lease, context);
  point.taskIndex = 0;
  point.candidateTasks = [];
  if (!paired) {
    point.championId = versionId;
    point.phase = "propose";
    point.activeNodeId = null;
    checkpoint(lease, point, context);
    return;
  }
  context.db
    .prepare(
      "UPDATE hosted_proposals SET node_id=? WHERE campaign_id=? AND round=? AND ordinal=?",
    )
    .run(versionId, campaign.id, point.round, point.proposalIndex);
  if (finished.status === "accepted") {
    const champion = nodeById(
      listVersionNodes(lease, context),
      point.championId,
    );
    if (champion.score === null || score >= champion.score)
      point.championId = versionId;
  }
  point.mastered ||= score === 1 || parentScore === 1;
  point.parentTasks = [];
  point.activeNodeId = null;
  point.proposalIndex++;
  const siblings = Number(
    context.db
      .prepare(
        "SELECT COUNT(*) AS n FROM hosted_proposals WHERE campaign_id=? AND round=?",
      )
      .get(campaign.id, point.round)?.n ?? 0,
  );
  if (point.proposalIndex < siblings) {
    point.phase = "parent";
    checkpoint(lease, point, context);
    return;
  }
  if (point.roundEnvelopeId) {
    releaseReservation(
      {
        ownerScope: lease.ownerScope,
        reservationId: point.roundEnvelopeId,
        reason:
          "Completed sibling round; child sandbox obligations retained separately",
        lease,
      },
      context,
    );
    delete point.roundEnvelopeId;
  }
  if (point.mastered) {
    const next = await generateCurriculumBenchmark({
      baseBenchmarkPath: "coding-adversarial-v1",
      level: point.level + 1,
      seed: campaign.id,
      dataDirectory: process.env.LOOPBENCH_PRIVATE_DATA_ROOT,
      pinnedLevels: point.failedLevels,
    });
    point.level++;
    point.benchmarkPath = next.path;
    point.phase = "challenge";
  } else point.phase = "propose";
  checkpoint(lease, point, context);
}
export function waitReasonFor(error: unknown): WaitReason {
  if (!(error instanceof HostedError)) return "runtime_unavailable";
  if (error.code === "INFERENCE_BUDGET") return "inference_budget";
  if (error.code === "BUDGET_NOT_AVAILABLE")
    return error.details?.kind === "inference"
      ? "inference_budget"
      : "compute_budget";
  if (error.code === "GLOBAL_CAPACITY") return "global_capacity";
  if (error.code === "PRICING_UNAVAILABLE") return "pricing_unavailable";
  if (error.code === "PROVIDER_QUOTA") return "provider_quota";
  if (error.code === "PROVIDER_AUTH") return "provider_auth";
  if (error.code === "RECONCILIATION_REQUIRED") return "reconciliation";
  return "runtime_unavailable";
}
export async function workerTick(
  workerId: string,
  context: HostedContext,
  dependencies: Partial<WorkerDependencies> = {},
): Promise<boolean> {
  const lease = claimJob({ workerId, jobId: dependencies.jobId }, context);
  if (!lease) return false;
  let leaseError: unknown = null;
  const timer = setInterval(() => {
    try {
      heartbeatJob(lease, context);
    } catch (error) {
      leaseError = error;
    }
  }, 15000);
  try {
    await runHostedStep(lease, context, dependencies);
    if (leaseError) throw leaseError;
    try {
      assertLease(lease, context);
      updateJob(
        { lease, state: "queued", availableAt: now(context) + 50 },
        context,
      );
    } catch (error) {
      if (!(error instanceof HostedError && error.code === "STALE_LEASE"))
        throw error;
    }
  } catch (error) {
    try {
      assertLease(lease, context);
      const campaign = campaignFor(lease, context);
      if (
        error instanceof HostedError &&
        error.code === "PROPOSAL_INVALID" &&
        campaign.desiredControl === "run" &&
        campaign.checkpoint.phase === "propose"
      ) {
        const point = checkpointSchema.parse(campaign.checkpoint);
        point.proposalFailures++;
        point.proposalFeedback = error.message.slice(0, 2000);
        checkpoint(lease, point, context);
        appendCampaignEvent(
          {
            ...lease,
            type: "optimizer.rejected",
            payload: {
              attempt: point.proposalFailures,
              reason: point.proposalFeedback,
              next:
                point.proposalFailures < 3
                  ? "metered_correction"
                  : "operator_hold",
            },
            lease,
          },
          context,
        );
        if (point.proposalFailures < 3) {
          updateJob(
            { lease, state: "queued", availableAt: now(context) + 1000 },
            context,
          );
          return true;
        }
        const held = campaignFor(lease, context);
        updateCampaign(
          {
            ...lease,
            expectedRevision: held.revision,
            status: "waiting",
            waitReason: "operator_hold",
            lease,
          },
          context,
        );
        updateJob(
          { lease, state: "waiting", errorCode: "PROPOSAL_INVALID" },
          context,
        );
        return true;
      }
      if (campaign.desiredControl !== "run")
        updateJob(
          { lease, state: "queued", availableAt: now(context) + 1000 },
          context,
        );
      else {
        updateCampaign(
          {
            ...lease,
            expectedRevision: campaign.revision,
            status: "waiting",
            waitReason: waitReasonFor(error),
            lease,
          },
          context,
        );
        updateJob(
          {
            lease,
            state: "waiting",
            errorCode:
              error instanceof HostedError ? error.code : "RUNTIME_UNAVAILABLE",
          },
          context,
        );
      }
    } catch {
      /* Lost fences cannot commit; reaper owns reconciliation. */
    }
  } finally {
    clearInterval(timer);
  }
  return true;
}
