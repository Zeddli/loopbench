import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { getHostedContext, withHostedTransaction } from "../hosted/database";
import { controlCampaign } from "../hosted/evolution";
import { getCampaign } from "../hosted/store";
import { z } from "zod";
const target = z
  .object({ campaignId: z.uuid(), ownerScope: z.uuid() })
  .parse(
    JSON.parse(
      await readFile(
        process.argv.includes("--tokenfactory")
          ? ".loopbench/hosted/token-pilot.json"
          : ".loopbench/hosted/live-pilot.json",
        "utf8",
      ),
    ),
  );
const context = getHostedContext();
try {
  while (true) {
    const done = withHostedTransaction(context.db, () => {
      const campaign = getCampaign(target, context);
      if (!campaign) throw new Error("Pilot missing");
      if (["paused", "waiting", "stopped", "failed"].includes(campaign.status))
        return true;
      const active = Number(
        context.db
          .prepare(
            "SELECT COUNT(*) AS n FROM hosted_attempts WHERE campaign_id=? AND status='running'",
          )
          .get(target.campaignId)?.n ?? 0,
      );
      const queued = context.db
        .prepare("SELECT id FROM jobs WHERE campaign_id=? AND state='queued'")
        .get(target.campaignId);
      if (active || !queued) return false;
      controlCampaign(
        {
          ...target,
          action: "pause",
          expectedRevision: campaign.revision,
          operationId: randomUUID(),
        },
        context,
      );
      return true;
    });
    if (done) break;
    await delay(20);
  }
  process.stdout.write(
    "Pilot pause requested at a durable task boundary; no in-flight task interrupted.\n",
  );
} finally {
  context.db.close();
}
