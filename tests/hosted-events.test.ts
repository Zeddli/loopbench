import { strict as assert } from "node:assert";
import { test } from "node:test";
import { appendCampaignEvent, readCampaignEvents } from "../hosted/events";
import { fixture } from "./hosted-foundation-fixture";

test("event_cursor_reconnect_has_no_gaps", () => {
  const f = fixture();
  try {
    const campaign = f.campaign();
    const input = { ownerScope: campaign.ownerScope, campaignId: campaign.id };
    for (let i = 0; i < 6; i++)
      appendCampaignEvent(
        { ...input, type: "attempt.progress", payload: { i } },
        f.context,
      );
    const first = readCampaignEvents({ ...input, limit: 3 }, f.context);
    const second = readCampaignEvents(
      { ...input, after: first.nextCursor, limit: 4 },
      f.context,
    );
    assert.deepEqual(
      [...first.items, ...second.items].map((item) => item.sequence),
      [1, 2, 3, 4, 5, 6, 7],
    );
    assert.equal(
      readCampaignEvents({ ...input, after: second.nextCursor }, f.context)
        .items.length,
      0,
    );
    f.context.db
      .prepare(
        "DELETE FROM campaign_events WHERE owner_scope=? AND campaign_id=? AND sequence<6",
      )
      .run(campaign.ownerScope, campaign.id);
    assert.equal(
      readCampaignEvents({ ...input, after: first.nextCursor }, f.context)
        .resetRequired,
      true,
    );
    f.context.db
      .prepare(
        "DELETE FROM campaign_events WHERE owner_scope=? AND campaign_id=?",
      )
      .run(campaign.ownerScope, campaign.id);
    assert.equal(
      readCampaignEvents({ ...input, after: first.nextCursor }, f.context)
        .resetRequired,
      true,
    );
    assert.equal(
      appendCampaignEvent({ ...input, type: "after.retention" }, f.context)
        .sequence,
      8,
    );
  } finally {
    f.close();
  }
});
test("foreign_cursor_does_not_reveal_private_events", () => {
  const f = fixture();
  try {
    const campaign = f.campaign();
    const first = readCampaignEvents(
      { ownerScope: campaign.ownerScope, campaignId: campaign.id },
      f.context,
    );
    const otherOwner = f.owner();
    const other = f.campaign(otherOwner.session.ownerScope);
    assert.throws(
      () =>
        readCampaignEvents(
          { ownerScope: other.ownerScope, campaignId: campaign.id },
          f.context,
        ),
      /not found/,
    );
    assert.throws(
      () =>
        readCampaignEvents(
          {
            ownerScope: other.ownerScope,
            campaignId: other.id,
            after: first.nextCursor,
          },
          f.context,
        ),
      /not found/,
    );
  } finally {
    f.close();
  }
});
