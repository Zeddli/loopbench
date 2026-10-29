import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { z } from "zod";
import { requireHostedEnabled } from "./config";
import { withHostedTransaction } from "./database";
import { revokeGrants } from "./auth";
import {
  credentialStatusSchema,
  dbNumber,
  dbString,
  HostedError,
  now,
  type CredentialStatus,
  type CredentialSummary,
  type HostedContext,
} from "./schema";

function summary(row: Record<string, unknown>): CredentialSummary {
  return {
    id: dbString(row.id),
    provider: "nebius-token-factory",
    label: dbString(row.label),
    displayHint: dbString(row.display_hint),
    status: credentialStatusSchema.parse(row.status),
    balanceStatus: "unknown",
    verifiedAt: row.verified_at === null ? null : dbNumber(row.verified_at),
    createdAt: dbNumber(row.created_at),
    revision: dbNumber(row.revision),
  };
}
export function listCredentials(
  { ownerScope }: { ownerScope: string },
  context: HostedContext,
): CredentialSummary[] {
  return context.db
    .prepare(
      "SELECT id,label,display_hint,status,verified_at,created_at,revision FROM credentials WHERE owner_scope=? ORDER BY created_at DESC,id LIMIT 100",
    )
    .all(ownerScope)
    .map(summary);
}
export function getCredential(
  { ownerScope, credentialId }: { ownerScope: string; credentialId: string },
  context: HostedContext,
): CredentialSummary | null {
  const row = context.db
    .prepare(
      "SELECT id,label,display_hint,status,verified_at,created_at,revision FROM credentials WHERE owner_scope=? AND id=?",
    )
    .get(ownerScope, credentialId);
  return row ? summary(row) : null;
}
export function connectCredential(
  input: { ownerScope: string; apiKey: string; label?: string },
  context: HostedContext,
): CredentialSummary {
  requireHostedEnabled(context.config);
  const secret = z
    .string()
    .min(8)
    .max(4096)
    .refine((value) => value === value.trim() && !/[\r\n\u0000]/.test(value))
    .parse(input.apiKey);
  const label = z
    .string()
    .trim()
    .min(1)
    .max(80)
    .parse(input.label ?? "Nebius Token Factory");
  const id = randomUUID();
  const keyId = context.config.vaultActiveKeyId;
  const key = context.config.vaultKeys[keyId];
  if (!key)
    throw new HostedError(
      "HOSTED_DISABLED",
      "The credential vault is unavailable.",
      503,
    );
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(key, "base64"),
    nonce,
  );
  cipher.setAAD(
    Buffer.from(
      `loopbench:credential:v1:${input.ownerScope}:${id}:nebius-token-factory`,
    ),
  );
  const encrypted = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  const fingerprint = createHmac(
    "sha256",
    context.config.credentialFingerprintKey,
  )
    .update(secret)
    .digest("hex");
  const timestamp = now(context);
  context.db
    .prepare(
      "INSERT INTO credentials(id,owner_scope,provider,label,secret_ciphertext,nonce,auth_tag,encryption_key_id,fingerprint,display_hint,status,created_at,updated_at) VALUES(?,?,'nebius-token-factory',?,?,?,?,?,?,?,'unverified',?,?)",
    )
    .run(
      id,
      input.ownerScope,
      label,
      encrypted.toString("base64"),
      nonce.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      keyId,
      fingerprint,
      "Connected key ••••",
      timestamp,
      timestamp,
    );
  const result = getCredential(
    { ownerScope: input.ownerScope, credentialId: id },
    context,
  );
  if (!result) throw new Error("Credential was not persisted");
  return result;
}
/** Internal capability: never place this result in a DTO, job, event, or log. */
export function decryptCredential(
  input: { ownerScope: string; credentialId: string },
  context: HostedContext,
): string {
  const row = context.db
    .prepare(
      "SELECT * FROM credentials WHERE owner_scope=? AND id=? AND status IN ('unverified','verified','unavailable') AND NOT EXISTS(SELECT 1 FROM credential_revocations r WHERE r.owner_scope=credentials.owner_scope AND r.credential_id=credentials.id)",
    )
    .get(input.ownerScope, input.credentialId);
  if (!row)
    throw new HostedError(
      "NOT_FOUND",
      "The requested resource was not found.",
      404,
    );
  const key = context.config.vaultKeys[dbString(row.encryption_key_id)];
  if (!key)
    throw new HostedError(
      "CREDENTIAL_UNAVAILABLE",
      "The credential vault key is unavailable.",
      503,
    );
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(key, "base64"),
      Buffer.from(dbString(row.nonce), "base64"),
    );
    decipher.setAAD(
      Buffer.from(
        `loopbench:credential:v1:${input.ownerScope}:${input.credentialId}:nebius-token-factory`,
      ),
    );
    decipher.setAuthTag(Buffer.from(dbString(row.auth_tag), "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dbString(row.secret_ciphertext), "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new HostedError(
      "CREDENTIAL_UNAVAILABLE",
      "The stored credential could not be decrypted.",
      503,
    );
  }
}
export function setCredentialVerification(
  input: {
    ownerScope: string;
    credentialId: string;
    status: Exclude<CredentialStatus, "revoked">;
    errorCode?: string;
  },
  context: HostedContext,
): CredentialSummary {
  const timestamp = now(context);
  const result = context.db
    .prepare(
      "UPDATE credentials SET status=?,verified_at=CASE WHEN ?='verified' THEN ? ELSE verified_at END,last_checked_at=?,verification_error_code=?,updated_at=?,revision=revision+1 WHERE owner_scope=? AND id=? AND status!='revoked'",
    )
    .run(
      input.status,
      input.status,
      timestamp,
      timestamp,
      input.errorCode ?? null,
      timestamp,
      input.ownerScope,
      input.credentialId,
    );
  if (result.changes !== 1)
    throw new HostedError(
      "NOT_FOUND",
      "The requested resource was not found.",
      404,
    );
  if (input.status === "invalid")
    revokeGrants(input.ownerScope, input.credentialId, context);
  const value = getCredential(input, context);
  if (!value) throw new Error("Credential missing after verification");
  return value;
}
export function revokeCredential(
  input: {
    ownerScope: string;
    credentialId: string;
    expectedRevision?: number;
  },
  context: HostedContext,
): CredentialSummary {
  return withHostedTransaction(context.db, () => {
    const row = getCredential(input, context);
    if (!row)
      throw new HostedError(
        "NOT_FOUND",
        "The requested resource was not found.",
        404,
      );
    if (row.status === "revoked") return row;
    if (
      input.expectedRevision !== undefined &&
      row.revision !== input.expectedRevision
    )
      throw new HostedError(
        "REVISION_CONFLICT",
        "The credential changed. Refresh and try again.",
        409,
      );
    const timestamp = now(context);
    context.db
      .prepare(
        "INSERT INTO credential_revocations(owner_scope,credential_id,revoked_at) VALUES(?,?,?) ON CONFLICT DO NOTHING",
      )
      .run(input.ownerScope, input.credentialId, timestamp);
    context.db
      .prepare(
        "UPDATE credentials SET status='revoked',secret_ciphertext=NULL,nonce=NULL,auth_tag=NULL,encryption_key_id=NULL,revoked_at=?,updated_at=?,revision=revision+1 WHERE owner_scope=? AND id=?",
      )
      .run(timestamp, timestamp, input.ownerScope, input.credentialId);
    context.db
      .prepare(
        "UPDATE campaigns SET desired_control='stop',status='stopping',wait_reason='credential_revoked',control_revision=control_revision+1,updated_at=?,revision=revision+1 WHERE owner_scope=? AND credential_id=? AND status IN ('queued','running','waiting','paused','pausing')",
      )
      .run(timestamp, input.ownerScope, input.credentialId);
    context.db
      .prepare(
        "UPDATE jobs SET state='queued',available_at=?,updated_at=?,revision=revision+1 WHERE owner_scope=? AND state='waiting' AND campaign_id IN (SELECT id FROM campaigns WHERE owner_scope=? AND credential_id=?)",
      )
      .run(
        timestamp,
        timestamp,
        input.ownerScope,
        input.ownerScope,
        input.credentialId,
      );
    revokeGrants(input.ownerScope, input.credentialId, context);
    const result = getCredential(input, context);
    if (!result) throw new Error("Credential missing after revocation");
    return result;
  });
}
