import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "../hosted/auth";
import { loadHostedConfig } from "../hosted/config";
import {
  connectCredential,
  setCredentialVerification,
} from "../hosted/credentials";
import { openHostedDatabase } from "../hosted/database";
import { createCampaign } from "../hosted/store";

export function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "loopbench-hosted-"));
  const path = join(directory, "hosted.sqlite");
  const config = {
    ...loadHostedConfig({}),
    enabled: true,
    dbPath: path,
    sessionSigningKey: randomBytes(32).toString("hex"),
    credentialFingerprintKey: randomBytes(32).toString("hex"),
    vaultActiveKeyId: "test",
    vaultKeys: { test: randomBytes(32).toString("base64") },
  };
  let timestamp = 1800000000000;
  const context = {
    db: openHostedDatabase({ path }),
    config,
    now: () => timestamp,
  };
  function owner() {
    return createSession(
      new Request(`${config.publicOrigin}/api/hosted/session`, {
        method: "POST",
        headers: { origin: config.publicOrigin },
      }),
      context,
    );
  }
  const identity = owner();
  function campaign(
    ownerScope = identity.session.ownerScope,
    operationKey = randomBytes(12).toString("hex"),
  ) {
    const credential = connectCredential(
      { ownerScope, apiKey: "local-fixture-credential-not-a-provider-key" },
      context,
    );
    setCredentialVerification(
      { ownerScope, credentialId: credential.id, status: "verified" },
      context,
    );
    return createCampaign(
      {
        ownerScope,
        credentialId: credential.id,
        modelId: "fixture/model",
        benchmarkId: "fixture-benchmark",
        harnessId: "fixture-harness",
        inferenceAllowanceUsdMicros: 200000n,
        idempotencyKey: operationKey,
      },
      context,
    );
  }
  return {
    context,
    identity,
    owner,
    campaign,
    path,
    advance: (ms: number) => {
      timestamp += ms;
    },
    close: () => {
      context.db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
