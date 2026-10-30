import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { getHostedContext } from "../hosted/database";
import { createCampaign, getCampaign, updateCampaign } from "../hosted/store";
import {
  initializeEvolution,
  controlCampaign,
  getVersionHarness,
} from "../hosted/evolution";
import { enqueueJob, claimJob, heartbeatJob, updateJob } from "../hosted/jobs";
import {
  makeTokenSandboxContext,
  loadTokenHarness,
  tokenHarnessId,
} from "../hosted/tokenfactory-sandboxes";
import {
  createAttemptSandbox,
  terminateOwnedSandbox,
  type SandboxHandle,
} from "../hosted/sandboxes";
import {
  verifySubmission,
  legacyVerifierOutcomePolicy,
  verifierOutcomePolicySchema,
} from "../hosted/verifier";
import { saveArtifact } from "../hosted/artifacts";
import { appendCampaignEvent } from "../hosted/events";
import { tokenOperatorIdentity } from "./tokenfactory-identity";

// Operator-only: reuse saved bytes in an independently owned verifier. No inference.
const argument = process.argv.indexOf("--attempt-id");
if (!process.argv.includes("--approved-verifier-inputs"))
  throw Error(
    "Explicit approval of the saved submission, unchanged grader, private verifier cases and health controls is required",
  );
const sourceAttemptId = z.uuid().parse(process.argv[argument + 1]);
if (argument < 0) throw Error("An explicit source attempt is required");
const context = getHostedContext();
initializeEvolution(context);
const source = context.db
  .prepare("SELECT * FROM hosted_attempts WHERE id=?")
  .get(sourceAttemptId);
if (!source) throw Error("Source attempt not found");
const sourceReceipt = z
  .object({ submissionHash: z.string(), artifacts: z.array(z.uuid()) })
  .parse(JSON.parse(String(source.result_json)));
const sourceArtifact = sourceReceipt.artifacts
  .map((id) =>
    context.db
      .prepare(
        "SELECT contents,sha256 FROM hosted_artifacts WHERE id=? AND owner_scope=? AND campaign_id=? AND kind='submission' AND state='ready'",
      )
      .get(id, source.owner_scope, source.campaign_id),
  )
  .find(Boolean);
if (!(sourceArtifact?.contents instanceof Uint8Array))
  throw Error("Saved source submission missing");
const bytes = Buffer.from(sourceArtifact.contents);
const sha256 = createHash("sha256").update(bytes).digest("hex");
if (sha256 !== sourceReceipt.submissionHash || sha256 !== sourceArtifact.sha256)
  throw Error("Source submission identity mismatch");
const sourceNode = context.db
  .prepare(
    "SELECT node_json FROM hosted_versions WHERE id=? AND owner_scope=? AND campaign_id=?",
  )
  .get(source.node_id, source.owner_scope, source.campaign_id);
if (!sourceNode) throw Error("Source evaluation missing");
const node = JSON.parse(String(sourceNode.node_json));
const sourceOutcomePolicy = verifierOutcomePolicySchema.parse(
  node.config.settings.verifierOutcomePolicy ?? legacyVerifierOutcomePolicy,
);
const policyArgument = process.argv.indexOf("--outcome-policy");
const outcomePolicy =
  policyArgument < 0
    ? sourceOutcomePolicy
    : verifierOutcomePolicySchema.parse(process.argv[policyArgument + 1]);
const harness = getVersionHarness(
  {
    ownerScope: String(source.owner_scope),
    campaignId: String(source.campaign_id),
    nodeId: String(source.node_id),
  },
  context,
);
const approved = await loadTokenHarness();
if (JSON.stringify(harness.runtime) !== JSON.stringify(approved.runtime))
  throw Error("Pinned runtime differs from approved probe runtime");
