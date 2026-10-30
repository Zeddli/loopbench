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
import { loadBenchmark } from "../core/benchmarks";
import { z } from "zod";

const validation = process.argv.includes("--validation");
const quality = process.argv.includes("--quality");
const modelIndex = process.argv.indexOf("--model");
const requestedModelId =
  modelIndex < 0
    ? undefined
    : z
        .string()
        .min(1)
        .parse(process.argv[modelIndex + 1]);
if (quality && validation) throw Error("Choose one operator profile");
const callsIndex = process.argv.indexOf("--max-calls");
const maxCallsPerTask =
  callsIndex < 0
    ? quality
      ? 16
      : 8
    : z.coerce
        .number()
        .int()
        .min(2)
        .max(24)
        .parse(process.argv[callsIndex + 1]);
const siblingIndex = process.argv.indexOf("--max-siblings");
const maxSiblingBranches =
  siblingIndex === -1
    ? 6
    : z.coerce
        .number()
        .int()
        .min(2)
        .max(6)
        .parse(process.argv[siblingIndex + 1]);
const roundsIndex = process.argv.indexOf("--rounds");
const maxRounds =
  roundsIndex === -1
    ? null
    : z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .parse(process.argv[roundsIndex + 1]);
const context = getHostedContext(),
  identity = await tokenOperatorIdentity(
    context,
    quality ? "quality" : validation ? "validation" : "pilot",
  ),
  ownerScope = identity.session.ownerScope;
await loadTokenHarness();
const file = quality
  ? ".loopbench/hosted/token-quality-pilot.json"
  : validation
    ? ".loopbench/hosted/token-validation-pilot.json"
    : ".loopbench/hosted/token-pilot.json";
const publishedFile = quality
  ? ".loopbench/hosted/token-quality-published-live.json"
  : validation
    ? ".loopbench/hosted/token-validation-published-live.json"
    : ".loopbench/hosted/token-published-live.json";
let campaign;
if (process.argv.includes("--resume")) {
  const saved = JSON.parse(await readFile(file, "utf8"));
  campaign = getCampaign({ ownerScope, campaignId: saved.campaignId }, context);
  if (!campaign) throw Error("Token pilot not owned");
  if (requestedModelId && requestedModelId !== campaign.modelId)
    throw Error("A resumed campaign must keep its pinned model");
  if (
    callsIndex >= 0 &&
    Number(campaign.config.maxCallsPerTask ?? 8) !== maxCallsPerTask
  )
    throw Error("A resumed campaign must keep its pinned model-call bound");
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
    model = catalog.models.find(
      (m) => m.id === (requestedModelId ?? catalog.selectedModelId),
    );
  if (!model?.pricingSnapshotId) throw Error("No compatible model");
  campaign = await startHostedCampaign(
    {
      ownerScope,
      credentialId: identity.credentialId,
      modelId: model.id,
      benchmarkId: "coding-adversarial-v1",
      harnessId: tokenHarnessId,
      inferenceAllowanceUsdMicros: validation || quality ? 400000n : 500000n,
      acceptedPricingSnapshotId: model.pricingSnapshotId,
      config: { maxSiblingBranches, maxCallsPerTask },
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
    maxSiblingBranches: campaign.config.maxSiblingBranches ?? 6,
    maxCallsPerTask: campaign.config.maxCallsPerTask ?? 8,
  }) + "\n",
);
try {
  while (true) {
    await workerTick(worker, context, { jobId: String(job.id) });
    let current = getCampaign({ ownerScope, campaignId: campaign.id }, context);
    if (!current) throw Error("Missing campaign");
    if (
      maxRounds !== null &&
      current.status === "running" &&
      current.checkpoint.phase === "propose" &&
      Number(current.checkpoint.round ?? 0) >= maxRounds
    ) {
      current = controlCampaign(
        {
          ownerScope,
          campaignId: campaign.id,
          action: "pause",
          expectedRevision: current.revision,
          operationId: randomUUID(),
        },
        context,
      );
      await workerTick(worker, context, { jobId: String(job.id) });
      current = getCampaign({ ownerScope, campaignId: campaign.id }, context);
      if (!current) throw Error("Missing campaign after checkpoint pause");
    }
    const benchmark = await loadBenchmark(
      typeof current.checkpoint.benchmarkPath === "string"
        ? current.checkpoint.benchmarkPath
        : current.benchmarkId,
    );
    const progress = publicationProgress(
      current,
      Number(
        context.db
          .prepare(
            "SELECT COUNT(*) AS n FROM hosted_proposals WHERE campaign_id=? AND round=?",
          )
          .get(campaign.id, Number(current.checkpoint.round ?? 0))?.n ?? 0,
      ),
      benchmark.tasks.length,
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
            harness: `Pi 1.4.0 · Token Factory Sandboxes · ${campaign.config.maxCallsPerTask ?? 8} calls/task`,
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
        publishedFile,
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
