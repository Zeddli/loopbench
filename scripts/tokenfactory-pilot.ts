import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { getHostedContext } from "../hosted/database";
import { tokenOperatorIdentity } from "./tokenfactory-identity";
import { listEligibleModels } from "../hosted/models";
import {
  startHostedCampaign,
  controlCampaign,
  listVersionNodes,
} from "../hosted/evolution";
import { getCampaign } from "../hosted/store";
import { workerTick } from "../hosted/worker";
import {
  tokenHarnessId,
  loadTokenHarness,
} from "../hosted/tokenfactory-sandboxes";
import { publishCampaignSnapshot } from "../hosted/publication";
import { publicationProgress } from "../hosted/publication-schema";

const context = getHostedContext(),
  identity = await tokenOperatorIdentity(context),
  ownerScope = identity.session.ownerScope;
await loadTokenHarness();
const file = ".loopbench/hosted/token-pilot.json";
let campaign;
if (process.argv.includes("--resume")) {
  const saved = JSON.parse(await readFile(file, "utf8"));
  campaign = getCampaign({ ownerScope, campaignId: saved.campaignId }, context);
  if (!campaign) throw Error("Token pilot not owned");
  campaign = controlCampaign(
    {
      ownerScope,
      campaignId: campaign.id,
      action: "resume",
      expectedRevision: campaign.revision,
      operationId: randomUUID(),
    },
    context,
  );
} else {
  const catalog = await listEligibleModels(
      { ownerScope, credentialId: identity.credentialId },
      context,
    ),
    model = catalog.models.find((m) => m.id === catalog.selectedModelId);
  if (!model?.pricingSnapshotId) throw Error("No compatible model");
  campaign = await startHostedCampaign(
    {
      ownerScope,
      credentialId: identity.credentialId,
      modelId: model.id,
      benchmarkId: "coding-adversarial-v1",
      harnessId: tokenHarnessId,
      inferenceAllowanceUsdMicros: 500000n,
      acceptedPricingSnapshotId: model.pricingSnapshotId,
      idempotencyKey: randomUUID(),
    },
    context,
  );
  await writeFile(
    file,
    JSON.stringify({ campaignId: campaign.id, ownerScope }),
    { mode: 0o600 },
  );
}
const job = context.db
  .prepare("SELECT id FROM jobs WHERE campaign_id=? AND kind='campaign_run'")
  .get(campaign.id);
if (!job) throw Error("Missing pilot job");
const worker = `token-pilot-${randomUUID()}`;
let stopping = false,
  last = "";
process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});
process.stdout.write(
  JSON.stringify({
    event: "token.pilot.started",
    campaignId: campaign.id,
    model: campaign.modelId,
  }) + "\n",
);
try {
  while (true) {
    await workerTick(worker, context, { jobId: String(job.id) });
    const current = getCampaign(
      { ownerScope, campaignId: campaign.id },
      context,
    );
    if (!current) throw Error("Missing campaign");
    const progress = publicationProgress(
      current,
      Number(
        context.db
          .prepare(
            "SELECT COUNT(*) AS n FROM hosted_proposals WHERE campaign_id=? AND round=?",
          )
          .get(campaign.id, Number(current.checkpoint.round ?? 0))?.n ?? 0,
      ),
    );
    const nodes = listVersionNodes(
        { ownerScope, campaignId: campaign.id },
        context,
      ),
      fingerprint = JSON.stringify({
        nodes,
        progress,
      });
    if (fingerprint !== last && nodes.length) {
      const first = nodes[0];
      const snapshot = publishCampaignSnapshot(
        {
          reviewed: true,
          operationId: randomUUID(),
          campaignId: campaign.id,
          tree: {
            id: campaign.id,
            domain: "coding",
            model: campaign.modelId,
            harness: "Pi 1.4.0 · Token Factory Sandboxes",
            benchmarkId: first.config.benchmarkId,
            benchmarkHash: first.config.benchmarkHash,
            totalTasks: first.totalTasks,
            nodes,
            updatedAt: new Date().toISOString(),
            execution: {
              ...progress,
              observedAt: new Date().toISOString(),
            },
          },
        },
        context,
      );
      await writeFile(
        ".loopbench/hosted/token-published-live.json",
        JSON.stringify({
          snapshotId: snapshot.id,
          url: `/tree/${snapshot.id}`,
        }),
        { mode: 0o600 },
      );
      last = fingerprint;
      process.stdout.write(
        JSON.stringify({
          event: "token.pilot.checkpoint",
          status: current.status,
          waitReason: current.waitReason,
          phase: current.checkpoint.phase,
          round: current.checkpoint.round,
          nodes: nodes.length,
          scored: nodes.filter((n) => n.score !== null).length,
        }) + "\n",
      );
    }
    if (stopping) {
      controlCampaign(
        {
          ownerScope,
          campaignId: campaign.id,
          action: "pause",
          expectedRevision: current.revision,
          operationId: randomUUID(),
        },
        context,
      );
      stopping = false;
    }
    if (["waiting", "paused", "stopped", "failed"].includes(current.status))
      break;
    await delay(100);
  }
} finally {
  context.db.close();
}
