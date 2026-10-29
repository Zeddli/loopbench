import { z } from "zod";
import { createE2BTransport, sdkController, type SandboxRecord } from "./e2b";
import { initializeEvolution } from "./evolution";
import {
  settleReservation,
  getBudgetReservation,
  markReservationUncertain,
} from "./budget";
import { revokeCampaignGatewayGrants } from "./gateway-tokens";
import { appendCampaignEvent } from "./events";
import { withHostedTransaction } from "./database";
import { now, type HostedContext } from "./schema";
import { reapTokenSandboxes } from "./tokenfactory-sandboxes";

const rowSchema = z.object({
  id: z.string(),
  owner_scope: z.string(),
  campaign_id: z.string(),
  attempt_id: z.string(),
  role: z.enum(["agent", "verifier"]),
  status: z.string(),
  sandbox_id: z.string().nullable(),
  template_id: z.string(),
  reservation_id: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});
export async function reaperTick(
  context: HostedContext,
): Promise<{ checked: number; terminated: number; uncertain: number }> {
  initializeEvolution(context);
  const summary = await reapTokenSandboxes(context);
  if (!context.config.e2bApiKey) return summary;
  const transport = createE2BTransport({
    apiKey: context.config.e2bApiKey,
    controller: sdkController({ apiKey: context.config.e2bApiKey }),
  });
  const candidates = context.db
    .prepare(
      "SELECT i.* FROM hosted_sandbox_intents i JOIN campaigns c ON c.id=i.campaign_id WHERE i.status!='terminated' AND (c.desired_control!='run' OR NOT EXISTS(SELECT 1 FROM jobs j WHERE j.campaign_id=i.campaign_id AND j.state IN ('leased','running') AND j.lease_expires_at>?)) ORDER BY i.created_at LIMIT 100",
    )
    .all(now(context))
    .map((row) => rowSchema.parse(row));
  for (const row of candidates) {
    summary.checked++;
    const expected = {
      application: "loopbench-hosted",
      intentId: row.id,
      ownerScope: row.owner_scope,
      campaignId: row.campaign_id,
      attemptId: row.attempt_id,
      role: row.role,
    };
    function owned(record: SandboxRecord) {
      return (
        record.templateId === row.template_id &&
        Object.entries(expected).every(
          ([key, value]) => record.metadata[key] === value,
        )
      );
    }
    try {
      let record = row.sandbox_id
        ? await transport.inspect(row.sandbox_id)
        : null;
      if (!row.sandbox_id && row.status !== "prepared") {
        const matches = (await transport.list(expected)).filter(owned);
        if (matches.length !== 1) {
          markReservationUncertain(
            {
              ownerScope: row.owner_scope,
              reservationId: row.reservation_id,
              reason:
                "Create outcome requires operator/provider reconciliation",
            },
            context,
          );
          summary.uncertain++;
          continue;
        }
        record = matches[0];
        context.db
          .prepare(
            "UPDATE hosted_sandbox_intents SET sandbox_id=?,updated_at=? WHERE id=? AND sandbox_id IS NULL",
          )
          .run(record.id, now(context), row.id);
      }
      if (record) {
        if (!owned(record)) {
          summary.uncertain++;
          continue;
        }
        await transport.terminate(record.id);
        if (await transport.inspect(record.id)) {
          summary.uncertain++;
          continue;
        }
      }
      withHostedTransaction(context.db, () => {
        const current = context.db
          .prepare(
            "SELECT status,sandbox_id FROM hosted_sandbox_intents WHERE id=?",
          )
          .get(row.id);
        if (!current || current.status === "terminated") return;
        if (
          row.status === "prepared" &&
          (current.status !== "prepared" || current.sandbox_id !== null)
        )
          throw new Error(
            "Sandbox intent advanced during cleanup; retain its full obligation",
          );
        const reservation = getBudgetReservation(
          { ownerScope: row.owner_scope, reservationId: row.reservation_id },
          context,
        );
        if (!reservation) throw new Error("Missing compute obligation");
        // Full TTL estimate is retained as spent after confirmed absence, including lost-create recovery.
        settleReservation(
          {
            ownerScope: row.owner_scope,
            reservationId: row.reservation_id,
            actualUsdMicros:
              row.status === "prepared" ? 0n : reservation.amountUsdMicros,
            evidence: `reaper-confirmed-absence:${record?.id ?? row.sandbox_id ?? row.id}`,
          },
          context,
        );
        context.db
          .prepare(
            "UPDATE hosted_sandbox_intents SET status='terminated',confirmed_at=?,updated_at=? WHERE id=?",
          )
          .run(now(context), now(context), row.id);
        context.db
          .prepare(
            "UPDATE hosted_attempts SET status='infrastructure_failed',updated_at=? WHERE id=? AND status='running'",
          )
          .run(now(context), row.attempt_id);
        revokeCampaignGatewayGrants(row.campaign_id, context);
        appendCampaignEvent(
          {
            ownerScope: row.owner_scope,
            campaignId: row.campaign_id,
            type: "sandbox.reaped",
            payload: {
              intentId: row.id,
              cleanup: "confirmed",
              computeEstimate: "full-reserved-lifetime",
            },
          },
          context,
        );
      });
      summary.terminated++;
    } catch {
      summary.uncertain++;
    }
  }
  // Crashed inference calls cannot be retried or credited as zero usage.
  const calls = context.db
    .prepare(
      "SELECT p.owner_scope,p.reservation_id,p.id FROM provider_calls p JOIN gateway_grants g ON g.id=p.grant_id WHERE p.status='sending' AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.id=g.job_id AND j.lease_fence=g.fence AND j.state IN ('leased','running') AND j.lease_expires_at>?)",
    )
    .all(now(context));
  for (const call of calls) {
    withHostedTransaction(context.db, () => {
      markReservationUncertain(
        {
          ownerScope: String(call.owner_scope),
          reservationId: String(call.reservation_id),
          reason: "Worker lease lost after request admission",
        },
        context,
      );
      context.db
        .prepare(
          "UPDATE provider_calls SET status='unknown',finished_at=? WHERE id=? AND status='sending'",
        )
        .run(now(context), String(call.id));
    });
  }
  return summary;
}
