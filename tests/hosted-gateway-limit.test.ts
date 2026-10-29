import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fixture } from "./hosted-foundation-fixture";
import { claimJob } from "../hosted/jobs";
import { savePricingSnapshot } from "../hosted/pricing";
import {
  confirmScopedCallLimit,
  issueGatewayToken,
} from "../hosted/gateway-tokens";
import { handleChatCompletion } from "../hosted/gateway";
import {
  canGradeSettledCallLimit,
  initialPiRunState,
} from "../hosted/pi-events";

function limitFixture() {
  const f = fixture();
  const campaign = f.campaign();
  const price = savePricingSnapshot(
    {
      ownerScope: campaign.ownerScope,
      credentialId: campaign.credentialId,
      modelId: campaign.modelId,
      promptUsdPerToken: "0.00000006",
      completionUsdPerToken: "0.00000024",
    },
    f.context,
  );
  f.context.db
    .prepare(
      "UPDATE campaigns SET accepted_pricing_snapshot_id=? WHERE owner_scope=? AND id=?",
    )
    .run(price.id, campaign.ownerScope, campaign.id);
  const claimed = claimJob(
    { workerId: "offline-call-limit-regression" },
    f.context,
  );
  assert.ok(claimed);
  const lease = claimed;
  function newGrant() {
    const attemptId = randomUUID();
    const grant = issueGatewayToken(
      {
        ownerScope: campaign.ownerScope,
        campaignId: campaign.id,
        credentialId: campaign.credentialId,
        attemptId,
        modelId: campaign.modelId,
        role: "pi_attempt",
        maxCalls: 1,
        lease,
      },
      f.context,
    );
    const scope = {
      ownerScope: campaign.ownerScope,
      campaignId: campaign.id,
      attemptId,
    };
    function request(stream = false) {
      return new Request(
        "https://local-fixture.invalid/api/inference/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${grant.token}`,
            "X-LoopBench-Request-Key": randomUUID(),
          },
          body: JSON.stringify({
            model: campaign.modelId,
            max_tokens: 32,
            messages: [{ role: "user", content: "Offline fixture" }],
            stream,
          }),
        },
      );
    }
    return { grant, scope, request };
  }
  const settledError = {
    ...initialPiRunState(),
    accepted: true,
    started: true,
    settled: true,
    processEnded: true,
    exitCode: 0,
    lastStopReason: "error",
  };
  return { ...f, campaign, newGrant, settledError };
}
const unexpectedTransmission: typeof fetch = async () => {
  throw new Error("Local call-limit rejection must not transmit upstream");
};

test("provider quota on the final upstream call stays ungradable after a local call-limit rejection", async () => {
  const f = limitFixture();
  try {
    const attempt = f.newGrant();
    let sends = 0;
    const rejection = await handleChatCompletion(
      attempt.request(),
      f.context,
      async () => {
        sends++;
        return new Response("Private provider diagnostics", { status: 429 });
      },
    );
    assert.equal(rejection.status, 429);
    assert.doesNotMatch(await rejection.text(), /Private provider diagnostics/);
    assert.equal(
      f.context.db
        .prepare(
          "SELECT last_error_code FROM gateway_grants WHERE owner_scope=? AND id=?",
        )
        .get(f.campaign.ownerScope, attempt.grant.id)?.last_error_code,
      "PROVIDER_QUOTA",
    );
    const limited = await handleChatCompletion(
      attempt.request(),
      f.context,
      unexpectedTransmission,
    );
    assert.equal(limited.status, 429);
    assert.match(await limited.text(), /ATTEMPT_CALL_LIMIT/);
    assert.equal(sends, 1);
    assert.equal(
      f.context.db
        .prepare(
          "SELECT last_error_code FROM gateway_grants WHERE owner_scope=? AND id=?",
        )
        .get(f.campaign.ownerScope, attempt.grant.id)?.last_error_code,
      "PROVIDER_QUOTA",
    );
    assert.equal(confirmScopedCallLimit(attempt.scope, f.context), false);
    assert.equal(
      canGradeSettledCallLimit(
        f.settledError,
        confirmScopedCallLimit(attempt.scope, f.context),
      ),
      false,
    );
    assert.equal(
      f.context.db
        .prepare(
          "SELECT status FROM provider_calls WHERE owner_scope=? AND grant_id=?",
        )
        .get(f.campaign.ownerScope, attempt.grant.id)?.status,
      "unknown",
    );
  } finally {
    f.close();
  }
});

