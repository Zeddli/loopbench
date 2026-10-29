import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  rateLimitCatalog,
  rateLimitCredentialConnect,
  rateLimitSessionBootstrap,
} from "../hosted/rate-limit";
import { connectCredential } from "../hosted/credentials";
import { openHostedDatabase } from "../hosted/database";
import { fixture } from "./hosted-foundation-fixture";

test("bootstrap_global_limit_is_durable_and_existing_sessions_reuse_identity", () => {
  const f = fixture();
  try {
    const request = new Request(f.context.config.publicOrigin, {
      method: "POST",
      headers: { origin: f.context.config.publicOrigin },
    });
    for (let i = 0; i < 100; i++)
      rateLimitSessionBootstrap(request, f.context, {});
    const db = openHostedDatabase({ path: f.path });
    try {
      assert.throws(
        () => rateLimitSessionBootstrap(request, { ...f.context, db }, {}),
        /Too many/,
      );
    } finally {
      db.close();
    }
    rateLimitSessionBootstrap(
      new Request(f.context.config.publicOrigin, {
        method: "POST",
        headers: {
          origin: f.context.config.publicOrigin,
          cookie: f.identity.cookie,
        },
      }),
      f.context,
      {},
    );
    f.advance(3600000);
    rateLimitSessionBootstrap(request, f.context, {});
  } finally {
    f.close();
  }
});
test("trusted_proxy_ip_is_keyed_and_untrusted_forwarded_headers_are_ignored", () => {
  const f = fixture();
  try {
    const ip = "203.0.113.17";
    const request = new Request(f.context.config.publicOrigin, {
      method: "POST",
      headers: { origin: f.context.config.publicOrigin, "x-forwarded-for": ip },
    });
    for (let i = 0; i < 30; i++)
      rateLimitSessionBootstrap(request, f.context, {
        LOOPBENCH_TRUSTED_PROXY_HEADERS: "1",
      });
    assert.throws(
      () =>
        rateLimitSessionBootstrap(request, f.context, {
          LOOPBENCH_TRUSTED_PROXY_HEADERS: "1",
        }),
      /Too many/,
    );
    assert.equal(
      JSON.stringify(
        f.context.db.prepare("SELECT * FROM rate_limit_windows").all(),
      ).includes(ip),
      false,
    );
    rateLimitSessionBootstrap(request, f.context, {});
    assert.throws(
      () =>
        rateLimitSessionBootstrap(
          new Request(f.context.config.publicOrigin, {
            headers: {
              origin: f.context.config.publicOrigin,
              "x-forwarded-for": "203.0.113.17, 127.0.0.1",
            },
          }),
          f.context,
          { LOOPBENCH_TRUSTED_PROXY_HEADERS: "1" },
        ),
      /trusted proxy/,
    );
  } finally {
    f.close();
  }
});
test("connect_and_catalog_limits_apply_to_both_session_and_key_fingerprint", () => {
  const f = fixture();
  try {
    const ownerScope = f.identity.session.ownerScope;
    const apiKey = "local-only-limit-fixture-key";
    for (let i = 0; i < 5; i++)
      rateLimitCredentialConnect({ ownerScope, apiKey }, f.context);
    const other = f.owner();
    assert.throws(
      () =>
        rateLimitCredentialConnect(
          { ownerScope: other.session.ownerScope, apiKey },
          f.context,
        ),
      /Too many/,
    );
    const credential = connectCredential({ ownerScope, apiKey }, f.context);
    const second = connectCredential(
      { ownerScope: other.session.ownerScope, apiKey },
      f.context,
    );
    for (let i = 0; i < 10; i++)
      rateLimitCatalog({ ownerScope, credentialId: credential.id }, f.context);
    assert.throws(
      () =>
        rateLimitCatalog(
          { ownerScope: other.session.ownerScope, credentialId: second.id },
          f.context,
        ),
      /Too many/,
    );
    assert.throws(
      () =>
        rateLimitCatalog(
          { ownerScope: other.session.ownerScope, credentialId: credential.id },
          f.context,
        ),
      /not found/,
    );
    f.advance(900001);
    rateLimitCatalog({ ownerScope, credentialId: credential.id }, f.context);
  } finally {
    f.close();
  }
});
