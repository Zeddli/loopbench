import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  connectCredential,
  decryptCredential,
  getCredential,
  revokeCredential,
} from "../hosted/credentials";
import { fixture } from "./hosted-foundation-fixture";

test("secret_never_appears_in_api_projection_and_is_owner_authenticated", () => {
  const f = fixture();
  try {
    const secret = "unique-local-only-fixture-vault-secret";
    const ownerScope = f.identity.session.ownerScope;
    const credential = connectCredential(
      { ownerScope, apiKey: secret },
      f.context,
    );
    assert.equal(JSON.stringify(credential).includes(secret), false);
    assert.equal(
      decryptCredential({ ownerScope, credentialId: credential.id }, f.context),
      secret,
    );
    const stored = f.context.db
      .prepare("SELECT * FROM credentials WHERE owner_scope=? AND id=?")
      .get(ownerScope, credential.id);
    assert.equal(JSON.stringify(stored).includes(secret), false);
    const foreign = f.owner();
    assert.equal(
      getCredential(
        { ownerScope: foreign.session.ownerScope, credentialId: credential.id },
        f.context,
      ),
      null,
    );
    assert.throws(
      () =>
        decryptCredential(
          {
            ownerScope: foreign.session.ownerScope,
            credentialId: credential.id,
          },
          f.context,
        ),
      /not found/,
    );
    f.context.db
      .prepare("UPDATE credentials SET auth_tag=? WHERE owner_scope=? AND id=?")
      .run(Buffer.alloc(16).toString("base64"), ownerScope, credential.id);
    assert.throws(
      () =>
        decryptCredential(
          { ownerScope, credentialId: credential.id },
          f.context,
        ),
      /decrypted/,
    );
  } finally {
    f.close();
  }
});
test("revocation_disables_existing_gateway_scope_and_erases_ciphertext", () => {
  const f = fixture();
  try {
    const campaign = f.campaign();
    f.context.db.exec(
      "CREATE TABLE gateway_grants(id TEXT PRIMARY KEY,owner_scope TEXT,campaign_id TEXT,status TEXT)",
    );
    f.context.db
      .prepare("INSERT INTO gateway_grants VALUES('grant',?,?,'active')")
      .run(campaign.ownerScope, campaign.id);
    assert.equal(
      revokeCredential(
        {
          ownerScope: campaign.ownerScope,
          credentialId: campaign.credentialId,
        },
        f.context,
      ).status,
      "revoked",
    );
    assert.equal(
      f.context.db
        .prepare("SELECT status FROM gateway_grants WHERE id='grant'")
        .get()?.status,
      "revoked",
    );
    assert.throws(
      () =>
        decryptCredential(
          {
            ownerScope: campaign.ownerScope,
            credentialId: campaign.credentialId,
          },
          f.context,
        ),
      /not found/,
    );
    assert.equal(
      f.context.db
        .prepare("SELECT secret_ciphertext FROM credentials WHERE id=?")
        .get(campaign.credentialId)?.secret_ciphertext,
      null,
    );
  } finally {
    f.close();
  }
});
