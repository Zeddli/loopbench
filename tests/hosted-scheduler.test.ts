import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fixture } from "./hosted-foundation-fixture";
import { controlCampaign, getCampaignProjection } from "../hosted/evolution";
import { getCampaign } from "../hosted/store";
import { workerTick, type WorkerDependencies } from "../hosted/worker";
import { validateHarnessArtifact } from "../hosted/harnesses";
import { validateProposalSet } from "../hosted/optimizer";
import { listVersionNodes } from "../hosted/evolution";
import { dirname } from "node:path";
import type { ComputePolicyEvidence } from "../hosted/operations";
import { HostedError } from "../hosted/schema";
import type { TaskAttemptResult } from "../hosted/attempts";
import { savePricingSnapshot } from "../hosted/pricing";

function fullSchedulerFixture() {
  const f = fixture();
  f.context.config.e2bApiKey = "isolated-test-not-a-provider-key";
  f.context.config.e2bTemplateId = "isolated-template";
  f.context.config.gatewayOrigin = "https://isolated-gateway.example";
  const previousRate = process.env.LOOPBENCH_E2B_USD_PER_SECOND;
  const previousDataRoot = process.env.LOOPBENCH_PRIVATE_DATA_ROOT;
  process.env.LOOPBENCH_E2B_USD_PER_SECOND = "0.000001";
  process.env.LOOPBENCH_PRIVATE_DATA_ROOT = dirname(f.path);
  const campaign = f.campaign();
  const price = savePricingSnapshot(
    {
      ownerScope: campaign.ownerScope,
      credentialId: campaign.credentialId,
      modelId: campaign.modelId,
      promptUsdPerToken: "0.00000006",
      completionUsdPerToken: "0.00000024",
    },
    f.context,
  );
  f.context.db
    .prepare("UPDATE campaigns SET accepted_pricing_snapshot_id=? WHERE id=?")
    .run(price.id, campaign.id);
  const input = { ownerScope: campaign.ownerScope, campaignId: campaign.id };
  const base = validateHarnessArtifact({
    schemaVersion: 1,
    systemPrompt: "Inspect boundaries and run public checks.",
    skills: [],
    tools: "read-write-edit-bash",
    verificationPolicy: "public-smoke-and-review",
    compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 8192 },
    runtime: {
      piVersion: "1.4.0",
      nodeVersion: "v24.10.0",
      templateId: "isolated-template",
      verifierTemplateId: "isolated-verifier",
      supervisorSha256: "a".repeat(64),
      toolDefinitionsSha256: "b".repeat(64),
    },
  });
  const computeEvidence = {
    schemaVersion: 1,
    provider: "e2b",
    operationId: randomUUID(),
    projectReference: "isolated-test-only",
    hardLimitUsdMicros: "100000000",
    scope: "Isolated fixture",
    resetPeriod: "No reset",
    enforcement: "Deterministic test policy only",
    verifiedAt: new Date(f.context.now()).toISOString(),
  } satisfies ComputePolicyEvidence;
  let probeCount = 0;
  const attempts: {
    phase: unknown;
    round: unknown;
    versionId: unknown;
    taskId: string;
    benchmarkHash: string;
  }[] = [];
  const proposals: {
    round: number;
    parentId: string;
    width: number;
    visibleNodes: number;
  }[] = [];
  const dependencies: WorkerDependencies = {
    loadHarness: async () => base,
    refreshPrices: async () => undefined,
    verifyComputePolicy: () => computeEvidence,
    probe: async () => {
      probeCount++;
    },
    propose: async (request) => {
      const nodes = listVersionNodes(input, f.context);
      proposals.push({
        round: request.round,
        parentId: request.parent.id,
        width: request.width,
        visibleNodes: nodes.length,
      });
      return validateProposalSet(
        {
          proposals: Array.from({ length: request.width }, (_, index) => ({
            hypothesis: `Round ${request.round} sibling ${index}: test reusable boundary strategy`,
            systemPrompt: `Round ${request.round} sibling ${index}: inspect boundary conditions, preserve inputs and run public checks.`,
            learnedFrom: [request.parent.id],
            diagnosis: "Prior task verdicts identify boundary behavior.",
            change: `Use distinct inspection strategy ${index}.`,
            prediction:
              "The original independent verifier measures the effect.",
          })),
        },
        request,
      );
    },
    runTaskAttempt: async (request): Promise<TaskAttemptResult> => {
      const current = getCampaign(input, f.context);
      assert(current);
      const nodes = listVersionNodes(input, f.context);
      const point = current.checkpoint;
      if (point.phase === "parent")
        assert(
          !nodes.some((node) => node.id === point.activeNodeId),
          "Fresh parent reruns are evidence, not extra harness graph nodes.",
        );
      else
        assert(
          nodes.some(
            (node) =>
              node.id === point.activeNodeId && node.status === "running",
          ),
          "A graph version exists only after its harness starts.",
        );
      attempts.push({
        phase: point.phase,
        round: point.round,
        versionId: point.activeNodeId,
        taskId: request.taskId,
        benchmarkHash: request.benchmarkHash,
      });
      const failed =
        request.taskId === "strict-csv" &&
        (request.harness.systemPrompt === base.systemPrompt ||
          request.harness.systemPrompt.startsWith("Round 1 sibling 1:"));
      return {
        attemptId: request.attemptId,
        taskId: request.taskId,
        status: failed ? "benchmark_failed" : "passed",
        error: failed ? "Safe boundary failure category" : null,
        submissionHash: "c".repeat(64),
        artifacts: [],
        cleanupPending: false,
      };
    },
  };
  return {
    ...f,
    campaign,
    input,
    dependencies,
    attempts,
    proposals,
    probeCount: () => probeCount,
    async step() {
      f.advance(100);
      assert.equal(
        await workerTick("isolated-scheduler-worker", f.context, dependencies),
        true,
      );
      const current = getCampaign(input, f.context);
      assert(current);
      assert.equal(
        current.status,
        "running",
        `Unexpected checkpoint ${current.status}: ${current.waitReason}`,
      );
      return current;
    },
    close() {
      if (previousRate === undefined)
        delete process.env.LOOPBENCH_E2B_USD_PER_SECOND;
      else process.env.LOOPBENCH_E2B_USD_PER_SECOND = previousRate;
      if (previousDataRoot === undefined)
        delete process.env.LOOPBENCH_PRIVATE_DATA_ROOT;
      else process.env.LOOPBENCH_PRIVATE_DATA_ROOT = previousDataRoot;
      f.close();
    },
  };
}

