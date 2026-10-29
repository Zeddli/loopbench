import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { z } from "zod";
import { getHostedContext } from "../hosted/database";
import { resolveSession } from "../hosted/auth";
import {
  startHostedCampaign,
  listVersionNodes,
  controlCampaign,
} from "../hosted/evolution";
import { listEligibleModels } from "../hosted/models";
import { getCampaign } from "../hosted/store";
import { workerTick } from "../hosted/worker";
import { runHostedPreflight } from "./hosted-preflight";
import { getBudgetSummary } from "../hosted/budget";
import { publishCampaignSnapshot } from "../hosted/publication";
import { publicationProgress } from "../hosted/publication-schema";

const report = await runHostedPreflight();
if (!report.ready)
  throw new Error("Paid smoke requires successful hosted:preflight.");
const context = getHostedContext();
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
if (!session) throw new Error("Run hosted:verify first.");
const catalog = await listEligibleModels(
  { ownerScope: session.ownerScope, credentialId: identity.credentialId },
  context,
);
const model = catalog.models.find(
  (model) => model.id === catalog.selectedModelId,
);
if (!model?.pricingSnapshotId) throw new Error("No eligible Nemotron");
const alreadyObligated = BigInt(
  String(
    context.db
      .prepare(
        "SELECT COALESCE(SUM(settled_usd_micros+reserved_usd_micros),0) AS amount FROM budget_accounts WHERE credential_id=? AND kind='campaign_inference'",
      )
      .get(identity.credentialId)?.amount ?? 0,
  ),
);
const initialAllowance = process.argv.includes("--demo-envelope")
  ? 500000n - alreadyObligated
  : 200000n;
const previous = process.argv.includes("--resume")
  ? z
      .object({ campaignId: z.string(), ownerScope: z.string() })
      .parse(
        JSON.parse(
          await readFile(
            path.resolve(".loopbench/hosted/live-pilot.json"),
            "utf8",
          ),
        ),
      )
  : null;
let campaign;
if (previous) {
  if (previous.ownerScope !== session.ownerScope)
    throw new Error("The pilot belongs to another session");
  const current = getCampaign(
    { ownerScope: session.ownerScope, campaignId: previous.campaignId },
    context,
  );
  if (!current) throw new Error("Pilot is missing");
  campaign = controlCampaign(
    {
      ownerScope: session.ownerScope,
      campaignId: current.id,
      action: "resume",
      expectedRevision: current.revision,
      operationId: randomUUID(),
    },
    context,
  );
} else
  campaign = await startHostedCampaign(
    {
      ownerScope: session.ownerScope,
      credentialId: identity.credentialId,
      modelId: model.id,
      harnessId: "pi-1.4.0",
      benchmarkId: "coding-adversarial-v1",
      inferenceAllowanceUsdMicros: initialAllowance,
      acceptedPricingSnapshotId: model.pricingSnapshotId,
      idempotencyKey: randomUUID(),
      config: {
        name: "Live Pi / Nemotron measured evolution",
        purpose: "live-pilot",
        maxCallsPerTask: 8,
      },
    },
    context,
  );
await writeFile(
  path.resolve(".loopbench/hosted/live-pilot.json"),
  JSON.stringify({
    campaignId: campaign.id,
    ownerScope: session.ownerScope,
    startedAt: new Date().toISOString(),
  }),
  { mode: 0o600 },
);
const initialBudgets = getBudgetSummary(
  { ownerScope: session.ownerScope, campaignId: campaign.id },
  context,
);
process.stdout.write(
  JSON.stringify({
    event: "pilot.started",
    campaignId: campaign.id,
    model: model.id,
    inferenceAllowanceUsdMicros:
      initialBudgets.inference.hardLimitUsdMicros.toString(),
    computeAllowanceUsdMicros:
      initialBudgets.compute.hardLimitUsdMicros.toString(),
  }) + "\n",
);
const workerId = `pilot-${randomUUID()}`;
const campaignJob = context.db
  .prepare(
    "SELECT id FROM jobs WHERE campaign_id=? AND kind='campaign_run' ORDER BY created_at DESC LIMIT 1",
  )
  .get(campaign.id);
if (!campaignJob) throw new Error("Pilot job is missing");
let stopping = false;
let publishedDigest = "";
process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});
try {
  while (true) {
    await workerTick(workerId, context, { jobId: String(campaignJob.id) });
    const current = getCampaign(
      { ownerScope: session.ownerScope, campaignId: campaign.id },
      context,
    );
    if (!current) throw new Error("Missing pilot");
    const nodes = listVersionNodes(
      { ownerScope: session.ownerScope, campaignId: campaign.id },
      context,
    );
    process.stdout.write(
      JSON.stringify({
        event: "pilot.checkpoint",
        status: current.status,
        waitReason: current.waitReason,
        phase: current.checkpoint.phase,
        round: current.checkpoint.round,
        level: current.checkpoint.level,
        nodes: nodes.length,
        completedNodes: nodes.filter((node) => node.completedAt).length,
      }) + "\n",
    );
    const completedCount = nodes.filter((node) => node.completedAt).length;
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
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          nodes,
          status: current.status,
          waitReason: current.waitReason,
          progress,
        }),
      )
      .digest("hex");
    if (
      process.argv.includes("--publish-checkpoints") &&
      digest !== publishedDigest &&
      nodes.some((node) => node.score !== null)
    ) {
      const first = nodes.find((node) => node.score !== null);
      if (!first) throw new Error("Missing scored source");
      const snapshot = publishCampaignSnapshot(
        {
          reviewed: true,
          operationId: randomUUID(),
          campaignId: campaign.id,
          source: "hosted_published",
          tree: {
            id: campaign.id,
            domain: "coding",
            model: campaign.modelId,
            harness: "Pi 1.4.0 · 8-call task budget",
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
      publishedDigest = digest;
      await writeFile(
        path.resolve(".loopbench/hosted/published-live.json"),
        JSON.stringify({
          snapshotId: snapshot.id,
          url: `/tree/${snapshot.id}`,
          campaignId: campaign.id,
        }),
        { mode: 0o600 },
      );
      process.stdout.write(
        JSON.stringify({
          event: "pilot.published",
          url: `/tree/${snapshot.id}`,
          measuredNodes: completedCount,
        }) + "\n",
      );
    }
    const baselineOnly = process.argv.includes("--baseline-only");
    const reached = baselineOnly
      ? nodes.some((node) => node.status === "baseline" && node.completedAt)
      : Number(current.checkpoint.round) >= 1 &&
        Number(current.checkpoint.level) >= 1;
    if ((stopping || reached) && current.desiredControl === "run")
      controlCampaign(
        {
          ownerScope: session.ownerScope,
          campaignId: campaign.id,
          action: "pause",
          expectedRevision: current.revision,
          operationId: randomUUID(),
        },
        context,
      );
    if (
      ["waiting", "paused", "stopped", "failed", "completed"].includes(
        current.status,
      )
    )
      break;
    await delay(100);
  }
} finally {
  context.db.close();
}
