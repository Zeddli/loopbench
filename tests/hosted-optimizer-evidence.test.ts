import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fixture } from "./hosted-foundation-fixture";
import { initializeEvolution } from "../hosted/evolution";
import { claimJob } from "../hosted/jobs";
import { issueGatewayToken } from "../hosted/gateway-tokens";
import { saveArtifact } from "../hosted/artifacts";
import { optimizerExecutionEvidence } from "../hosted/optimizer-evidence";

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
