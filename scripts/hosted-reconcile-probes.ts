import { randomUUID } from "node:crypto";
import { getHostedContext, withHostedTransaction } from "../hosted/database";
import { reconcileBudgetReservation } from "../hosted/budget";
// Operator-only reconciliation of completed readiness responses, never a refund.
// The reservation's full prompt/output bound is deliberately retained as an estimate.
if (!process.argv.includes("--retain-full-bound"))
  throw new Error(
    "Specify --retain-full-bound to conservatively settle completed readiness responses.",
  );
const context = getHostedContext();
try {
  const rows = context.db
    .prepare(
      "SELECT p.id,p.owner_scope,p.reservation_id,r.amount_usd_micros FROM provider_calls p JOIN gateway_grants g ON g.id=p.grant_id JOIN budget_reservations r ON r.id=p.reservation_id WHERE g.role='probe' AND p.status='unknown' AND p.finished_at IS NOT NULL AND r.state='uncertain'",
    )
    .all();
  for (const row of rows)
    withHostedTransaction(context.db, () => {
      reconcileBudgetReservation(
        {
          ownerScope: String(row.owner_scope),
          reservationId: String(row.reservation_id),
          actualUsdMicros: BigInt(String(row.amount_usd_micros)),
          operationId: randomUUID(),
          operatorReason:
            "Completed readiness response had unrecognized optional usage details. Retain its full pre-request prompt/output cost bound as a conservative estimate; not an invoice amount and no refund.",
          evidence: `completed-readiness-response:${String(row.id)}; full max_tokens/request-byte bound charged; nullable cache-detail parser corrected; observed tool/JSON responses`,
        },
        context,
      );
      context.db
        .prepare(
          "UPDATE provider_calls SET status='estimated_at_reserved_bound' WHERE id=?",
        )
        .run(row.id);
    });
  process.stdout.write(
    JSON.stringify({ conservativeProbeSettlements: rows.length, refunds: 0 }) +
      "\n",
  );
} finally {
  context.db.close();
}