test("an incomplete final upstream stream cannot become gradable merely by reaching the local call limit", async () => {
  const f = limitFixture();
  try {
    const attempt = f.newGrant();
    const response = await handleChatCompletion(
      attempt.request(true),
      f.context,
      async () =>
        new Response(
          'data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: {"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(
      f.context.db
        .prepare(
          "SELECT status FROM provider_calls WHERE owner_scope=? AND grant_id=?",
        )
        .get(f.campaign.ownerScope, attempt.grant.id)?.status,
      "unknown",
    );
    assert.equal(
      (
        await handleChatCompletion(
          attempt.request(),
          f.context,
          unexpectedTransmission,
        )
      ).status,
      429,
    );
    assert.equal(
      f.context.db
        .prepare(
          "SELECT last_error_code FROM gateway_grants WHERE owner_scope=? AND id=?",
        )
        .get(f.campaign.ownerScope, attempt.grant.id)?.last_error_code,
      "ATTEMPT_CALL_LIMIT",
    );
    assert.equal(confirmScopedCallLimit(attempt.scope, f.context), false);
    assert.equal(
      canGradeSettledCallLimit(
        f.settledError,
        confirmScopedCallLimit(attempt.scope, f.context),
      ),
      false,
    );
  } finally {
    f.close();
  }
});

test("completed calls plus the authenticated local limit qualify only their exact owned attempt", async () => {
  const f = limitFixture();
  try {
    const complete = f.newGrant();
    const unknown = f.newGrant();
    const response = await handleChatCompletion(
      complete.request(true),
      f.context,
      async () =>
        new Response(
          'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":null}}\n\ndata: [DONE]\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(
      confirmScopedCallLimit(complete.scope, f.context),
      false,
      "Using all calls does not itself prove a local-limit termination",
    );
    assert.equal(
      (
        await handleChatCompletion(
          complete.request(),
          f.context,
          unexpectedTransmission,
        )
      ).status,
      429,
    );
    const unknownResponse = await handleChatCompletion(
      unknown.request(true),
      f.context,
      async () =>
        new Response('data: {"choices":[]}\n\n', {
          headers: { "Content-Type": "text/event-stream" },
        }),
    );
    await unknownResponse.text();
    await handleChatCompletion(
      unknown.request(),
      f.context,
      unexpectedTransmission,
    );
    assert.equal(
      confirmScopedCallLimit(complete.scope, f.context),
      true,
      "Another grant's unresolved call does not contaminate the completed exact grant",
    );
    assert.equal(
      canGradeSettledCallLimit(
        f.settledError,
        confirmScopedCallLimit(complete.scope, f.context),
      ),
      true,
    );
    assert.equal(confirmScopedCallLimit(unknown.scope, f.context), false);
    assert.equal(
      confirmScopedCallLimit(
        { ...complete.scope, ownerScope: f.owner().session.ownerScope },
        f.context,
      ),
      false,
    );
    assert.equal(
      confirmScopedCallLimit(
        { ...complete.scope, campaignId: randomUUID() },
        f.context,
      ),
      false,
    );
    assert.equal(
      confirmScopedCallLimit(
        { ...complete.scope, attemptId: randomUUID() },
        f.context,
      ),
      false,
    );
  } finally {
    f.close();
  }
});
