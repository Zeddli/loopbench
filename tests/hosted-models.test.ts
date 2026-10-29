import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./hosted-foundation-fixture";
import { parseModelCatalog, selectCheapestModel } from "../hosted/models";
import { tokenCostUsdMicros, getPricingSnapshot } from "../hosted/pricing";

test("live price refresh keeps the accepted rate identity and renews observation without mutating history", () => {
  const f = fixture();
  try {
    const campaign = f.campaign(),
      data = {
        data: [
          {
            id: "nvidia/Nemotron-3_5-Lightning",
            pricing: { prompt: "0.00000006", completion: "0.00000024" },
          },
        ],
      };
    const input = {
      ownerScope: campaign.ownerScope,
      credentialId: campaign.credentialId,
      refresh: false,
    };
    const first = parseModelCatalog(data, input, f.context).models[0];
    assert.ok(first.pricingSnapshotId);
    const old = getPricingSnapshot(
      {
        ownerScope: campaign.ownerScope,
        pricingSnapshotId: first.pricingSnapshotId,
      },
      f.context,
    );
    f.advance(600000);
    input.refresh = true;
    const second = parseModelCatalog(data, input, f.context).models[0];
    assert.ok(second.pricingSnapshotId);
    const fresh = getPricingSnapshot(
      {
        ownerScope: campaign.ownerScope,
        pricingSnapshotId: second.pricingSnapshotId,
      },
      f.context,
    );
    assert.equal(fresh.hash, old.hash);
    assert.notEqual(fresh.id, old.id);
    assert.equal(fresh.expiresAt - old.expiresAt, 600000);
    assert.deepEqual(
      getPricingSnapshot(
        { ownerScope: campaign.ownerScope, pricingSnapshotId: old.id },
        f.context,
      ),
      old,
    );
  } finally {
    f.close();
  }
});

test("per-token prices retain sub-microdollar precision and round upward", () => {
  assert.equal(tokenCostUsdMicros(1000000, "0.00000006"), 60000n);
  assert.equal(tokenCostUsdMicros(1, "0.00000006"), 1n);
  assert.equal(tokenCostUsdMicros(1000000, "0.00000024"), 240000n);
  assert.throws(() => tokenCostUsdMicros(1000, "NaN"));
});
test("cheapest fixed workload includes output, price ties prefer Lightning, unreviewed models stay blocked", () => {
  const f = fixture();
  try {
    const campaign = f.campaign();
    const catalog = parseModelCatalog(
      {
        data: [
          {
            id: "nvidia/Nemotron-3_5-Lightning",
            pricing: { prompt: "0.00000006", completion: "0.00000024" },
          },
          {
            id: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
            pricing: { prompt: "0.00000001", completion: "0.0000009" },
          },
          {
            id: "nvidia/unknown-Nemotron",
            pricing: { prompt: "0", completion: "0" },
          },
          { id: "other/free", pricing: { prompt: "0", completion: "0" } },
        ],
      },
      { ownerScope: campaign.ownerScope, credentialId: campaign.credentialId },
      f.context,
    );
    assert.equal(catalog.selectedModelId, "nvidia/Nemotron-3_5-Lightning");
    assert.equal(catalog.models[2].enabled, false);
    assert.equal(catalog.balanceStatus, "unknown");
    const nano = catalog.models[1],
      lightning = catalog.models[0];
    assert.equal(
      selectCheapestModel({
        catalog: {
          models: [{ ...nano, estimatedWorkloadUsdMicros: "1680" }, lightning],
        },
      })?.id,
      lightning.id,
    );
  } finally {
    f.close();
  }
});
