import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./hosted-foundation-fixture";
import {
  reserveBudget,
  settleReservation,
  getBudgetReservation,
  getBudgetSummary,
} from "../hosted/budget";
import {
  continueRoundEnvelope,
  executionFailureCode,
} from "../hosted/round-recovery";

test("round continuation retains spent child obligations and reserves only new capacity", () => {
  const f = fixture();
  try {
    const campaign = f.campaign(),
      scope = { ownerScope: campaign.ownerScope, campaignId: campaign.id };
    const old = reserveBudget(
      {
        ...scope,
        kind: "compute",
        amountUsdMicros: 100n,
        operationId: "old",
        operationKey: "old",
        operationKind: "round_envelope",
      },
      f.context,
    );
    const child = reserveBudget(
      {
        ...scope,
        kind: "compute",
        amountUsdMicros: 100n,
        operationId: "child",
        operationKey: "child",
        parentReservationId: old.id,
      },
      f.context,
    );
    settleReservation(
      {
        ownerScope: scope.ownerScope,
        reservationId: child.id,
        actualUsdMicros: 100n,
      },
      f.context,
    );
    const next = continueRoundEnvelope(
      {
        ...scope,
        envelopeId: old.id,
        round: 1,
        minimumUsdMicros: 40n,
        remainingUsdMicros: 120n,
      },
      f.context,
    );
    assert.notEqual(next.id, old.id);
    assert.equal(
      getBudgetReservation(
        { ownerScope: scope.ownerScope, reservationId: old.id },
        f.context,
      )?.state,
      "released",
    );
    assert.equal(
      getBudgetSummary(scope, f.context).compute.settledUsdMicros,
      100n,
    );
    assert.equal(
      getBudgetSummary(scope, f.context).compute.reservedUsdMicros,
      120n,
    );
    assert.equal(
      continueRoundEnvelope(
        {
          ...scope,
          envelopeId: next.id,
          round: 1,
          minimumUsdMicros: 40n,
          remainingUsdMicros: 120n,
        },
        f.context,
      ).id,
      next.id,
    );
  } finally {
    f.close();
  }
});

test("round continuation refusal rolls back and does not increase campaign allowance", () => {
  const f = fixture();
  try {
    const campaign = f.campaign(),
      scope = { ownerScope: campaign.ownerScope, campaignId: campaign.id };
    const old = reserveBudget(
      {
        ...scope,
        kind: "compute",
        amountUsdMicros: 10n,
        operationId: "old",
        operationKey: "old",
        operationKind: "round_envelope",
      },
      f.context,
    );
    const before = getBudgetSummary(scope, f.context).compute;
    assert.throws(() =>
      continueRoundEnvelope(
        {
          ...scope,
          envelopeId: old.id,
          round: 1,
          minimumUsdMicros: 20n,
          remainingUsdMicros: before.hardLimitUsdMicros + 1n,
        },
        f.context,
      ),
    );
    assert.equal(
      getBudgetReservation(
        { ownerScope: scope.ownerScope, reservationId: old.id },
        f.context,
      )?.state,
      "held",
    );
    assert.equal(
      getBudgetSummary(scope, f.context).compute.hardLimitUsdMicros,
      before.hardLimitUsdMicros,
    );
  } finally {
    f.close();
  }
});

test("actual compute failure is never masked by a prior controlled Pi call limit", () => {
  assert.equal(
    executionFailureCode("BUDGET_NOT_AVAILABLE", "ATTEMPT_CALL_LIMIT"),
    "BUDGET_NOT_AVAILABLE",
  );
  assert.equal(
    executionFailureCode("EXECUTION_FAILED", "PROVIDER_QUOTA"),
    "PROVIDER_QUOTA",
  );
  assert.equal(
    executionFailureCode("VERIFIER_FAILED", "ATTEMPT_CALL_LIMIT"),
    "VERIFIER_FAILED",
  );
});
