import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { verifyComputePolicy } from "../hosted/operations";
import { runHostedPreflight } from "../scripts/hosted-preflight";
import { buildLessonDataset } from "../scripts/hosted-export-lessons";
import { readHostedStatus } from "../scripts/hosted-status";
import { initializeEvolution } from "../hosted/evolution";
import { saveArtifact } from "../hosted/artifacts";
import { harnessArtifactSchema } from "../hosted/harnesses";
import { nodeRecordSchema } from "../core/types";
import { fixture } from "./hosted-foundation-fixture";

test("compute_policy_requires_fresh_explicit_provider_evidence", async () => {
  const f = fixture();
  try {
    assert.throws(() => verifyComputePolicy(f.context, {}), /evidence/);
    const path = join(dirname(f.path), "limit-evidence.json");
    const evidence = {
      schemaVersion: 1,
      provider: "e2b",
      operationId: randomUUID(),
      projectReference: "local-policy-fixture",
      hardLimitUsdMicros: "100000000",
      scope: "account",
      resetPeriod: "account billing period; app ledger remains cumulative",
      enforcement:
        "Fixture documents an operator verification, without asserting provider behavior.",
      verifiedAt: new Date(f.context.now()).toISOString(),
    };
    await writeFile(path, JSON.stringify(evidence));
    const env = {
      LOOPBENCH_E2B_LIMIT_EVIDENCE: path,
      LOOPBENCH_E2B_USD_PER_SECOND: "0.000046",
    };
    assert.equal(
      verifyComputePolicy(f.context, env).operationId,
      evidence.operationId,
    );
    f.advance(8 * 86400000);
    assert.throws(() => verifyComputePolicy(f.context, env), /evidence/);
    await writeFile(
      path,
      JSON.stringify({ ...evidence, hardLimitUsdMicros: "200000000" }),
    );
    assert.throws(() => verifyComputePolicy(f.context, env), /evidence/);
  } finally {
    f.close();
  }
});
test("preflight_is_local_and_missing_configuration_fails_without_secret_echo", async () => {
  const report = await runHostedPreflight({
    LOOPBENCH_SESSION_SIGNING_KEY:
      "sensitive-fixture-value-that-must-not-be-printed",
  });
  assert.equal(report.ready, false);
  assert.equal(report.remoteVerification, "not_performed");
  assert.equal(
    JSON.stringify(report).includes("sensitive-fixture-value"),
    false,
  );
  assert.ok(
    report.checks.find((item) => item.name === "benchmark-identity")?.passed,
  );
});
test("preflight_verifies_real_file_hashes_without_claiming_remote_runtime", async () => {
  const f = fixture();
  try {
    const policyPath = join(dirname(f.path), "policy.json");
    const manifestPath = join(dirname(f.path), "runner.json");
    await writeFile(
      policyPath,
      JSON.stringify({
        schemaVersion: 1,
        provider: "e2b",
        operationId: randomUUID(),
        projectReference: "local-only",
        hardLimitUsdMicros: "100000000",
        scope: "account",
        resetPeriod: "operator documented period",
        enforcement: "Local fixture; this is not provider execution evidence.",
        verifiedAt: new Date().toISOString(),
      }),
    );
    const digest = async (name: string) =>
      createHash("sha256")
        .update(await readFile(join(process.cwd(), "sandbox/pi", name)))
        .digest("hex");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        piVersion: "1.4.0",
        nodeVersion: "v24.15.0",
        templateId: "local-fixture-agent-template",
        verifierTemplateId: "local-fixture-verifier-template",
        supervisorSha256: await digest("supervisor.mjs"),
        toolDefinitionsSha256: await digest("request-identity.mjs"),
        verifiedAt: new Date().toISOString(),
        cpuCount: 2,
        memoryMB: 4096,
      }),
    );
    const report = await runHostedPreflight({
      NODE_ENV: "production",
      LOOPBENCH_HOSTED_DB_PATH: f.path,
      LOOPBENCH_PUBLIC_ORIGIN: "https://local-fixture.example",
      LOOPBENCH_GATEWAY_ORIGIN: "https://local-fixture.example",
      LOOPBENCH_SESSION_SIGNING_KEY: f.context.config.sessionSigningKey,
      LOOPBENCH_CREDENTIAL_FINGERPRINT_KEY:
        f.context.config.credentialFingerprintKey,
      LOOPBENCH_VAULT_KEYRING_JSON: JSON.stringify({
        activeKeyId: "test",
        keys: f.context.config.vaultKeys,
      }),
      E2B_API_KEY: "local-fixture-not-a-controller-key",
      LOOPBENCH_E2B_TEMPLATE_ID: "local-fixture-agent-template",
      LOOPBENCH_RUNNER_MANIFEST: manifestPath,
      LOOPBENCH_E2B_LIMIT_EVIDENCE: policyPath,
      LOOPBENCH_E2B_USD_PER_SECOND: "0.000046",
    });
    assert.equal(report.ready, true, JSON.stringify(report.checks));
    assert.equal(report.remoteVerification, "not_performed");
    assert.equal(
      report.provenance.supervisorSha256,
      await digest("supervisor.mjs"),
    );
    assert.equal(
      JSON.stringify(report).includes(f.context.config.sessionSigningKey),
      false,
    );
  } finally {
    f.close();
  }
});
test("status_keeps_compute_and_inference_accounts_separate", () => {
  const f = fixture();
  try {
    f.campaign();
    const report = readHostedStatus(f.context);
    assert.equal(report.platformCompute?.hardLimitUsdMicros, "100000000");
    assert.ok(report.budgets.some((row) => row.kind === "campaign_inference"));
    assert.equal(report.activeOrUncertainSandboxSlots, 0);
  } finally {
    f.close();
  }
});
test("lesson_export_requires_matching_verifier_evidence_and_is_deterministic", () => {
  const f = fixture();
  try {
    const campaign = f.campaign();
    initializeEvolution(f.context);
    const ownerScope = campaign.ownerScope;
    const campaignId = campaign.id;
    const runtime = {
      piVersion: "1.4.0",
      nodeVersion: "v24.15.0",
      templateId: "local-agent",
      verifierTemplateId: "local-verifier",
      supervisorSha256: "a".repeat(64),
      toolDefinitionsSha256: "b".repeat(64),
    };
    const harness = harnessArtifactSchema.parse({
      schemaVersion: 1,
      systemPrompt: "Inspect boundaries",
      skills: [],
      tools: "read-write-edit",
      verificationPolicy: "public-smoke",
      compaction: {
        enabled: false,
        reserveTokens: 1024,
        keepRecentTokens: 1024,
      },
      runtime,
    });
    const task = {
      taskId: "local-task",
      passed: true,
      durationMs: 1,
      output: "",
      error: null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    };
    const parentId = randomUUID();
    const id = randomUUID();
    const config = {
      adapterId: "e2b-pi",
      domain: "coding",
      model: campaign.modelId,
      harness: "pi",
      benchmarkId: campaign.benchmarkId,
      benchmarkHash: "c".repeat(64),
      settings: {},
    };
    const parent = nodeRecordSchema.parse({
      id: parentId,
      treeId: campaign.id,
      parentId: null,
      hypothesis: "Baseline",
      createdAt: new Date(f.context.now()).toISOString(),
      completedAt: new Date(f.context.now()).toISOString(),
      harnessHash: "d".repeat(64),
      config,
      status: "baseline",
      totalTasks: 1,
      tasks: [task],
      score: 1,
      comparison: null,
      error: null,
    });
    const node = nodeRecordSchema.parse({
      ...parent,
      id,
      parentId,
      status: "rejected",
      hypothesis: "Check boundaries",
      learning: {
        learnedFrom: [parentId],
        diagnosis: "Review boundaries; Bearer fixture-secret-is-private",
        change: "Check input invariants",
        prediction: "Preserve correct behavior",
        proposer: "local-fixture",
        round: 1,
      },
      comparison: {
        method: "paired",
        parentScore: 1,
        candidateScore: 1,
        delta: 0,
        parentTasks: [task],
        reason: "tie",
      },
    });
    for (const value of [parent, node])
      f.context.db
        .prepare("INSERT INTO hosted_versions VALUES(?,?,?,?,?,?,?)")
        .run(
          value.id,
          ownerScope,
          campaignId,
          value.parentId,
          JSON.stringify(harness),
          JSON.stringify(value),
          f.context.now(),
        );
    assert.equal(
      buildLessonDataset({ ownerScope, campaignId }, f.context).rows.length,
      0,
    );
    for (const role of ["parent", "candidate"]) {
      const artifact = saveArtifact(
        {
          ownerScope,
          campaignId,
          kind: "verifier-result",
          contents: JSON.stringify({
            status: "passed",
            passed: true,
            error: null,
            graderSha256: "e".repeat(64),
            benchmarkHash: config.benchmarkHash,
          }),
          visibility: "owner",
        },
        f.context,
      );
      const attemptId = randomUUID();
      const result = {
        attemptId,
        taskId: task.taskId,
        status: "passed",
        error: null,
        submissionHash: "f".repeat(64),
        artifacts: [artifact.id],
        cleanupPending: false,
      };
      f.context.db
        .prepare(
          "INSERT INTO hosted_attempts VALUES(?,?,?,?,?,?,'passed',?,?,?,?,?)",
        )
        .run(
          attemptId,
          ownerScope,
          campaignId,
          id,
          role,
          task.taskId,
          JSON.stringify(result),
          randomUUID(),
          randomUUID(),
          f.context.now(),
          f.context.now(),
        );
    }
    const first = buildLessonDataset({ ownerScope, campaignId }, f.context);
    const second = buildLessonDataset({ ownerScope, campaignId }, f.context);
    assert.equal(first.rows.length, 1);
    assert.equal(first.sha256, second.sha256);
    assert.equal(first.jsonl.includes("fixture-secret-is-private"), false);
    assert.equal(first.jsonl.includes("expected"), false);
    assert.equal(first.jsonl.includes("submissionHash"), false);
    f.context.db
      .prepare(
        "DELETE FROM hosted_artifacts WHERE owner_scope=? AND campaign_id=?",
      )
      .run(ownerScope, campaignId);
    assert.equal(
      buildLessonDataset({ ownerScope, campaignId }, f.context).rows.length,
      0,
    );
    assert.throws(
      () =>
        buildLessonDataset(
          { ownerScope: f.owner().session.ownerScope, campaignId },
          f.context,
        ),
      /not found/,
    );
  } finally {
    f.close();
  }
});
