import { test } from "node:test";
import assert from "node:assert/strict";
import { runNebiusTask } from "../integrations/nebius-adapter";

const request = {
  protocol: "loopbench.task.v1",
  task: {
    id: "sum",
    prompt: "Export a JavaScript function adding two numbers.",
  },
  config: {
    model: "nvidia/test-model",
    harness: "prompt-harness",
    settings: {
      maxCostUsd: "0.01",
      inputUsdPerMillion: "0.06",
      outputUsdPerMillion: "0.24",
      maxTokens: "1024",
    },
  },
  instructions: "",
};
const env = { NEBIUS_ALLOW_PAID: "1", NEBIUS_API_KEY: "test-only-key" };
const noNetwork: typeof fetch = async () => {
  assert.fail("No network request should be made");
};
test("paid inference is disabled without explicit opt-in", async () => {
  await assert.rejects(
    runNebiusTask(request, { fetch: noNetwork, env: {} }),
    /disabled/,
  );
});
test("budget admission refuses excessive completion before network", async () => {
  await assert.rejects(
    runNebiusTask(
      {
        ...request,
        config: {
          ...request.config,
          settings: { ...request.config.settings, maxCostUsd: "0.000001" },
        },
      },
      { fetch: noNetwork, env },
    ),
    /exceeds/,
  );
});
test("prices must be explicit", async () => {
  await assert.rejects(
    runNebiusTask(
      { ...request, config: { ...request.config, settings: {} } },
      { fetch: noNetwork, env },
    ),
    /explicitly/,
  );
});
test("credentials cannot be sent to a non-Nebius origin", async () => {
  await assert.rejects(
    runNebiusTask(request, {
      fetch: noNetwork,
      env: { ...env, NEBIUS_BASE_URL: "https://example.org/v1/" },
    }),
    /HTTPS Nebius/,
  );
});
test("adapter sends one bounded completion and returns actual usage with explicit price calculation", async () => {
  let calls = 0;
  const transport: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(
      String(url),
      "https://api.tokenfactory.nebius.com/v1/chat/completions",
    );
    assert.equal(options?.redirect, "error");
    assert.equal(options?.method, "POST");
    assert.equal(typeof options?.body, "string");
    const body = JSON.parse(String(options?.body));
    assert.equal(body.max_tokens, 1024);
    assert.equal(body.model, request.config.model);
    return Response.json({
      choices: [
        {
          message: { content: "module.exports = (a,b) => a+b;" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    });
  };
  const result = await runNebiusTask(request, { fetch: transport, env });
  assert.equal(calls, 1);
  assert.equal(result.inputTokens, 100);
  assert.equal(result.outputTokens, 20);
  assert.equal(result.costUsd, (100 * 0.06 + 20 * 0.24) / 1_000_000);
});
test("provider errors are not retried or leaked into persisted errors", async () => {
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    return new Response("private provider error including test-only-key", {
      status: 429,
    });
  };
  await assert.rejects(
    runNebiusTask(request, { fetch: transport, env }),
    (error) =>
      error instanceof Error &&
      error.message.includes("HTTP 429") &&
      !error.message.includes("test-only-key"),
  );
  assert.equal(calls, 1);
});
