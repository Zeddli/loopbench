import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  tokenOperationOwned,
  initializeTokenSandboxes,
  reapTokenSandboxes,
} from "../hosted/tokenfactory-sandboxes";
import { initializeEvolution } from "../hosted/evolution";
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

for (const terminalIntent of ["prepared", "running"] as const) {
  for (const uncertainSibling of [false, true]) {
    test(`Token Factory reaper reconciles ${terminalIntent} interruption only after all attempt obligations terminate, uncertain sibling=${uncertainSibling}`, async (t) => {
      const f = fixture();
      const priorProject = process.env.NEBIUS_PROJECT_ID;
      const priorKey = process.env.NEBIUS_API_KEY;
      process.env.NEBIUS_PROJECT_ID = "offline-reaper-test-project";
      process.env.NEBIUS_API_KEY = "offline-reaper-test-key";
      t.after(() => {
        if (priorProject === undefined) delete process.env.NEBIUS_PROJECT_ID;
        else process.env.NEBIUS_PROJECT_ID = priorProject;
        if (priorKey === undefined) delete process.env.NEBIUS_API_KEY;
        else process.env.NEBIUS_API_KEY = priorKey;
        f.close();
      });
      const campaign = f.campaign();
      initializeEvolution(f.context);
      initializeTokenSandboxes(f.context);
      const operationId = "00000000-0000-4000-8000-000000000002";
      t.mock.method(
        globalThis,
        "fetch",
        async (url: string | URL | Request) => {
          if (String(url).endsWith("/operations"))
            return Response.json({ operations: [] });
          assert.equal(
            String(url).endsWith(`/operations/${operationId}`),
            true,
          );
          return Response.json({
            uuid: operationId,
            status: "CANCELLED",
            image_uuid: "image",
            metadata: {
              networking: { enabled: false },
              env: {
                LOOPBENCH_INTENT: "agent",
                LOOPBENCH_OWNER: campaign.ownerScope,
                LOOPBENCH_CAMPAIGN: campaign.id,
                LOOPBENCH_ATTEMPT: "interrupted-attempt",
                LOOPBENCH_ROLE: "agent",
              },
            },
          });
        },
      );
      f.context.db
        .prepare(
          "INSERT INTO hosted_attempts VALUES('interrupted-attempt',?,?,'node','candidate','strict-csv','running',NULL,'agent','verifier',0,0)",
        )
        .run(campaign.ownerScope, campaign.id);
      const digest = createHash("sha256")
        .update("offline-reaper-test-project")
        .digest("hex");
      f.context.db
        .prepare(
          "INSERT INTO token_sandbox_intents VALUES('agent',?,?,'interrupted-attempt','agent','image',?,?,?,NULL,NULL,0,0)",
        )
        .run(
          campaign.ownerScope,
          campaign.id,
          terminalIntent,
          terminalIntent === "prepared" ? null : operationId,
          digest,
        );
      if (uncertainSibling)
        f.context.db
          .prepare(
            "INSERT INTO token_sandbox_intents VALUES('verifier',?,?,'interrupted-attempt','verifier','image','unknown',NULL,?,NULL,NULL,0,0)",
          )
          .run(campaign.ownerScope, campaign.id, digest);

      const result = await reapTokenSandboxes(f.context);
      assert.equal(result.terminated, 1);
      assert.equal(result.uncertain, uncertainSibling ? 1 : 0);
      assert.equal(
        f.context.db
          .prepare("SELECT status FROM token_sandbox_intents WHERE id='agent'")
          .get()?.status,
        "terminated",
      );
      assert.equal(
        f.context.db
          .prepare(
            "SELECT status FROM hosted_attempts WHERE id='interrupted-attempt'",
          )
          .get()?.status,
        uncertainSibling ? "running" : "infrastructure_failed",
      );
      if (uncertainSibling)
        assert.equal(
          f.context.db
            .prepare(
              "SELECT status FROM token_sandbox_intents WHERE id='verifier'",
            )
            .get()?.status,
          "unknown",
        );
    });
  }
}
