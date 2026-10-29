import { strict as assert } from "node:assert";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  buildHostedRuntime,
  elapsedBuildComputeEstimate,
  verifyOfficialNodeImage,
} from "../scripts/hosted-build-runtime";
import { fixture } from "./hosted-foundation-fixture";

test("build_elapsed_estimate_is_exact_with_margin_and_not_an_invoice_claim", () => {
  assert.equal(elapsedBuildComputeEstimate(0), 370n);
  assert.equal(elapsedBuildComputeEstimate(62057), 2701n);
  assert.equal(elapsedBuildComputeEstimate(3600000), 133570n);
  assert.throws(() => elapsedBuildComputeEstimate(-1));
  assert.throws(() => elapsedBuildComputeEstimate(Number.POSITIVE_INFINITY));
});
test("unsupported_build_resources_fail_before_any_intent_or_provider_call", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      buildHostedRuntime(
        {
          operationKey: randomUUID(),
          name: "local-only-fixture",
          nodeVersion: "24.15.0",
          cpuCount: 4,
          memoryMiB: 2048,
        },
        f.context,
      ),
      /pinned/,
    );
    assert.equal(
      f.context.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='hosted_template_builds'",
        )
        .get(),
      undefined,
    );
    assert.equal(
      f.context.db
        .prepare("SELECT COUNT(*) AS count FROM budget_reservations")
        .get()?.count,
      0,
    );
    await assert.rejects(verifyOfficialNodeImage("24"), /exact Node/);
  } finally {
    f.close();
  }
});
