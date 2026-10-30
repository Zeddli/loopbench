import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fixture } from "./hosted-foundation-fixture";
import { initializeEvolution } from "../hosted/evolution";
import { claimJob } from "../hosted/jobs";
import { issueGatewayToken } from "../hosted/gateway-tokens";
import { saveArtifact } from "../hosted/artifacts";
import * as optimizerEvidence from "../hosted/optimizer-evidence";
const { optimizerExecutionEvidence } = optimizerEvidence;

test("submission review requires owned hash-matched model output and excludes other artifact kinds and credential-like bytes", () => {
  const f = fixture();
  try {
    initializeEvolution(f.context);
    const c = f.campaign(),
      nodeId = randomUUID();
    const code = "module.exports = values => values.slice().sort();";
    const add = (kind: string, contents: string, hashMatches = true) => {
      const a = saveArtifact(
        {
          ownerScope: c.ownerScope,
          campaignId: c.id,
          kind,
          contents,
          visibility: kind === "submission" ? "owner" : "internal_only",
        },
        f.context,
      );
      f.context.db
        .prepare(
          "INSERT INTO hosted_attempts VALUES(?,?,?,?,?,?,'benchmark_failed',?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          c.ownerScope,
          c.id,
          nodeId,
          "candidate",
          randomUUID(),
          JSON.stringify({
            artifacts: [a.id],
            submissionHash: hashMatches ? a.sha256 : "a".repeat(64),
          }),
          randomUUID(),
          randomUUID(),
          f.context.now(),
          f.context.now(),
        );
    };
    add("submission", code);
    add("submission", "CORRUPT-SUBMISSION", false);
    add("verifier-raw", "HIDDEN-ANSWER-CANARY");
    add(
      "submission",
      `module.exports = () => '${f.context.config.sessionSigningKey}';`,
    );
    const args = {
      ownerScope: c.ownerScope,
      campaignId: c.id,
      nodeIds: [nodeId],
      parentId: nodeId,
    };
    const rows = optimizerEvidence.optimizerSubmissionEvidence(args, f.context);
    assert.equal(rows.length, 1);
    assert.equal(JSON.stringify(rows).includes(code), true);
    assert.equal(JSON.stringify(rows).includes("CANARY"), false);
    assert.equal(
      JSON.stringify(rows).includes(f.context.config.sessionSigningKey),
      false,
    );
    assert.deepEqual(
      optimizerEvidence.optimizerSubmissionEvidence(
        { ...args, ownerScope: "foreign" },
        f.context,
      ),
      [],
    );
    assert.deepEqual(
      optimizerEvidence.optimizerSubmissionEvidence(
        { ...args, campaignId: randomUUID() },
        f.context,
      ),
      [],
    );
  } finally {
    f.close();
  }
});

