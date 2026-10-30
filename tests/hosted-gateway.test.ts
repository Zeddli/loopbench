import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fixture } from "./hosted-foundation-fixture";
import { savePricingSnapshot } from "../hosted/pricing";
import { claimJob } from "../hosted/jobs";
import { issueGatewayToken } from "../hosted/gateway-tokens";
import { handleChatCompletion } from "../hosted/gateway";
import { getBudgetSummary } from "../hosted/budget";

test("nullable provider cache details do not erase known billable usage", async () => {
  const f = gatewayFixture();
  try {
    const response = await handleChatCompletion(
      f.request(),
      f.context,
      async () =>
        Response.json({
          id: "null-cache",
          model: f.campaign.modelId,
          choices: [],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            prompt_tokens_details: null,
            completion_tokens_details: null,
          },
        }),
    );
    assert.equal(response.status, 200);
    await response.json();
    const budget = getBudgetSummary(
      { ownerScope: f.campaign.ownerScope, campaignId: f.campaign.id },
      f.context,
    ).inference;
    assert.equal(budget.unknownReservationCount, 0);
    assert.equal(budget.reservedUsdMicros, 0n);
    assert.equal(budget.settledUsdMicros, 11n);
  } finally {
    f.close();
  }
});

function gatewayFixture(role: "pi_attempt" | "optimizer" = "pi_attempt") {
  const f = fixture(),
    campaign = f.campaign();
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
    .prepare("UPDATE campaigns SET accepted_pricing_snapshot_id=? WHERE id=?")
    .run(price.id, campaign.id);
  const lease = claimJob({ workerId: "gateway-test" }, f.context);
  assert.ok(lease);
  const grant = issueGatewayToken(
    {
      ownerScope: campaign.ownerScope,
      campaignId: campaign.id,
      credentialId: campaign.credentialId,
      modelId: campaign.modelId,
      role,
      maxCalls: 5,
      lease,
    },
    f.context,
  );
  function request(extra: Record<string, unknown> = {}, key = randomUUID()) {
    return new Request(
      "https://gateway.example/api/inference/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${grant.token}`,
          "X-LoopBench-Request-Key": key,
        },
        body: JSON.stringify({
          model: campaign.modelId,
          max_tokens: 128,
          messages: [{ role: "user", content: "check" }],
          ...extra,
        }),
      },
    );
  }
  return { ...f, campaign, grant, lease, request };
}
test("only optimizer grants may opt into reasoning without changing Pi comparison protocol", async () => {
  for (const role of ["pi_attempt", "optimizer"] as const) {
    const f = gatewayFixture(role);
    try {
      const response = await handleChatCompletion(
        f.request({ chat_template_kwargs: { enable_thinking: true } }),
        f.context,
        async (_url, init) => {
          const sent = JSON.parse(String(init?.body));
          assert.equal(
            sent.chat_template_kwargs.enable_thinking,
            role === "optimizer",
          );
          return Response.json({
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 10 },
          });
        },
      );
      assert.equal(response.status, 200);
    } finally {
      f.close();
    }
  }
});
test("only optimizer requests may reserve a 16384-token reasoning and answer allowance", async () => {
  for (const role of ["pi_attempt", "optimizer"] as const) {
    const f = gatewayFixture(role);
    let sends = 0;
    try {
      const response = await handleChatCompletion(
        f.request({ max_tokens: 16384 }),
        f.context,
        async () => {
          sends++;
          return Response.json({
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 10 },
          });
        },
      );
      assert.equal(response.status, role === "optimizer" ? 200 : 422);
      assert.equal(sends, role === "optimizer" ? 1 : 0);
    } finally {
      f.close();
    }
  }
});
test("gateway reserves before send, preserves tool and usage-only SSE, settles exact usage", async () => {
  const f = gatewayFixture();
  try {
    const frames =
      'data: {"id":"provider-1","choices":[{"delta":{"content":null,"tool_calls":[{"index":0,"id":"call1","type":"function","function":{"name":"read","arguments":"{}"}}]}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":40}}}\n\ndata: [DONE]\n\n';
    const transport: typeof fetch = async (_url, init) => {
      const held = getBudgetSummary(
        { ownerScope: f.campaign.ownerScope, campaignId: f.campaign.id },
        f.context,
      ).inference;
      assert.ok(held.reservedUsdMicros > 0n);
      assert.ok(new Headers(init?.headers).get("authorization"));
      return new Response(frames, {
        headers: { "Content-Type": "text/event-stream" },
      });
    };
    const response = await handleChatCompletion(
      f.request({ stream: true }),
      f.context,
      transport,
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), frames);
    const account = getBudgetSummary(
      { ownerScope: f.campaign.ownerScope, campaignId: f.campaign.id },
      f.context,
    ).inference;
    assert.equal(account.reservedUsdMicros, 0n);
    assert.equal(account.settledUsdMicros, 11n);
    const row = f.context.db
      .prepare("SELECT usage_json FROM provider_calls")
      .get();
    assert.match(String(row?.usage_json), /cached_tokens/);
  } finally {
    f.close();
  }
});
test("upstream rejection and incomplete stream retain unknown billing holds", async () => {
  const f = gatewayFixture();
  try {
    const response = await handleChatCompletion(
      f.request(),
      f.context,
      async () => new Response("private provider body", { status: 429 }),
    );
    assert.equal(response.status, 429);
    assert.doesNotMatch(await response.text(), /private provider body/);
    const account = getBudgetSummary(
      { ownerScope: f.campaign.ownerScope, campaignId: f.campaign.id },
      f.context,
    ).inference;
    assert.ok(account.reservedUsdMicros > 0n);
    assert.equal(account.unknownReservationCount, 1);
  } finally {
    f.close();
  }
});
test("scope, model override, duplicate request and multimodal dimensions cannot send extra upstream calls", async () => {
  const f = gatewayFixture();
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    return Response.json({
      id: "one",
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  };
  try {
    assert.equal(
      (
        await handleChatCompletion(
          f.request({ model: "other/model" }),
          f.context,
          transport,
        )
      ).status,
      422,
    );
    assert.equal(
      (
        await handleChatCompletion(
          f.request({ max_completion_tokens: 8192 }),
          f.context,
          transport,
        )
      ).status,
      422,
    );
    assert.equal(
      (
        await handleChatCompletion(
          f.request({
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image_url",
                    image_url: { url: "https://example.com" },
                  },
                ],
              },
            ],
          }),
          f.context,
          transport,
        )
      ).status,
      422,
    );
    assert.equal(calls, 0);
    const key = randomUUID();
    assert.equal(
      (await handleChatCompletion(f.request({}, key), f.context, transport))
        .status,
      200,
    );
    assert.equal(
      (await handleChatCompletion(f.request({}, key), f.context, transport))
        .status,
      409,
    );
    assert.equal(calls, 1);
    f.advance(61000);
    assert.equal(
      (await handleChatCompletion(f.request(), f.context, transport)).status,
      409,
    );
    assert.equal(calls, 1);
  } finally {
    f.close();
  }
});
