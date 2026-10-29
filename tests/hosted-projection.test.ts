import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fixture } from "./hosted-foundation-fixture";
import { getCampaignProjection } from "../hosted/evolution";
import { readCampaignEvents } from "../hosted/events";
import { projectionSchema } from "../components/hosted/contracts";
import { getArtifact, saveArtifact } from "../hosted/artifacts";

test("owned projection serializes money and reconnects without fake graph nodes", () => {
  const f = fixture();
  try {
    const campaign = f.campaign();
    const projection = getCampaignProjection(
      { ownerScope: campaign.ownerScope, campaignId: campaign.id },
      f.context,
    );
    assert.deepEqual(projection.nodes, []);
    assert.equal(projection.budgets.inference.limitUsdMicros, "200000");
    const serialized = JSON.stringify(projection);
    assert(!serialized.includes("ownerScope"));
    assert(!serialized.includes("credentialId"));
    assert.equal(
      projectionSchema.parse(JSON.parse(serialized)).campaign.id,
      campaign.id,
    );
    assert.deepEqual(
      readCampaignEvents(
        {
          ownerScope: campaign.ownerScope,
          campaignId: campaign.id,
          after: projection.eventCursor,
        },
        f.context,
      ).items,
      [],
    );
    assert.throws(
      () =>
        getCampaignProjection(
          { ownerScope: f.owner().session.ownerScope, campaignId: campaign.id },
          f.context,
        ),
      /Not found/,
    );
  } finally {
    f.close();
  }
});

test("internal and foreign artifact IDs are absent to browser owners", () => {
  const f = fixture();
  try {
    const campaign = f.campaign();
    const artifact = saveArtifact(
      {
        ownerScope: campaign.ownerScope,
        campaignId: campaign.id,
        kind: "pi-events",
        contents: "private events",
        visibility: "internal_only",
      },
      f.context,
    );
    assert.equal(
      getArtifact(
        { ownerScope: campaign.ownerScope, artifactId: artifact.id },
        f.context,
      ),
      null,
    );
    const submission = saveArtifact(
      {
        ownerScope: campaign.ownerScope,
        campaignId: campaign.id,
        kind: "submission",
        contents: "module.exports = function () {};",
        visibility: "owner",
      },
      f.context,
    );
    assert(
      getArtifact(
        { ownerScope: campaign.ownerScope, artifactId: submission.id },
        f.context,
      ),
    );
    assert.equal(
      getArtifact(
        { ownerScope: f.owner().session.ownerScope, artifactId: submission.id },
        f.context,
      ),
      null,
    );
    assert.equal(
      getCampaignProjection(
        { ownerScope: campaign.ownerScope, campaignId: campaign.id },
        f.context,
      ).artifacts.length,
      1,
    );
    assert.throws(() =>
      saveArtifact(
        {
          ownerScope: campaign.ownerScope,
          campaignId: campaign.id,
          kind: "pi-events",
          contents: "raw",
          visibility: "owner",
        },
        f.context,
      ),
    );
  } finally {
    f.close();
  }
});