test("optimizer receives bounded execution facts from owned attempts, never log content", () => {
  const f = fixture();
  try {
    initializeEvolution(f.context);
    const campaign = f.campaign();
    const lease = claimJob({ workerId: "evidence-test" }, f.context);
    assert.ok(lease);
    const attemptId = randomUUID(),
      nodeId = randomUUID(),
      privateText = "PRIVATE-CODE-AND-TOKEN-CANARY";
    const events: unknown[] = [
      { type: "agent_start" },
      {
        type: "message_end",
        message: { role: "assistant", stopReason: "toolUse" },
      },
      {
        type: "tool_execution_start",
        toolName: "read",
        toolCallId: "r",
        args: { path: "README.md", content: privateText },
      },
      {
        type: "tool_execution_end",
        toolName: "read",
        toolCallId: "r",
        isError: false,
        result: { content: privateText },
      },
      {
        type: "message_end",
        message: { role: "assistant", stopReason: "toolUse" },
      },
      {
        type: "tool_execution_start",
        toolName: "read",
        toolCallId: "d",
        args: { path: "src" },
      },
      {
        type: "tool_execution_end",
        toolName: "read",
        toolCallId: "d",
        isError: true,
        result: { content: privateText },
      },
      {
        type: "message_end",
        message: { role: "assistant", stopReason: "toolUse" },
      },
      {
        type: "tool_execution_start",
        toolName: "write",
        toolCallId: "w",
        args: { path: "src/solution.cjs", content: privateText },
      },
      {
        type: "tool_execution_end",
        toolName: "write",
        toolCallId: "w",
        isError: false,
        result: { content: privateText },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          content: privateText,
        },
      },
      { type: "agent_settled", aborted: false },
      { type: "supervisor_end", exitCode: 0 },
    ];
    events.splice(
      events.length - 2,
      0,
      {
        type: "tool_execution_start",
        toolName: "bash",
        toolCallId: "inventory",
        args: { command: `ls -la ${privateText}` },
      },
      {
        type: "tool_execution_end",
        toolName: "bash",
        toolCallId: "inventory",
        isError: false,
      },
      {
        type: "tool_execution_start",
        toolName: "bash",
        toolCallId: "smoke",
        args: { command: "node test/public-smoke.cjs" },
      },
      {
        type: "tool_execution_end",
        toolName: "bash",
        toolCallId: "smoke",
        isError: true,
      },
    );
    const log = saveArtifact(
      {
        ownerScope: campaign.ownerScope,
        campaignId: campaign.id,
        kind: "pi-events",
        visibility: "internal_only",
        contents: events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      },
      f.context,
    );
    const grant = issueGatewayToken(
      {
        ownerScope: campaign.ownerScope,
        campaignId: campaign.id,
        credentialId: campaign.credentialId,
        attemptId,
        role: "pi_attempt",
        modelId: campaign.modelId,
        maxCalls: 8,
        lease,
      },
      f.context,
    );
    f.context.db
      .prepare("UPDATE gateway_grants SET calls_used=8 WHERE id=?")
      .run(grant.id);
    f.context.db
      .prepare(
        "INSERT INTO hosted_attempts VALUES(?,?,?,?,?,?,'benchmark_failed',?,?,?,?,?)",
      )
      .run(
        attemptId,
        campaign.ownerScope,
        campaign.id,
        nodeId,
        "candidate",
        "strict-csv",
        JSON.stringify({
          artifacts: [log.id],
          terminationReason: "attempt_call_limit",
        }),
        randomUUID(),
        randomUUID(),
        f.context.now(),
        f.context.now(),
      );
    const input = {
      ownerScope: campaign.ownerScope,
      campaignId: campaign.id,
      nodeIds: [nodeId],
    };
    const evidence = optimizerExecutionEvidence(input, f.context);
    assert.equal(evidence.length, 1);
    assert.deepEqual(evidence[0], {
      nodeId,
      taskId: "strict-csv",
      role: "candidate",
      status: "benchmark_failed",
      terminationReason: "attempt_call_limit",
      modelCallsUsed: 8,
      modelCallLimit: 8,
      execution: {
        toolCalls: { read: 2, write: 1, edit: 0, bash: 2, other: 0 },
        failedTools: 2,
        failedToolsByName: { read: 1, write: 0, edit: 0, bash: 1, other: 0 },
        workspaceReads: {
          contract: 1,
          canonicalSubmission: 0,
          packageManifest: 0,
          directory: 1,
        },
        inventoryCommands: 1,
        dependencyInstallCommands: 0,
        canonicalWriteToolSuccesses: 1,
        firstCanonicalWriteAfterAssistantMessages: 3,
        firstSuccessfulCanonicalWriteAfterAssistantMessages: 3,
        publicSmokeCommands: 1,
        publicSmokeSuccesses: 0,
        publicSmokeFailures: 1,
        settled: true,
      },
    });
    assert.ok(!JSON.stringify(evidence).includes(privateText));
    assert.deepEqual(
      optimizerExecutionEvidence(
        { ...input, ownerScope: f.owner().session.ownerScope },
        f.context,
      ),
      [],
    );
    assert.deepEqual(
      optimizerExecutionEvidence(
        { ...input, nodeIds: [randomUUID()] },
        f.context,
      ),
      [],
    );
  } finally {
    f.close();
  }
});

test("quarantined parent pairs remain bounded owned optimizer evidence without raw outcome text", () => {
  const f = fixture();
  try {
    initializeEvolution(f.context);
    const campaign = f.campaign();
    for (let ordinal = 0; ordinal < 30; ordinal++) {
      f.context.db
        .prepare("INSERT INTO hosted_proposals VALUES(?,?,?,?,?,?,?,?,NULL)")
        .run(
          randomUUID(),
          campaign.ownerScope,
          campaign.id,
          "parent",
          1,
          ordinal,
          JSON.stringify({
            hypothesis: `Bounded procedure ${ordinal}`,
            systemPrompt: "PRIVATE-PROMPT-CANARY",
          }),
          "{}",
        );
      f.context.db
        .prepare("INSERT INTO hosted_proposal_outcomes VALUES(?,?,?,?,?)")
        .run(
          campaign.ownerScope,
          campaign.id,
          1,
          ordinal,
          JSON.stringify({
            outcome: "quarantined",
            failurePhase: "parent",
            resourceCategory: "heap_exhausted",
            unscored: true,
            error: "PRIVATE-ERROR-CANARY",
          }),
        );
    }
    assert.equal(
      typeof optimizerEvidence.optimizerQuarantinedOutcomes,
      "function",
    );
    const input = { ownerScope: campaign.ownerScope, campaignId: campaign.id };
    const outcomes = optimizerEvidence.optimizerQuarantinedOutcomes(
      input,
      f.context,
    );
    assert.equal(outcomes.length, 24);
    assert.equal(outcomes[0]?.ordinal, 29);
    assert.equal(outcomes[0]?.failurePhase, "parent");
    assert.equal(outcomes[0]?.unscored, true);
    assert.equal(JSON.stringify(outcomes).includes("PRIVATE-"), false);
    assert.deepEqual(
      optimizerEvidence.optimizerQuarantinedOutcomes(
        { ...input, ownerScope: f.owner().session.ownerScope },
        f.context,
      ),
      [],
    );
  } finally {
    f.close();
  }
});
