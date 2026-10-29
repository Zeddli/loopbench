import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { requireHostedEnabled } from "./config";
import { withHostedTransaction } from "./database";
import {
  dbNumber,
  dbString,
  HostedError,
  now,
  type HostedContext,
  type SessionContext,
} from "./schema";

function signature(value: string, context: HostedContext): string {
  return createHmac("sha256", context.config.sessionSigningKey)
    .update(value)
    .digest("base64url");
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function requireBrowserOrigin(
  request: Request,
  context: HostedContext,
): void {
  requireHostedEnabled(context.config);
  const supplied = request.headers.get("origin");
  let allowed = supplied === context.config.publicOrigin;
  if (!allowed && !context.config.production) {
    const canonical = new URL(context.config.publicOrigin),
      target = new URL(request.url);
    const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
    allowed =
      canonical.protocol === "http:" &&
      loopback.has(canonical.hostname) &&
      loopback.has(target.hostname) &&
      target.protocol === canonical.protocol &&
      target.port === canonical.port &&
      supplied === target.origin;
  }
  if (!allowed || request.headers.get("sec-fetch-site") === "cross-site")
    throw new HostedError(
      "ORIGIN_FORBIDDEN",
      "This request must come from the application origin.",
      403,
    );
}
export function resolveSession(
  request: Request,
  context: HostedContext,
): SessionContext | null {
  requireHostedEnabled(context.config);
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${context.config.sessionCookieName}=`));
  if (!cookie) return null;
  const value = cookie.slice(context.config.sessionCookieName.length + 1);
  const parts = value.split(".");
  const [keyId, token, sig] = parts;
  if (
    parts.length !== 3 ||
    keyId !== context.config.sessionSigningKeyId ||
    !token ||
    token.length !== 43 ||
    !sig ||
    !same(sig, signature(`${keyId}.${token}`, context))
  )
    return null;
  const row = context.db
    .prepare(
      "SELECT * FROM sessions WHERE token_digest=? AND status='active' AND expires_at>?",
    )
    .get(digest(token), now(context));
  if (!row) return null;
  return {
    sessionId: dbString(row.id),
    ownerScope: dbString(row.owner_scope),
    expiresAt: dbNumber(row.expires_at),
    revision: dbNumber(row.revision),
    createdAt: dbNumber(row.created_at),
  };
}
export function createSession(
  request: Request,
  context: HostedContext,
): { session: SessionContext; cookie: string } {
  requireBrowserOrigin(request, context);
  const existing = resolveSession(request, context);
  if (existing) return { session: existing, cookie: "" };
  const token = randomBytes(32).toString("base64url");
  const keyId = context.config.sessionSigningKeyId;
  const createdAt = now(context);
  const expiresAt = createdAt + context.config.sessionDurationMs;
  const session = {
    sessionId: randomUUID(),
    ownerScope: randomUUID(),
    expiresAt,
    createdAt,
    revision: 1,
  };
  context.db
    .prepare(
      "INSERT INTO sessions(id,owner_scope,token_digest,signing_key_id,status,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,'active',?,?,?)",
    )
    .run(
      session.sessionId,
      session.ownerScope,
      digest(token),
      keyId,
      createdAt,
      createdAt,
      expiresAt,
    );
  const cookie = `${context.config.sessionCookieName}=${keyId}.${token}.${signature(`${keyId}.${token}`, context)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(context.config.sessionDurationMs / 1000)}${context.config.production ? "; Secure" : ""}`;
  return { session, cookie };
}
export function requireBrowserMutation(
  request: Request,
  context: HostedContext,
): SessionContext {
  requireBrowserOrigin(request, context);
  const session = resolveSession(request, context);
  if (!session)
    throw new HostedError(
      "NOT_FOUND",
      "The requested resource was not found.",
      404,
    );
  return session;
}
export function revokeSession(
  input: { ownerScope: string; expectedRevision: number },
  context: HostedContext,
): { affectedCampaignCount: number; cookie: string } {
  return withHostedTransaction(context.db, () => {
    const timestamp = now(context);
    const changed = context.db
      .prepare(
        "UPDATE sessions SET status='revoked',revoked_at=?,revision=revision+1 WHERE owner_scope=? AND status='active' AND revision=?",
      )
      .run(timestamp, input.ownerScope, input.expectedRevision);
    if (changed.changes !== 1)
      throw new HostedError(
        "NOT_FOUND",
        "The requested resource was not found.",
        404,
      );
    const campaigns = context.db
      .prepare(
        "UPDATE campaigns SET desired_control='stop',status='stopping',control_revision=control_revision+1,revision=revision+1,updated_at=? WHERE owner_scope=? AND status IN ('queued','running','pausing','paused','waiting')",
      )
      .run(timestamp, input.ownerScope);
    context.db
      .prepare(
        "UPDATE jobs SET state='queued',available_at=?,updated_at=?,revision=revision+1 WHERE owner_scope=? AND state='waiting'",
      )
      .run(timestamp, timestamp, input.ownerScope);
    revokeGrants(input.ownerScope, undefined, context);
    return {
      affectedCampaignCount: Number(campaigns.changes),
      cookie: `${context.config.sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${context.config.production ? "; Secure" : ""}`,
    };
  });
}
export function revokeGrants(
  ownerScope: string,
  credentialId: string | undefined,
  context: HostedContext,
): void {
  // The gateway owns this optional table. Its status contract is active/revoked.
  if (
    !context.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='gateway_grants'",
      )
      .get()
  )
    return;
  if (credentialId)
    context.db
      .prepare(
        "UPDATE gateway_grants SET status='revoked' WHERE owner_scope=? AND campaign_id IN (SELECT id FROM campaigns WHERE owner_scope=? AND credential_id=?)",
      )
      .run(ownerScope, ownerScope, credentialId);
  else
    context.db
      .prepare("UPDATE gateway_grants SET status='revoked' WHERE owner_scope=?")
      .run(ownerScope);
}
