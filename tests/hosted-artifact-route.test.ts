import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { getHostedContext } from "../hosted/database";
import { saveArtifact } from "../hosted/artifacts";
import { fixture } from "./hosted-foundation-fixture";

test("artifact downloads return owner bytes as attachments and hide private IDs", async () => {
  const f = fixture();
  const env = {
    LOOPBENCH_HOSTED_ENABLED: "1",
    LOOPBENCH_HOSTED_DB_PATH: f.path,
    LOOPBENCH_PUBLIC_ORIGIN: f.context.config.publicOrigin,
    LOOPBENCH_SESSION_SIGNING_KEY: f.context.config.sessionSigningKey,
    LOOPBENCH_CREDENTIAL_FINGERPRINT_KEY:
      f.context.config.credentialFingerprintKey,
    LOOPBENCH_VAULT_KEYRING_JSON: JSON.stringify({
      activeKeyId: "test",
      keys: f.context.config.vaultKeys,
    }),
  };
  const previous = new Map(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);
  let closeRouteDatabase: (() => void) | undefined;
  try {
    const { GET } = await import("../app/api/hosted/artifacts/[id]/route");
    const routeContext = getHostedContext();
    closeRouteDatabase = () => routeContext.db.close();
    const campaign = f.campaign();
    const contents = "<script>alert('private evidence')</script>\nπ";
    const owner = saveArtifact(
      {
        ownerScope: campaign.ownerScope,
        campaignId: campaign.id,
        kind: "submission",
        contents,
        visibility: "owner",
      },
      f.context,
    );
    const internal = saveArtifact(
      {
        ownerScope: campaign.ownerScope,
        campaignId: campaign.id,
        kind: "pi-events",
        contents: "internal-only evidence",
        visibility: "internal_only",
      },
      f.context,
    );
    function download(id: string, cookie = f.identity.cookie) {
      return GET(
        new Request(
          `${f.context.config.publicOrigin}/api/hosted/artifacts/${id}`,
          {
            headers: cookie ? { cookie } : {},
          },
        ),
        { params: Promise.resolve({ id }) },
      );
    }
    const response = await download(owner.id);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), contents);
    assert.equal(
      response.headers.get("content-type"),
      "application/octet-stream",
    );
    assert.match(
      response.headers.get("content-disposition") ?? "",
      /^attachment; filename="[a-z0-9_-]+\.txt"$/,
    );
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");

    const foreign = f.owner();
    for (const denied of [
      await download(owner.id, foreign.cookie),
      await download(internal.id),
      await download(owner.id, ""),
      await download(randomUUID()),
    ]) {
      assert.equal(denied.status, 404);
      const body = await denied.text();
      assert.match(body, /NOT_FOUND/);
      assert(!body.includes("private evidence"));
      assert(!body.includes("internal-only evidence"));
      assert.equal(denied.headers.get("cache-control"), "private, no-store");
    }
  } finally {
    closeRouteDatabase?.();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    f.close();
  }
});
