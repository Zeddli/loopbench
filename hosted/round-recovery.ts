import {
  getBudgetReservation,
  releaseReservation,
  reserveBudget,
} from "./budget";
import { withHostedTransaction } from "./database";
import { HostedError, type HostedContext, type Lease } from "./schema";

/** Retries consume real capacity. Replace only the unallocated round hold, never its children. */
export function continueRoundEnvelope(
  input: {
    ownerScope: string;
    campaignId: string;
    envelopeId: string;
    round: number;
    minimumUsdMicros: bigint;
    remainingUsdMicros: bigint;
    lease?: Lease;
  },
  context: HostedContext,
) {
  return withHostedTransaction(context.db, () => {
    const old = getBudgetReservation(
      { ownerScope: input.ownerScope, reservationId: input.envelopeId },
      context,
    );
    if (
      !old ||
      old.campaignId !== input.campaignId ||
      old.operationKind !== "round_envelope" ||
      old.state !== "held"
    )
      throw new HostedError(
        "RECONCILIATION_REQUIRED",
        "The round reservation requires reconciliation.",
        503,
      );
    if (old.amountUsdMicros - old.allocatedUsdMicros >= input.minimumUsdMicros)
      return old;
    releaseReservation(
      {
        ownerScope: input.ownerScope,
        reservationId: old.id,
        reason:
          "Replace depleted round capacity; all child obligations remain charged or held.",
        lease: input.lease,
      },
      context,
    );
    return reserveBudget(
      {
        ownerScope: input.ownerScope,
        campaignId: input.campaignId,
        kind: "compute",
        amountUsdMicros: input.remainingUsdMicros,
        operationKind: "round_envelope",
        operationId: `round-${input.round}-after-${old.id}`,
        operationKey: `round:${input.round}:after:${old.id}`,
        lease: input.lease,
      },
      context,
    );
  });
}

export function executionFailureCode(
  actual: string | undefined,
  gateway: string | undefined,
): string {
  if (actual && !["EXECUTION_FAILED", "PI_EXECUTION_FAILED"].includes(actual))
    return actual;
  return gateway ?? actual ?? "PROVIDER_UNAVAILABLE";
}
