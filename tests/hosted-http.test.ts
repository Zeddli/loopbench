import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { z } from "zod";
import { fixture } from "./hosted-foundation-fixture";
import {
  idempotentEffect,
  readBody,
  requireMutation,
  requireSession,
} from "../hosted/http";

test("HTTP mutation boundary requires signed session, trusted origin and UUID operation", () => {
  const f = fixture();
  try {
    const request = (
      origin: string,
      cookie: string,
      key: string = randomUUID(),
    ) =>
      new Request(`${f.context.config.publicOrigin}/api/hosted/campaigns`, {
        method: "POST",
        headers: { origin, cookie, "Idempotency-Key": key },
      });
    assert.equal(
      requireMutation(
        request(f.context.config.publicOrigin, f.identity.cookie),
        f.context,
      ).session.sessionId,
      f.identity.session.sessionId,
    );
    assert.throws(
      () =>
        requireMutation(
          request("https://attacker.example", f.identity.cookie),
          f.context,
        ),
      /origin/,
    );
    assert.throws(
      () =>
        requireMutation(
          request(f.context.config.publicOrigin, "forged"),
          f.context,
        ),
      /not found/,
    );
    assert.throws(() =>
      requireMutation(
        request(f.context.config.publicOrigin, f.identity.cookie, "repeat"),
        f.context,
      ),
    );
    assert.throws(
      () =>
        requireSession(
          request(f.context.config.publicOrigin, "forged"),
          f.context,
        ),
      /not found/,
    );
  } finally {
    f.close();
  }
});
test("HTTP body is bounded and replay rejects route changes", async () => {
  await assert.rejects(
    readBody(
      new Request("https://local.test", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "{}",
      }),
      z.unknown(),
    ),
    /application\/json/,
  );
  await assert.rejects(
    readBody(
      new Request("https://local.test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "x".repeat(20000) }),
      }),
      z.unknown(),
    ),
    /too large/,
  );
  const f = fixture();
  try {
    const key: string = randomUUID();
    let calls = 0;
    const input = {
      ownerScope: f.identity.session.ownerScope,
      key,
      method: "POST",
      route: "test",
      body: { value: "bounded" },
      execute: () => ({ effectId: "safe", value: ++calls }),
      replay: () => calls,
    };
    assert.equal(idempotentEffect(input, f.context), 1);
    assert.equal(idempotentEffect(input, f.context), 1);
    assert.throws(
      () => idempotentEffect({ ...input, route: "different-route" }, f.context),
      /already used/,
    );
  } finally {
    f.close();
  }
});
