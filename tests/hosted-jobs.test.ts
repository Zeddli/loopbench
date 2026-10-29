import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  assertLease,
  claimJob,
  enqueueJob,
  heartbeatJob,
  updateJob,
} from "../hosted/jobs";
import { fixture } from "./hosted-foundation-fixture";

test("duplicate_start_returns_same_job", () => {
  const f = fixture();
  try {
    const campaign = f.campaign();
    const input = { ownerScope: campaign.ownerScope, campaignId: campaign.id };
    assert.equal(
      enqueueJob(input, f.context).id,
      enqueueJob(input, f.context).id,
    );
    assert.equal(
      f.context.db.prepare("SELECT COUNT(*) AS count FROM jobs").get()?.count,
      1,
    );
  } finally {
    f.close();
  }
});
test("targeted_claim_never_grabs_a_different_campaign_job", () => {
  const f = fixture();
  try {
    const first = f.campaign();
    const firstJob = enqueueJob(
      { ownerScope: first.ownerScope, campaignId: first.id },
      f.context,
    );
    const second = f.campaign(f.owner().session.ownerScope);
    const secondJob = enqueueJob(
      { ownerScope: second.ownerScope, campaignId: second.id },
      f.context,
    );
    const lease = claimJob(
      { workerId: "targeted-probe", jobId: secondJob.id },
      f.context,
    );
    assert.equal(lease?.jobId, secondJob.id);
    assert.equal(lease?.campaignId, second.id);
    assert.equal(
      claimJob({ workerId: "second-probe", jobId: secondJob.id }, f.context),
      null,
    );
    const remaining = claimJob({ workerId: "normal-worker" }, f.context);
    assert.equal(remaining?.jobId, firstJob.id);
    assert.throws(() =>
      claimJob({ workerId: "invalid", jobId: "not-a-job-id" }, f.context),
    );
  } finally {
    f.close();
  }
});
test("expired_lease_is_reclaimed_with_new_fence_and_old_worker_cannot_commit_or_renew", () => {
  const f = fixture();
  try {
    f.campaign();
    const first = claimJob({ workerId: "first" }, f.context);
    assert.ok(first);
    assert.equal(claimJob({ workerId: "second" }, f.context), null);
    f.advance(60001);
    const second = claimJob({ workerId: "second" }, f.context);
    assert.ok(second);
    assert.equal(first.jobId, second.jobId);
    assert.equal(second.fence, first.fence + 1);
    assert.throws(() => heartbeatJob(first, f.context), /lease/);
    assert.throws(
      () => updateJob({ lease: first, state: "completed" }, f.context),
      /lease/,
    );
    assertLease(second, f.context);
    updateJob(
      { lease: second, state: "queued", checkpoint: { step: 1 } },
      f.context,
    );
    assert.equal(
      f.context.db
        .prepare("SELECT attempt_count FROM jobs WHERE id=?")
        .get(second.jobId)?.attempt_count,
      0,
    );
  } finally {
    f.close();
  }
});
