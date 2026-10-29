import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { getHostedContext } from "../hosted/database";
import { createCampaign, getCampaign, updateCampaign } from "../hosted/store";
import { initializeEvolution, controlCampaign } from "../hosted/evolution";
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
import { listEligibleModels } from "../hosted/models";
import { tokenOperatorIdentity } from "./tokenfactory-identity";

const context = getHostedContext();
initializeEvolution(context);
const identity = await tokenOperatorIdentity(context, "probe"),
  session = identity.session;
const catalog = await listEligibleModels(
  { ownerScope: session.ownerScope, credentialId: identity.credentialId },
  context,
);
const model = catalog.models.find((m) => m.id === catalog.selectedModelId);
if (!model?.pricingSnapshotId) throw Error("No eligible model");
const campaign = createCampaign(
  {
    ownerScope: session.ownerScope,
    credentialId: identity.credentialId,
    modelId: model.id,
    benchmarkId: "coding-adversarial-v1",
    harnessId: tokenHarnessId,
    inferenceAllowanceUsdMicros: 200000n,
    acceptedPricingSnapshotId: model.pricingSnapshotId,
    idempotencyKey: randomUUID(),
  },
  context,
);
const job = enqueueJob(
  { ownerScope: campaign.ownerScope, campaignId: campaign.id },
  context,
);
const lease = claimJob(
  { workerId: "token-controller-probe", jobId: job.id },
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
let handle: SandboxHandle | undefined;
try {
  const harness = await loadTokenHarness();
  handle = await createAttemptSandbox(
    {
      id: randomUUID(),
      ownerScope: campaign.ownerScope,
      campaignId: campaign.id,
      attemptId: randomUUID(),
      role: "verifier",
      templateId: harness.runtime.templateId,
      gatewayOrigin: context.config.gatewayOrigin,
      ttlSeconds: process.argv.includes("--stress") ? 180 : 60,
    },
    sandboxes,
  );
  await handle.remote.writeFile(
    "/tmp/loopbench-probe.txt",
    "✓ real controller",
  );
  if (process.argv.includes("--stress")) {
    for (let index = 0; index < 30; index++) {
      const content = "probe-data-".repeat(25000);
      await handle.remote.writeFile(
        "/tmp/loopbench-transfer-stress.txt",
        content,
      );
      if (
        (await handle.remote.readFile("/tmp/loopbench-transfer-stress.txt")) !==
        content
      )
        throw Error("File transfer byte mismatch");
    }
    process.stdout.write(
      JSON.stringify({
        event: "token.transfer.verified",
        roundTrips: 30,
        bytesPerFile: 275000,
      }) + "\n",
    );
  }
  const check = await handle.remote.run(
    'node -e \'const fs=require("node:fs");process.stdout.write(JSON.stringify({nodeVersion:process.version,interfaces:fs.readdirSync("/sys/class/net"),content:fs.readFileSync("/tmp/loopbench-probe.txt","utf8")}));\'',
  );
  if (check.exitCode !== 0) throw Error("Controller command failed");
  const observed = JSON.parse(check.stdout);
  if (
    observed.content !== "✓ real controller" ||
    observed.interfaces.some((v: string) => v !== "lo")
  )
    throw Error("Controller isolation mismatch");
  await writeFile(
    ".loopbench/hosted/token-controller-probe.json",
    JSON.stringify({
      campaignId: campaign.id,
      operationId: handle.record.id,
      ...observed,
      observedAt: new Date().toISOString(),
      paidInferenceCalls: 0,
      computeCostUsd: null,
    }),
    { mode: 0o600 },
  );
  process.stdout.write(
    JSON.stringify({
      event: "token.controller.verified",
      ...observed,
      operationId: handle.record.id,
      computeCostUsd: null,
    }) + "\n",
  );
} finally {
  if (handle && !(await terminateOwnedSandbox(handle, sandboxes)))
    throw Error("Probe cleanup pending");
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
    if (stopped)
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
  updateJob({ lease, state: "completed" }, context);
  context.db.close();
}