const identity = await tokenOperatorIdentity(context, "probe");
const campaign = createCampaign(
  {
    ownerScope: identity.session.ownerScope,
    credentialId: identity.credentialId,
    modelId: node.config.model,
    benchmarkId: node.config.benchmarkId,
    harnessId: tokenHarnessId,
    inferenceAllowanceUsdMicros: 1n,
    config: { operatorProfile: "verification-only", sourceAttemptId },
    idempotencyKey: randomUUID(),
  },
  context,
);
const job = enqueueJob(
  {
    ownerScope: campaign.ownerScope,
    campaignId: campaign.id,
    kind: "campaign_reconcile",
  },
  context,
);
const lease = claimJob(
  { workerId: "saved-submission-verifier-probe", jobId: job.id },
  context,
);
if (!lease) throw Error("Probe lease unavailable");
updateCampaign(
  {
    ownerScope: campaign.ownerScope,
    campaignId: campaign.id,
    expectedRevision: campaign.revision,
    status: "running",
    lease,
  },
  context,
);
const timer = setInterval(() => heartbeatJob(lease, context), 15000);
const sandboxes = makeTokenSandboxContext({ lease }, context);
const intentId = randomUUID();
let handle: SandboxHandle | undefined;
let cleanupConfirmed = false;
try {
  appendCampaignEvent(
    {
      ownerScope: campaign.ownerScope,
      campaignId: campaign.id,
      type: "verifier_probe.preparing",
      payload: { sourceAttemptId, submissionHash: sha256, intentId },
      lease,
    },
    context,
  );
  process.stdout.write(
    JSON.stringify({
      event: "verifier_probe.preparing",
      campaignId: campaign.id,
      sourceAttemptId,
      intentId,
      inferenceCalls: 0,
    }) + "\n",
  );
  handle = await createAttemptSandbox(
    {
      id: intentId,
      ownerScope: campaign.ownerScope,
      campaignId: campaign.id,
      attemptId: randomUUID(),
      role: "verifier",
      templateId: harness.runtime.verifierTemplateId,
      gatewayOrigin: context.config.gatewayOrigin,
      ttlSeconds: 600,
    },
    sandboxes,
  );
  const controlPath = "/opt/loopbench/diagnostic-control.json";
  await handle.remote.writeFile(
    "/opt/loopbench/evaluate.mjs",
    await readFile("benchmarks/evaluate.mjs", "utf8"),
  );
  await handle.remote.writeFile(
    controlPath,
    JSON.stringify({
      output: "module.exports = () => null;",
      cases: [{ args: [], expected: null }],
      nonMutating: false,
    }),
  );
  async function healthyControl() {
    if (!handle) throw Error("Missing owned verifier");
    const result = await handle.remote.run(
      `env -i PATH=/usr/local/bin:/usr/bin:/bin NODE_ENV=production node --permission --allow-fs-read=/opt/loopbench/evaluate.mjs --max-old-space-size=64 /opt/loopbench/evaluate.mjs < ${controlPath}`,
      { timeoutMs: 15000, user: "root" },
    );
    if (result.exitCode !== 0) return false;
    return z
      .object({ passed: z.literal(true), error: z.null() })
      .safeParse(JSON.parse(result.stdout)).success;
  }
  const healthyBefore = await healthyControl();
  if (!healthyBefore) throw Error("Verifier preflight failed");
  const verdict = await verifySubmission({
    remote: handle.remote,
    submission: {
      contents: bytes.toString("utf8"),
      sha256,
      bytes: bytes.length,
      path: "/home/user/task/src/solution.cjs",
    },
    taskId: String(source.task_id),
    benchmarkHash: node.config.benchmarkHash,
    benchmarkPath: node.config.benchmarkPath,
    nodeVersion: harness.runtime.nodeVersion,
    outcomePolicy,
  });
  const healthyAfter = await healthyControl();
  const controls = saveArtifact(
    {
      ownerScope: campaign.ownerScope,
      campaignId: campaign.id,
      kind: "verifier-probe-controls",
      visibility: "internal_only",
      contents: JSON.stringify({
        healthyBefore,
        healthyAfter,
        nodeVersion: harness.runtime.nodeVersion,
        maxOldSpaceSizeMb: 64,
        inferenceCalls: 0,
      }),
    },
    context,
  );
  const receipt = {
    sourceAttemptId,
    sourceCampaignId: source.campaign_id,
    campaignId: campaign.id,
    operationId: handle.record.id,
    submissionHash: sha256,
    sourceOutcomePolicy,
    outcomePolicy,
    status: verdict.status,
    controlsArtifactId: controls.id,
    healthyBefore,
    healthyAfter,
    ...(verdict.status === "infrastructure_failed"
      ? {
          diagnostic: verdict.diagnostic,
          resourceOutcomeConfirmed: Boolean(verdict.resourceExhaustion),
          resourceExhaustion: verdict.resourceExhaustion ?? null,
        }
      : {}),
    inferenceCalls: 0,
  };
  saveArtifact(
    {
      ownerScope: campaign.ownerScope,
      campaignId: campaign.id,
      kind: "verifier-probe-result",
      visibility: "internal_only",
      contents: JSON.stringify(receipt),
    },
    context,
  );
  process.stdout.write(JSON.stringify(receipt) + "\n");
} finally {
  try {
    if (handle)
      cleanupConfirmed = await terminateOwnedSandbox(handle, sandboxes);
  } finally {
    clearInterval(timer);
    const current = getCampaign(
      { ownerScope: campaign.ownerScope, campaignId: campaign.id },
      context,
    );
    if (current) {
      controlCampaign(
        {
          ownerScope: campaign.ownerScope,
          campaignId: campaign.id,
          action: "stop",
          expectedRevision: current.revision,
          operationId: randomUUID(),
        },
        context,
      );
      const stopped = getCampaign(
        { ownerScope: campaign.ownerScope, campaignId: campaign.id },
        context,
      );
      if (stopped && cleanupConfirmed)
        updateCampaign(
          {
            ownerScope: campaign.ownerScope,
            campaignId: campaign.id,
            expectedRevision: stopped.revision,
            status: "stopped",
            lease,
          },
          context,
        );
    }
    updateJob(
      { lease, state: cleanupConfirmed ? "completed" : "waiting" },
      context,
    );
    process.stdout.write(
      JSON.stringify({
        event: "verifier_probe.cleanup",
        campaignId: campaign.id,
        cleanupConfirmed,
        inferenceCalls: 0,
      }) + "\n",
    );
    context.db.close();
  }
}
