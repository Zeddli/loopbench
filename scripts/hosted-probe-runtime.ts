import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getHostedContext } from "../hosted/database";
import { resolveSession } from "../hosted/auth";
import { initializeEvolution, startHostedCampaign } from "../hosted/evolution";
import { listEligibleModels } from "../hosted/models";
import { claimJob, heartbeatJob, updateJob } from "../hosted/jobs";
import { updateCampaign, getCampaign } from "../hosted/store";
import { verifyComputePolicy } from "../hosted/operations";
import { makeSandboxContext } from "../hosted/runtime-sandboxes";
import { inspectHostedTemplate } from "./hosted-template";
import { probeNemotron } from "../hosted/optimizer";

const context = getHostedContext();
initializeEvolution(context);
verifyComputePolicy(context);
const identity = z
  .object({ origin: z.string(), cookie: z.string(), credentialId: z.string() })
  .parse(
    JSON.parse(
      await readFile(
        path.resolve(".loopbench/hosted/verification-session.json"),
        "utf8",
      ),
    ),
  );
const session = resolveSession(
  new Request(identity.origin, { headers: { Cookie: identity.cookie } }),
  context,
);
if (!session)
  throw new Error(
    "Run hosted:verify to establish a private verification session first.",
  );
const catalog = await listEligibleModels(
  {
    ownerScope: session.ownerScope,
    credentialId: identity.credentialId,
    refresh: true,
  },
  context,
);
const model = catalog.models.find(
  (model) => model.id === catalog.selectedModelId,
);
if (!model?.pricingSnapshotId) throw new Error("No eligible priced Nemotron.");
const campaign = await startHostedCampaign(
  {
    ownerScope: session.ownerScope,
    credentialId: identity.credentialId,
    modelId: model.id,
    harnessId: "pi-1.4.0",
    benchmarkId: "coding-adversarial-v1",
    inferenceAllowanceUsdMicros: 200000n,
    acceptedPricingSnapshotId: model.pricingSnapshotId,
    idempotencyKey: randomUUID(),
    config: { purpose: "provider-runtime-verification" },
  },
  context,
);
const job = context.db
  .prepare("SELECT id FROM jobs WHERE campaign_id=? AND kind='campaign_run'")
  .get(campaign.id);
if (!job) throw new Error("Missing probe job");
const lease = claimJob(
  { workerId: `readiness-${randomUUID()}`, jobId: String(job.id) },
  context,
);
if (!lease) throw new Error("Could not claim readiness job");
let latest = updateCampaign(
  {
    ownerScope: session.ownerScope,
    campaignId: campaign.id,
    expectedRevision: campaign.revision,
    status: "running",
    lease,
  },
  context,
);
const timer = setInterval(() => heartbeatJob(lease, context), 15000);
try {
  if(!process.argv.includes("--model-only")){
  const result = await inspectHostedTemplate(
    {
      intentId: randomUUID(),
      ownerScope: session.ownerScope,
      campaignId: campaign.id,
      attemptId: randomUUID(),
      templateId: context.config.e2bTemplateId,
      gatewayOrigin: context.config.gatewayOrigin,
    },
    makeSandboxContext({ lease }, context),
  );
  await writeFile(
    path.resolve(".loopbench/hosted/runtime-probe.json"),
    JSON.stringify(
      {
        ...result,
        observedAt: new Date().toISOString(),
        campaignId: campaign.id,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  process.stdout.write(
    JSON.stringify({ runtime: result, campaignId: campaign.id }) + "\n",
  );
  }
  if (process.argv.includes("--inference")) {
    await probeNemotron({ campaign: latest, lease }, context);
    process.stdout.write(
      "Live Nemotron streaming tool-call and structured JSON probes passed; usage recorded in the campaign ledger.\n",
    );
  }
} finally {
  clearInterval(timer);
  latest =
    getCampaign(
      { ownerScope: session.ownerScope, campaignId: campaign.id },
      context,
    ) ?? latest;
  updateCampaign(
    {
      ownerScope: session.ownerScope,
      campaignId: campaign.id,
      expectedRevision: latest.revision,
      status: "stopping",
      desiredControl: "stop",
      lease,
    },
    context,
  );
  updateJob({ lease, state: "queued" }, context);
  context.db.close();
}
