import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  approveInferenceAllowance,
  getBudgetSummary,
  markReservationUncertain,
  releaseReservation,
  reserveBudget,
  settleReservation,
} from "../hosted/budget";
import { openHostedDatabase } from "../hosted/database";
import { savePricingSnapshot } from "../hosted/pricing";
import { fixture } from "./hosted-foundation-fixture";

test("last_affordable_reservation_has_one_winner", async () => {
  const f = fixture();
  try {
    const campaign = f.campaign();
    const script = `import { openHostedDatabase } from './hosted/database.ts'; import { loadHostedConfig } from './hosted/config.ts'; import { reserveBudget } from './hosted/budget.ts'; const [path,ownerScope,campaignId,key]=process.argv.slice(1); const db=openHostedDatabase({path}); try { reserveBudget({ownerScope,campaignId,kind:'compute',amountUsdMicros:3000000n,operationId:key,operationKey:key},{db,config:{...loadHostedConfig({}),enabled:true}});process.stdout.write('won'); } catch(error) { process.stdout.write(error.code ?? 'error'); } finally { db.close(); }`;
    const run = (key: string) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            script,
            f.path,
            campaign.ownerScope,
            campaign.id,
            key,
          ],
          { cwd: process.cwd(), windowsHide: true },
        );
        let output = "";
        let errors = "";
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          errors += chunk.toString();
        });
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0 ? resolve(output) : reject(new Error(errors)),
        );
      });
    const results = await Promise.all([run(randomUUID()), run(randomUUID())]);
    assert.deepEqual(results.sort(), ["BUDGET_NOT_AVAILABLE", "won"]);
    assert.equal(
      getBudgetSummary(
        { ownerScope: campaign.ownerScope, campaignId: campaign.id },
        f.context,
      ).compute.reservedUsdMicros,
      3000000n,
    );
  } finally {
    f.close();
  }
});
test("uncertain_create_keeps_money_and_slot", () => {
  const f = fixture();
  try {
    const campaign = f.campaign();
    const base = {
      ownerScope: campaign.ownerScope,
      campaignId: campaign.id,
      kind: "compute",
      amountUsdMicros: 10000n,
      acquireSandboxSlot: true,
    } satisfies Omit<
      Parameters<typeof reserveBudget>[0],
      "operationId" | "operationKey"
    >;
    const first = reserveBudget(
      { ...base, operationId: "first", operationKey: "first" },
      f.context,
    );
    reserveBudget(
      { ...base, operationId: "second", operationKey: "second" },
      f.context,
    );
    markReservationUncertain(
      { ownerScope: campaign.ownerScope, reservationId: first.id },
      f.context,
    );
    f.advance(10000000);
    assert.throws(
      () =>
        reserveBudget(
          { ...base, operationId: "third", operationKey: "third" },
          f.context,
        ),
      /slots/,
    );
    assert.equal(
      getBudgetSummary(campaignInput(campaign), f.context).compute
        .reservedUsdMicros,
      20000n,
    );
    assert.throws(
      () =>
        releaseReservation(
          {
            ownerScope: campaign.ownerScope,
            reservationId: first.id,
            reason: "unknown",
          },
          f.context,
        ),
      /evidence/,
    );
    releaseReservation(
      {
        ownerScope: campaign.ownerScope,
        reservationId: first.id,
        reason: "confirmed absence",
        evidence: "provider inspection",
      },
      f.context,
    );
    reserveBudget(
      { ...base, operationId: "third", operationKey: "third" },
      f.context,
    );
  } finally {
    f.close();
  }
});
function campaignInput(campaign: { ownerScope: string; id: string }) {
  return { ownerScope: campaign.ownerScope, campaignId: campaign.id };
}
test("disabled_hosted_mode_cannot_admit_a_new_obligation", () => {
  const f = fixture();
  try {
    const campaign = f.campaign();
    assert.throws(
      () =>
        reserveBudget(
          {
            ...campaignInput(campaign),
            kind: "compute",
            amountUsdMicros: 1n,
            operationId: "disabled",
            operationKey: "disabled",
          },
          { ...f.context, config: { ...f.context.config, enabled: false } },
        ),
      /disabled/,
    );
    assert.equal(
      getBudgetSummary(campaignInput(campaign), f.context).compute
        .reservedUsdMicros,
      0n,
    );
  } finally {
    f.close();
  }
});
test("child_reservation_does_not_double_count_round_envelope", () => {
  const f = fixture();
  try {
    const campaign = f.campaign();
    const base = { ...campaignInput(campaign), kind: "compute" } satisfies Pick<
      Parameters<typeof reserveBudget>[0],
      "ownerScope" | "campaignId" | "kind"
    >;
    const parent = reserveBudget(
      {
        ...base,
        amountUsdMicros: 100000n,
        operationId: "round",
        operationKey: "round",
        operationKind: "round_envelope",
      },
      f.context,
    );
    const child = reserveBudget(
      {
        ...base,
        amountUsdMicros: 30000n,
        operationId: "child",
        operationKey: "child",
        parentReservationId: parent.id,
      },
      f.context,
    );
    assert.equal(
      getBudgetSummary(campaignInput(campaign), f.context).compute
        .reservedUsdMicros,
      100000n,
    );
    settleReservation(
      {
        ownerScope: campaign.ownerScope,
        reservationId: child.id,
        actualUsdMicros: 20000n,
      },
      f.context,
    );
    releaseReservation(
      {
        ownerScope: campaign.ownerScope,
        reservationId: parent.id,
        reason: "round finished",
      },
      f.context,
    );
    const summary = getBudgetSummary(campaignInput(campaign), f.context);
    assert.equal(summary.compute.reservedUsdMicros, 0n);
    assert.equal(summary.compute.settledUsdMicros, 20000n);
    settleReservation(
      {
        ownerScope: campaign.ownerScope,
        reservationId: child.id,
        actualUsdMicros: 20000n,
      },
      f.context,
    );
    assert.throws(
      () =>
        settleReservation(
          {
            ownerScope: campaign.ownerScope,
            reservationId: child.id,
            actualUsdMicros: 21000n,
          },
          f.context,
        ),
      /different/,
    );
  } finally {
    f.close();
  }
});
test("campaign_inference_does_not_spend_compute_credit", () => {
  const f = fixture();
  try {
    const campaign = f.campaign();
    const input = {
      ...campaignInput(campaign),
      kind: "inference",
      amountUsdMicros: 40000n,
      operationId: "request",
      operationKey: "request",
    } satisfies Parameters<typeof reserveBudget>[0];
    const reservation = reserveBudget(input, f.context);
    settleReservation(
      {
        ownerScope: campaign.ownerScope,
        reservationId: reservation.id,
        actualUsdMicros: 50000n,
      },
      f.context,
    );
    const summary = getBudgetSummary(campaignInput(campaign), f.context);
    assert.equal(summary.inference.settledUsdMicros, 50000n);
    assert.equal(summary.compute.settledUsdMicros, 0n);
    assert.equal(summary.inference.status, "blocked");
    assert.throws(
      () =>
        reserveBudget(
          { ...input, operationId: "next", operationKey: "next" },
          f.context,
        ),
      /allowance/,
    );
  } finally {
    f.close();
  }
});
test("restart_does_not_reset_global_cap", () => {
  const f = fixture();
  try {
    const campaign = f.campaign();
    reserveBudget(
      {
        ...campaignInput(campaign),
        kind: "compute",
        amountUsdMicros: 1000000n,
        operationId: "persist",
        operationKey: "persist",
      },
      f.context,
    );
    const db = openHostedDatabase({ path: f.path });
    try {
      const row = db
        .prepare(
          "SELECT hard_limit_usd_micros,admission_limit_usd_micros,reserved_usd_micros FROM budget_accounts WHERE kind='platform_compute'",
        )
        .get();
      assert.equal(row?.hard_limit_usd_micros, 100000000);
      assert.equal(row?.admission_limit_usd_micros, 90000000);
      assert.equal(row?.reserved_usd_micros, 1000000);
    } finally {
      db.close();
    }
  } finally {
    f.close();
  }
});
test("allowance_consent_is_exact_owned_fresh_and_does_not_resume", () => {
  const f = fixture();
  try {
    const campaign = f.campaign();
    const pricing = savePricingSnapshot(
      {
        ownerScope: campaign.ownerScope,
        credentialId: campaign.credentialId,
        modelId: campaign.modelId,
        promptUsdPerToken: "0.00000006",
        completionUsdPerToken: "0.00000024",
      },
      f.context,
    );
    assert.throws(
      () =>
        approveInferenceAllowance(
          {
            ...campaignInput(campaign),
            newLimitUsdMicros: 200000n,
            expectedRevision: campaign.revision,
            acceptedPricingSnapshotId: randomUUID(),
          },
          f.context,
        ),
      /pricing/,
    );
    const result = approveInferenceAllowance(
      {
        ...campaignInput(campaign),
        newLimitUsdMicros: 200000n,
        expectedRevision: campaign.revision,
        acceptedPricingSnapshotId: pricing.id,
      },
      f.context,
    );
    assert.equal(result.campaign.desiredControl, "run");
    assert.equal(result.campaign.status, "queued");
    assert.equal(result.campaign.pricingConsentRevision, 2);
    assert.throws(
      () =>
        approveInferenceAllowance(
          {
            ...campaignInput(campaign),
            newLimitUsdMicros: 500001n,
            expectedRevision: result.campaign.revision,
            acceptedPricingSnapshotId: pricing.id,
          },
          f.context,
        ),
      /allowance/,
    );
  } finally {
    f.close();
  }
});
