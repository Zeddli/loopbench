import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getHostedContext } from "../hosted/database";
import { type HostedContext } from "../hosted/schema";

export function readHostedStatus(context: HostedContext) {
  const tokenTable = context.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='token_sandbox_intents'",
    )
    .get();
  const tokenActive = tokenTable
    ? Number(
        context.db
          .prepare(
            "SELECT COUNT(*) AS n FROM token_sandbox_intents WHERE status!='terminated'",
          )
          .get()?.n ?? 0,
      )
    : 0;
  const accounts = context.db.prepare(
    "SELECT kind,status,COUNT(*) AS accounts,SUM(settled_usd_micros) AS settled,SUM(reserved_usd_micros) AS reserved,SUM(unknown_reservation_count) AS unknown FROM budget_accounts GROUP BY kind,status",
  );
  accounts.setReadBigInts(true);
  const summary = accounts.all().map((row) => ({
    kind: row.kind,
    status: row.status,
    accounts: Number(row.accounts),
    settledUsdMicros: String(row.settled),
    reservedUsdMicros: String(row.reserved),
    unknownReservationCount: Number(row.unknown),
  }));
  const platform = context.db
    .prepare(
      "SELECT hard_limit_usd_micros,admission_limit_usd_micros FROM budget_accounts WHERE kind='platform_compute'",
    )
    .get();
  return {
    schemaVersion: 1,
    tokenFactoryCompute: tokenTable
      ? {
          operations: Number(
            context.db
              .prepare("SELECT COUNT(*) AS n FROM token_sandbox_intents")
              .get()?.n ?? 0,
          ),
          activeOrUncertainOperations: tokenActive,
          costUsd: null,
          costStatus: "not_reported",
        }
      : null,
    observedAt: new Date().toISOString(),
    platformCompute: platform
      ? {
          hardLimitUsdMicros: String(platform.hard_limit_usd_micros),
          admissionLimitUsdMicros: String(platform.admission_limit_usd_micros),
        }
      : null,
    budgets: summary,
    campaigns: context.db
      .prepare("SELECT status,COUNT(*) AS count FROM campaigns GROUP BY status")
      .all(),
    jobs: context.db
      .prepare("SELECT state,COUNT(*) AS count FROM jobs GROUP BY state")
      .all(),
    activeOrUncertainSandboxSlots:
      tokenActive +
      Number(
        context.db
          .prepare(
            "SELECT COUNT(*) AS count FROM budget_reservations WHERE sandbox_slot=1 AND state IN ('held','uncertain')",
          )
          .get()?.count ?? 0,
      ),
    caution:
      "The dollar compute ledger covers E2B; linked campaign/platform totals must not be added together. Token Factory compute is shown separately with unconfirmed monetary units. Unknown obligations remain retained.",
  };
}
function main() {
  const context = getHostedContext();
  try {
    process.stdout.write(
      `${JSON.stringify(readHostedStatus(context), null, 2)}\n`,
    );
  } finally {
    context.db.close();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch {
    process.stderr.write(
      "Hosted status is unavailable. Check private configuration and database access.\n",
    );
    process.exitCode = 1;
  }
}
