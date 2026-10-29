import { strict as assert } from "node:assert";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { loadHostedConfig, requireHostedEnabled } from "../hosted/config";

test("missing_hosted_secrets_fail_closed", () => {
  assert.equal(loadHostedConfig({}).enabled, false);
  assert.throws(() => requireHostedEnabled(loadHostedConfig({})), /disabled/);
  assert.throws(
    () => loadHostedConfig({ LOOPBENCH_HOSTED_ENABLED: "true" }),
    /configuration/,
  );
  const env = {
    LOOPBENCH_HOSTED_ENABLED: "true",
    LOOPBENCH_HOSTED_DB_PATH: join(tmpdir(), "private.sqlite"),
    LOOPBENCH_PUBLIC_ORIGIN: "https://loopbench.example",
    LOOPBENCH_SESSION_SIGNING_KEY: randomBytes(32).toString("hex"),
    LOOPBENCH_CREDENTIAL_FINGERPRINT_KEY: randomBytes(32).toString("hex"),
    LOOPBENCH_VAULT_KEYRING_JSON: JSON.stringify({
      activeKeyId: "a",
      keys: { a: randomBytes(32).toString("base64") },
    }),
    NODE_ENV: "production",
  };
  assert.equal(
    loadHostedConfig(env).platformComputeHardLimitUsdMicros,
    100000000n,
  );
  assert.throws(
    () =>
      loadHostedConfig({
        ...env,
        LOOPBENCH_PUBLIC_ORIGIN: "http://loopbench.example",
      }),
    /configuration/,
  );
});
