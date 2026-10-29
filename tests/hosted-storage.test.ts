import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  migrateHostedDatabase,
  openHostedDatabase,
  withHostedTransaction,
} from "../hosted/database";
import { getCampaign, updateCampaign } from "../hosted/store";
import { moneyJson, parseUsdMicros } from "../hosted/schema";
import { fixture } from "./hosted-foundation-fixture";

test("migration_reopens_without_data_loss", () => {
  const f = fixture();
  const campaign = f.campaign();
  const connection = openHostedDatabase({ path: f.path });
  try {
    migrateHostedDatabase(connection);
    assert.equal(
      connection.prepare("PRAGMA user_version").get()?.user_version,
      1,
    );
    assert.equal(
      getCampaign(
        { ownerScope: campaign.ownerScope, campaignId: campaign.id },
        { ...f.context, db: connection },
      )?.id,
      campaign.id,
    );
  } finally {
    connection.close();
    f.close();
  }
});
test("foreign_owner_lookup_is_absent", () => {
  const f = fixture();
  try {
    const campaign = f.campaign();
    const other = f.owner();
    assert.equal(
      getCampaign(
        { ownerScope: other.session.ownerScope, campaignId: campaign.id },
        f.context,
      ),
      null,
    );
    assert.throws(
      () =>
        f.context.db
          .prepare("UPDATE campaigns SET owner_scope=? WHERE id=?")
          .run(other.session.ownerScope, campaign.id),
      /FOREIGN KEY/,
    );
    const updated = updateCampaign(
      {
        ownerScope: campaign.ownerScope,
        campaignId: campaign.id,
        expectedRevision: campaign.revision,
        status: "running",
      },
      f.context,
    );
    assert.equal(updated.revision, 2);
    assert.throws(
      () =>
        updateCampaign(
          {
            ownerScope: campaign.ownerScope,
            campaignId: campaign.id,
            expectedRevision: 1,
            status: "waiting",
            waitReason: "operator_hold",
          },
          f.context,
        ),
      /changed/,
    );
  } finally {
    f.close();
  }
});
test("micro_usd_round_trip_is_exact", () => {
  assert.equal(parseUsdMicros("100000000"), 100000000n);
  assert.equal(
    moneyJson(parseUsdMicros("9007199254740993")),
    "9007199254740993",
  );
  assert.throws(() => parseUsdMicros("0.20"));
  assert.throws(() => parseUsdMicros("9223372036854775808"));
});
test("synchronous_transactions_rollback_and_reject_promises", () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        withHostedTransaction(f.context.db, () => {
          f.context.db
            .prepare(
              "INSERT INTO hosted_metadata(key,value) VALUES('rollback','bad')",
            )
            .run();
          throw new Error("rollback");
        }),
      /rollback/,
    );
    assert.equal(
      f.context.db
        .prepare("SELECT value FROM hosted_metadata WHERE key='rollback'")
        .get(),
      undefined,
    );
    assert.throws(
      () => withHostedTransaction(f.context.db, () => Promise.resolve(1)),
      /synchronous/,
    );
  } finally {
    f.close();
  }
});
