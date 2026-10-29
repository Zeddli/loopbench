import { z } from "zod";
import { createE2BTransport, sdkController } from "./e2b";
import { type SandboxContext, type SandboxIntent } from "./sandboxes";
import { assertLease } from "./jobs";
import {
  reserveBudget,
  settleReservation,
  markReservationUncertain,
  getBudgetReservation,
} from "./budget";
import { withHostedTransaction } from "./database";
import { decimalFraction } from "./pricing";
import { HostedError, now, type HostedContext, type Lease } from "./schema";

const intentSchema = z.object({
  id: z.string(),
  owner_scope: z.string(),
  campaign_id: z.string(),
  attempt_id: z.string(),
  role: z.enum(["agent", "verifier"]),
  status: z.enum(["prepared", "creating", "unknown", "running", "terminated"]),
  sandbox_id: z.string().nullable(),
  template_id: z.string(),
  reservation_id: z.string(),
  created_at: z.number(),
  creation_started_at: z.number().nullable(),
});
export function sandboxLifetimeBound(context: HostedContext): bigint {
  const rate = process.env.LOOPBENCH_E2B_USD_PER_SECOND;
  if (!rate)
    throw new HostedError(
      "RUNTIME_UNAVAILABLE",
      "Configure a verified E2B per-second rate for the pinned hardware before running.",
      503,
    );
  const parsed = decimalFraction(rate);
  if (parsed.numerator <= 0n)
    throw new HostedError(
      "RUNTIME_UNAVAILABLE",
      "A positive E2B compute price is required.",
      503,
    );
  // Include setup/teardown controller uncertainty; reconciliation can later replace the estimate.
  return (
    (parsed.numerator * 600n * 1000000n + parsed.denominator - 1n) /
    parsed.denominator
  );
}
export function makeSandboxContext(
  input: { lease: Lease; parentReservationId?: string },
  context: HostedContext,
): SandboxContext {
  const controller = sdkController({ apiKey: context.config.e2bApiKey });
  const transport = createE2BTransport({
    apiKey: context.config.e2bApiKey,
    controller: async (record) => {
      const maxCpu = Number(process.env.LOOPBENCH_E2B_CPU_COUNT),
        maxMemory = Number(process.env.LOOPBENCH_E2B_MEMORY_MIB);
      if (
        !Number.isSafeInteger(maxCpu) ||
        maxCpu < 1 ||
        !Number.isSafeInteger(maxMemory) ||
        maxMemory < 128 ||
        record.cpuCount === undefined ||
        record.memoryMiB === undefined ||
        record.cpuCount > maxCpu ||
        record.memoryMiB > maxMemory
      )
        throw new HostedError(
          "RUNTIME_UNAVAILABLE",
          "Sandbox hardware is outside the verified compute pricing profile.",
          503,
        );
      return controller(record);
    },
  });
  function getRow(id: string) {
    const value = context.db
      .prepare(
        "SELECT * FROM hosted_sandbox_intents WHERE id=? AND owner_scope=? AND campaign_id=?",
      )
      .get(id, input.lease.ownerScope, input.lease.campaignId);
    if (!value) throw new HostedError("NOT_FOUND", "Not found.", 404);
    return intentSchema.parse(value);
  }
  function map(row: z.infer<typeof intentSchema>): SandboxIntent {
    return {
      id: row.id,
      ownerScope: row.owner_scope,
      campaignId: row.campaign_id,
      attemptId: row.attempt_id,
      role: row.role,
      status: row.status,
      sandboxId: row.sandbox_id,
      templateId: row.template_id,
    };
  }
  return {
    transport,
    async assertFence() {
      assertLease(input.lease, context);
    },
    async prepare(value) {
      return withHostedTransaction(context.db, () => {
        assertLease(input.lease, context);
        const old = context.db
          .prepare("SELECT id FROM hosted_sandbox_intents WHERE id=?")
          .get(value.id);
        if (old) return map(getRow(value.id));
        if (
          value.ownerScope !== input.lease.ownerScope ||
          value.campaignId !== input.lease.campaignId
        )
          throw new HostedError("NOT_FOUND", "Not found.", 404);
        const reservation = reserveBudget(
          {
            ownerScope: value.ownerScope,
            campaignId: value.campaignId,
            kind: "compute",
            amountUsdMicros: sandboxLifetimeBound(context),
            operationId: value.id,
            operationKey: `sandbox:${value.id}`,
            operationKind: "sandbox",
            parentReservationId: input.parentReservationId,
            acquireSandboxSlot: true,
            lease: input.lease,
            expiresAt: now(context) + 660000,
          },
          context,
        );
        context.db
          .prepare(
            "INSERT INTO hosted_sandbox_intents(id,owner_scope,campaign_id,attempt_id,role,status,template_id,reservation_id,created_at,updated_at) VALUES(?,?,?,?,?,'prepared',?,?,?,?)",
          )
          .run(
            value.id,
            value.ownerScope,
            value.campaignId,
            value.attemptId,
            value.role,
            value.templateId,
            reservation.id,
            now(context),
            now(context),
          );
        return map(getRow(value.id));
      });
    },
    async get(id) {
      return map(getRow(id));
    },
    async claim(id) {
      return withHostedTransaction(context.db, () => {
        assertLease(input.lease, context);
        return (
          context.db
            .prepare(
              "UPDATE hosted_sandbox_intents SET status='creating',creation_started_at=?,updated_at=? WHERE id=? AND owner_scope=? AND campaign_id=? AND status='prepared' AND EXISTS(SELECT 1 FROM campaigns c WHERE c.id=hosted_sandbox_intents.campaign_id AND c.owner_scope=hosted_sandbox_intents.owner_scope AND c.desired_control='run' AND c.status IN ('queued','running'))",
            )
            .run(
              now(context),
              now(context),
              id,
              input.lease.ownerScope,
              input.lease.campaignId,
            ).changes === 1
        );
      });
    },
    async update(id, status, sandboxId) {
      assertLease(input.lease, context);
      const row = getRow(id);
      context.db
        .prepare(
          "UPDATE hosted_sandbox_intents SET status=?,sandbox_id=COALESCE(?,sandbox_id),updated_at=? WHERE id=? AND owner_scope=?",
        )
        .run(
          status,
          sandboxId ?? null,
          now(context),
          id,
          input.lease.ownerScope,
        );
      if (status === "unknown")
        markReservationUncertain(
          {
            ownerScope: row.owner_scope,
            reservationId: row.reservation_id,
            lease: input.lease,
          },
          context,
        );
    },
    async confirmTerminated(id) {
      assertLease(input.lease, context);
      const row = getRow(id);
      if (row.status === "terminated") return;
      // Charge the full reserved lifetime until external provider reconciliation. Never refund on a guessed timer.
      const reservation = getBudgetReservation(
        { ownerScope: row.owner_scope, reservationId: row.reservation_id },
        context,
      );
      if (!reservation) throw new Error("Missing sandbox reservation");
      settleReservation(
        {
          ownerScope: row.owner_scope,
          reservationId: row.reservation_id,
          actualUsdMicros: reservation.amountUsdMicros,
          evidence: `confirmed-provider-absence:${row.sandbox_id ?? row.id}`,
          lease: input.lease,
        },
        context,
      );
      context.db
        .prepare(
          "UPDATE hosted_sandbox_intents SET status='terminated',confirmed_at=?,updated_at=? WHERE id=? AND owner_scope=?",
        )
        .run(now(context), now(context), id, input.lease.ownerScope);
    },
  };
}
