import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createSession,
  requireBrowserOrigin,
  requireBrowserMutation,
  resolveSession,
  revokeSession,
} from "../hosted/auth";
import { fixture } from "./hosted-foundation-fixture";

test("development loopback aliases permit only same-origin requests at the configured port", () => {
  const f = fixture();
  try {
    f.context.config.publicOrigin = "http://127.0.0.1:3000";
    assert.doesNotThrow(() =>
      requireBrowserOrigin(
        new Request("http://localhost:3000/api/hosted/session", {
          headers: { origin: "http://localhost:3000" },
        }),
        f.context,
      ),
    );
    assert.throws(() =>
      requireBrowserOrigin(
        new Request("http://localhost:3001/api/hosted/session", {
          headers: { origin: "http://localhost:3001" },
        }),
        f.context,
      ),
    );
    assert.throws(() =>
      requireBrowserOrigin(
        new Request("http://localhost:3000/api/hosted/session", {
          headers: { origin: "https://attacker.example" },
        }),
        f.context,
      ),
    );
    f.context.config.production = true;
    assert.throws(() =>
      requireBrowserOrigin(
        new Request("http://localhost:3000/api/hosted/session", {
          headers: { origin: "http://localhost:3000" },
        }),
        f.context,
      ),
    );
  } finally {
    f.close();
  }
});

test("forged_session_and_expired_session_are_not_found", () => {
  const f = fixture();
  try {
    const headers = { cookie: f.identity.cookie.split(";")[0] };
    const request = new Request(f.context.config.publicOrigin, { headers });
    assert.equal(
      resolveSession(request, f.context)?.ownerScope,
      f.identity.session.ownerScope,
    );
    assert.equal(
      resolveSession(
        new Request(f.context.config.publicOrigin, {
          headers: { cookie: headers.cookie + "forged" },
        }),
        f.context,
      ),
      null,
    );
    f.advance(f.context.config.sessionDurationMs + 1);
    assert.equal(resolveSession(request, f.context), null);
  } finally {
    f.close();
  }
});
test("browser_origin_is_checked_against_configured_origin", () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        createSession(
          new Request(f.context.config.publicOrigin, {
            method: "POST",
            headers: {
              origin: "https://attacker.example",
              host: "localhost:3000",
            },
          }),
          f.context,
        ),
      /origin/,
    );
    assert.throws(
      () =>
        requireBrowserMutation(
          new Request(f.context.config.publicOrigin, {
            method: "POST",
            headers: { cookie: f.identity.cookie },
          }),
          f.context,
        ),
      /origin/,
    );
    revokeSession(
      { ownerScope: f.identity.session.ownerScope, expectedRevision: 1 },
      f.context,
    );
    assert.equal(
      resolveSession(
        new Request(f.context.config.publicOrigin, {
          headers: { cookie: f.identity.cookie },
        }),
        f.context,
      ),
      null,
    );
  } finally {
    f.close();
  }
});