test("invalid optimizer hypotheses receive metered-step feedback without inserting partial branches", async () => {
  const f = fullSchedulerFixture();
  try {
    let current = await f.step();
    while (current.checkpoint.phase !== "propose") current = await f.step();
    const original = f.dependencies.propose;
    let calls = 0;
    f.dependencies.propose = async (request) => {
      if (calls++ === 0)
        throw new HostedError(
          "PROPOSAL_INVALID",
          "Each sibling must contain a distinct harness change.",
          422,
        );
      assert.match(request.feedback ?? "", /distinct/);
      return original(request, f.context);
    };
    await f.step();
    assert.equal(
      getCampaign(f.input, f.context)?.checkpoint.proposalFailures,
      1,
    );
    assert.equal(listVersionNodes(f.input, f.context).length, 1);
    f.advance(1000);
    const next = await f.step();
    assert.equal(next.checkpoint.phase, "parent");
    assert.equal(next.checkpoint.proposalFailures, 0);
    assert.equal(calls, 2);
  } finally {
    f.close();
  }
});

test("three invalid proposal generations stop at an operator hold without inserting branches", async () => {
  const f = fullSchedulerFixture();
  try {
    let current = await f.step();
    while (current.checkpoint.phase !== "propose") current = await f.step();
    f.dependencies.propose = async () => {
      throw new HostedError(
        "PROPOSAL_INVALID",
        "Optimizer cited an unknown evaluation.",
        422,
      );
    };
    await f.step();
    f.advance(1100);
    await f.step();
    f.advance(1100);
    await workerTick("bounded-correction-test", f.context, f.dependencies);
    const held = getCampaign(f.input, f.context);
    assert.equal(held?.status, "waiting");
    assert.equal(held?.waitReason, "operator_hold");
    assert.equal(held?.checkpoint.proposalFailures, 3);
    assert.equal(listVersionNodes(f.input, f.context).length, 1);
    assert.equal(
      f.context.db
        .prepare(
          "SELECT COUNT(*) AS n FROM hosted_proposals WHERE campaign_id=?",
        )
        .get(f.campaign.id)?.n,
      0,
    );
  } finally {
    f.close();
  }
});

test("scheduler checkpoints missing real runtime without creating a graph node or provider request", async () => {
  const f = fixture();
  try {
    const campaign = f.campaign();
    assert.equal(await workerTick("test-worker", f.context), true);
    const current = getCampaign(
      { ownerScope: campaign.ownerScope, campaignId: campaign.id },
      f.context,
    );
    assert.equal(current?.status, "waiting");
    assert.equal(current?.waitReason, "runtime_unavailable");
    const projection = getCampaignProjection(
      { ownerScope: campaign.ownerScope, campaignId: campaign.id },
      f.context,
    );
    assert.deepEqual(projection.nodes, []);
    assert.equal(projection.budgets.inference.settledEstimateUsdMicros, "0");
    assert.equal(
      f.context.db.prepare("SELECT COUNT(*) AS n FROM provider_calls").get()?.n,
      0,
    );
  } finally {
    f.close();
  }
});

