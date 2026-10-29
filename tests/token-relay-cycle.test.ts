import assert from "node:assert/strict";
import test from "node:test";
import { createTokenRelayCycle } from "../hosted/token-relay-cycle";

const request = {
  id: "00000000-0000-4000-8000-000000000001",
  body: "{}",
  headers: {
    authorization: "isolated-scope",
    "content-type": "application/json" as const,
    "x-loopbench-request-key": "isolated-request",
  },
};
test("relay recovers transient polling and response-delivery failures without repeating inference", async () => {
  let polls = 0,
    calls = 0,
    deliveries = 0;
  const retries: string[] = [];
  const cycle = createTokenRelayCycle({
    async poll() {
      if (++polls === 1) throw Error("transient read");
      return [request];
    },
    async infer() {
      calls++;
      return "exact-provider-bytes";
    },
    async deliver(id, bytes) {
      assert.equal(id, request.id);
      assert.equal(bytes, "exact-provider-bytes");
      if (++deliveries === 1) throw Error("uncertain delivery");
    },
    assertFence() {},
    async delay() {},
    onRetry(stage) {
      retries.push(stage);
    },
  });
  await cycle();
  await cycle();
  assert.equal(calls, 1);
  assert.equal(deliveries, 2);
  assert.deepEqual(retries, ["poll", "deliver"]);
});
test("relay never retries an ambiguous inference request, even if polled again", async () => {
  let calls = 0,
    deliveries = 0;
  const cycle = createTokenRelayCycle({
    async poll() {
      return [request];
    },
    async infer() {
      calls++;
      throw Error("unknown provider outcome");
    },
    async deliver() {
      deliveries++;
    },
    assertFence() {},
    async delay() {},
    onRetry() {},
  });
  await assert.rejects(cycle(), /unknown provider outcome/);
  await cycle();
  assert.equal(calls, 1);
  assert.equal(deliveries, 0);
});
test("relay bounds I/O retries and aborts admission when its lease is lost", async () => {
  let reads = 0,
    checks = 0,
    calls = 0;
  const cycle = createTokenRelayCycle({
    async poll() {
      reads++;
      throw Error("read unavailable");
    },
    async infer() {
      calls++;
      return "";
    },
    async deliver() {},
    assertFence() {
      checks++;
    },
    async delay() {},
    onRetry() {},
  });
  await assert.rejects(cycle(), /read unavailable/);
  assert.equal(reads, 3);
  assert.equal(calls, 0);
  const fenced = createTokenRelayCycle({
    async poll() {
      reads++;
      return [request];
    },
    async infer() {
      calls++;
      return "";
    },
    async deliver() {},
    assertFence() {
      throw Error("fenced");
    },
    async delay() {},
    onRetry() {},
  });
  await assert.rejects(fenced(), /fenced/);
  assert.equal(reads, 3);
  assert.equal(calls, 0);
  assert.equal(checks, 3);
});
