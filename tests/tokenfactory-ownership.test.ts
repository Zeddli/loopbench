import assert from "node:assert/strict";
import test from "node:test";
import {
  tokenOperationOwned,
  initializeTokenSandboxes,
} from "../hosted/tokenfactory-sandboxes";
import { fixture } from "./hosted-foundation-fixture";
import { reserveBudget } from "../hosted/budget";
import { readHostedStatus } from "../scripts/hosted-status";

test("Token Factory ownership is verified from provider metadata, image and network policy", () => {
  const expected = {
    intentId: "intent",
    ownerScope: "owner",
    campaignId: "campaign",
    attemptId: "attempt",
    role: "agent",
    imageId: "image",
  };
  const op = {
    uuid: "00000000-0000-4000-8000-000000000001",
    status: "EXECUTING" as const,
    image_uuid: "image",
    metadata: {
      networking: { enabled: false },
      env: {
        LOOPBENCH_INTENT: "intent",
        LOOPBENCH_OWNER: "owner",
        LOOPBENCH_CAMPAIGN: "campaign",
        LOOPBENCH_ATTEMPT: "attempt",
        LOOPBENCH_ROLE: "agent",
      },
    },
  };
  assert(tokenOperationOwned(expected, op));
  assert(!tokenOperationOwned(expected, { ...op, image_uuid: "foreign" }));
  assert(
    !tokenOperationOwned(expected, {
      ...op,
      metadata: { ...op.metadata, networking: { enabled: true } },
    }),
  );
  assert(
    !tokenOperationOwned(expected, {
      ...op,
      metadata: {
        ...op.metadata,
        env: { ...op.metadata.env, LOOPBENCH_OWNER: "foreign" },
      },
    }),
  );
});

test("E2B admission counts Token Factory slots, including uncertain operations", () => {
  const f = fixture();
  try {
    const campaign = f.campaign();
    initializeTokenSandboxes(f.context);
    f.context.db
      .prepare(
        "INSERT INTO token_sandbox_intents VALUES('one',?,?, 'attempt','agent','image','unknown',NULL,'project',NULL,NULL,0,0)",
      )
      .run(campaign.ownerScope, campaign.id);
    f.context.db
      .prepare(
        "INSERT INTO token_sandbox_intents VALUES('two',?,?, 'attempt','verifier','image','running',NULL,'project',NULL,NULL,0,0)",
      )
      .run(campaign.ownerScope, campaign.id);
    assert.throws(
      () =>
        reserveBudget(
          {
            ownerScope: campaign.ownerScope,
            campaignId: campaign.id,
            kind: "compute",
            amountUsdMicros: 10n,
            operationId: "new",
            operationKey: "new",
            acquireSandboxSlot: true,
          },
          f.context,
        ),
      { code: "GLOBAL_CAPACITY" },
    );
    const status = readHostedStatus(f.context);
    assert.equal(status.activeOrUncertainSandboxSlots, 2);
    assert.equal(status.tokenFactoryCompute?.costUsd, null);
    assert.equal(status.tokenFactoryCompute?.costStatus, "not_reported");
  } finally {
    f.close();
  }
});