test("queued pause and stop are observed durably without rescheduling completed work", async () => {
  const f = fixture();
  try {
    const campaign = f.campaign();
    const pausing = controlCampaign(
      {
        ownerScope: campaign.ownerScope,
        campaignId: campaign.id,
        expectedRevision: campaign.revision,
        operationId: randomUUID(),
        action: "pause",
      },
      f.context,
    );
    assert.equal(pausing.status, "pausing");
    await workerTick("test-worker", f.context);
    const paused = getCampaign(
      { ownerScope: campaign.ownerScope, campaignId: campaign.id },
      f.context,
    );
    assert.equal(paused?.status, "paused");
    assert.equal(await workerTick("test-worker", f.context), false);
    assert(paused);
    controlCampaign(
      {
        ownerScope: campaign.ownerScope,
        campaignId: campaign.id,
        expectedRevision: paused.revision,
        operationId: randomUUID(),
        action: "stop",
      },
      f.context,
    );
    await workerTick("test-worker", f.context);
    assert.equal(
      getCampaign(
        { ownerScope: campaign.ownerScope, campaignId: campaign.id },
        f.context,
      )?.status,
      "stopped",
    );
    assert.equal(await workerTick("test-worker", f.context), false);
  } finally {
    f.close();
  }
});

test("hosted scheduler completes measured sibling rounds past 100 steps and branches again after curriculum advancement", async () => {
  const f = fullSchedulerFixture();
  try {
    let steps = 0;
    for (; steps < 250; steps++) {
      const current = await f.step();
      if (
        current.checkpoint.round === 4 &&
        current.checkpoint.phase === "parent"
      ) {
        steps++;
        break;
      }
    }
    assert(
      steps > 100 && steps < 250,
      `Expected continuing measured work beyond 100 steps, got ${steps}.`,
    );
    assert.equal(f.probeCount(), 1);
    assert.equal(f.proposals.length, 4);
    assert.equal(
      f.proposals[0]?.width,
      3,
      "The baseline failure admits three distinct same-parent siblings.",
    );
    for (const round of f.proposals)
      assert(round.width >= 2 && round.width <= 6);
    const nodes = listVersionNodes(f.input, f.context);
    const evaluated = nodes.filter((node) => node.comparison);
    assert.equal(
      evaluated.length,
      7,
      "Three first-round siblings and two in each later completed round.",
    );
    assert.equal(nodes.filter((node) => node.event === "challenge").length, 3);
    for (const proposalRound of f.proposals.slice(0, 3)) {
      const siblings = evaluated.filter(
        (node) => node.learning?.round === proposalRound.round,
      );
      assert.equal(siblings.length, proposalRound.width);
      assert(
        siblings.every((node) => node.parentId === proposalRound.parentId),
      );
      assert.equal(
        new Set(siblings.map((node) => node.harnessHash)).size,
        siblings.length,
      );
      for (const sibling of siblings) {
        assert.equal(sibling.tasks.length, 6);
        assert.equal(sibling.comparison?.parentTasks.length, 6);
        assert.equal(sibling.comparison?.method, "paired");
        assert.equal(
          sibling.comparison?.delta,
          (sibling.score ?? 0) - (sibling.comparison?.parentScore ?? 0),
        );
        const siblingAttempts = f.attempts.filter(
          (attempt) => attempt.versionId === sibling.id,
        );
        assert.equal(
          siblingAttempts.filter((attempt) => attempt.phase === "parent")
            .length,
          6,
        );
        assert.equal(
          siblingAttempts.filter((attempt) => attempt.phase === "candidate")
            .length,
          6,
        );
        assert.equal(
          new Set(siblingAttempts.map((attempt) => attempt.benchmarkHash)).size,
          1,
        );
      }
    }
    const firstRound = evaluated.filter((node) => node.learning?.round === 1);
    assert(
      firstRound.some(
        (node) =>
          node.status === "accepted" &&
          Math.abs((node.comparison?.delta ?? 0) - 1 / 6) < Number.EPSILON,
      ),
    );
    assert(
      firstRound.some(
        (node) => node.status === "rejected" && node.comparison?.delta === 0,
      ),
    );
    const latest = getCampaignProjection(f.input, f.context);
    const pending = latest.proposals.filter((proposal) => proposal.round === 4);
    assert.equal(pending.length, f.proposals[3]?.width);
    assert(pending.every((proposal) => proposal.nodeId === null));
    assert.equal(
      nodes.length,
      f.proposals[3]?.visibleNodes,
      "Saving hypotheses cannot populate the production graph with unexecuted versions.",
    );
    assert.equal(
      f.context.db.prepare("SELECT COUNT(*) AS n FROM provider_calls").get()?.n,
      0,
    );
    assert.equal(
      f.context.db
        .prepare("SELECT COUNT(*) AS n FROM hosted_sandbox_intents")
        .get()?.n,
      0,
    );
  } finally {
    f.close();
  }
});
