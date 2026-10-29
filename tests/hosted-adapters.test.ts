import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Adapters from "../app/adapters/page";
import { HarnessReadinessCard } from "../components/hosted/HostedHarnessCatalog";

test("hosted adapter page shows cloud runtime checks instead of an empty local registry", async () => {
  const previous = process.env.LOOPBENCH_HOSTED_ENABLED;
  process.env.LOOPBENCH_HOSTED_ENABLED = "1";
  try {
    const html = renderToStaticMarkup(await Adapters());
    assert(html.includes("Nebius Token Factory Sandboxes"));
    assert(html.includes("E2B"));
    assert(html.includes('href="/experiments/new"'));
    assert(html.includes("Checking runtime"));
    assert(!html.includes("No adapters registered"));
    assert(!html.includes("0 registered"));
    assert(!html.includes("Runtime ready"));
  } finally {
    if (previous === undefined) delete process.env.LOOPBENCH_HOSTED_ENABLED;
    else process.env.LOOPBENCH_HOSTED_ENABLED = previous;
  }
});

test("an unavailable hosted runtime displays the readiness reason without claiming availability", () => {
  const html = renderToStaticMarkup(
    createElement(HarnessReadinessCard, {
      name: "E2B",
      state: {
        status: "loaded",
        readiness: {
          ready: false,
          hash: null,
          piVersion: "1.4.0",
          nodeVersion: null,
          templateId: null,
          reason: "The operator must configure the approved runtime.",
        },
      },
    }),
  );
  assert(html.includes("Runtime unavailable"));
  assert(html.includes("The operator must configure the approved runtime."));
  assert(!html.includes("Runtime ready"));
});

test("ready harness cards show version information and omit internal runtime identifiers", () => {
  const html = renderToStaticMarkup(
    createElement(HarnessReadinessCard, {
      name: "Nebius Token Factory Sandboxes",
      state: {
        status: "loaded",
        readiness: {
          ready: true,
          hash: "internal-harness-hash",
          piVersion: "1.4.0",
          nodeVersion: "v24.15.0",
          templateId: "internal-template-id",
          reason: null,
        },
      },
    }),
  );
  assert(html.includes("Runtime ready"));
  assert(html.includes("Pi 1.4.0"));
  assert(!html.includes("internal-harness-hash"));
  assert(!html.includes("internal-template-id"));
});
