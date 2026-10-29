import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { requireBrowserOrigin, resolveSession } from "./auth";
import { withHostedTransaction } from "./database";
import {
  dbNumber,
  dbString,
  HostedError,
  now,
  type HostedContext,
} from "./schema";
import { PLATFORM_OWNER_SCOPE } from "./store";

interface Limit {
  ownerScope: string;
  namespace: string;
  identity: string;
  maximum: number;
  windowMs: number;
}
export function initializeRateLimits(context: HostedContext): void {
  context.db.exec(
    "CREATE TABLE IF NOT EXISTS rate_limit_windows(owner_scope TEXT NOT NULL,bucket_key TEXT NOT NULL,window_start INTEGER NOT NULL,expires_at INTEGER NOT NULL,count INTEGER NOT NULL CHECK(count>=0),PRIMARY KEY(owner_scope,bucket_key,window_start)) STRICT; CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limit_windows(expires_at)",
  );
}
function bucket(limit: Limit, context: HostedContext): string {
  return createHmac("sha256", context.config.credentialFingerprintKey)
    .update(`loopbench-rate-limit-v1\0${limit.namespace}\0${limit.identity}`)
    .digest("hex");
}
/** All windows commit together, so an exhausted secondary limit never partially burns another. */
export function consumeRateLimits(
  limits: Limit[],
  context: HostedContext,
): void {
  initializeRateLimits(context);
  withHostedTransaction(context.db, () => {
    const timestamp = now(context);
    const windows = limits.map((limit) => {
      if (
        !Number.isSafeInteger(limit.maximum) ||
        limit.maximum < 1 ||
        !Number.isSafeInteger(limit.windowMs) ||
        limit.windowMs < 1000 ||
        limit.windowMs > 86400000
      )
        throw new Error("Invalid internal rate policy");
      const start = Math.floor(timestamp / limit.windowMs) * limit.windowMs;
      const key = bucket(limit, context);
      const row = context.db
        .prepare(
          "SELECT count FROM rate_limit_windows WHERE owner_scope=? AND bucket_key=? AND window_start=?",
        )
        .get(limit.ownerScope, key, start);
      return {
        limit,
        start,
        key,
        count: row ? dbNumber(row.count) : 0,
        expiresAt: start + limit.windowMs,
      };
    });
    const exhausted = windows.filter(
      (window) => window.count >= window.limit.maximum,
    );
    if (exhausted.length)
      throw new HostedError(
        "RATE_LIMITED",
        "Too many requests. Wait before trying again.",
        429,
        true,
        {
          retryAfterMs: Math.max(
            ...exhausted.map((window) => window.expiresAt - timestamp),
          ),
        },
      );
    context.db
      .prepare("DELETE FROM rate_limit_windows WHERE expires_at<?")
      .run(timestamp - 86400000);
    for (const window of windows)
      context.db
        .prepare(
          "INSERT INTO rate_limit_windows(owner_scope,bucket_key,window_start,expires_at,count) VALUES(?,?,?,?,1) ON CONFLICT(owner_scope,bucket_key,window_start) DO UPDATE SET count=count+1",
        )
        .run(
          window.limit.ownerScope,
          window.key,
          window.start,
          window.expiresAt,
        );
  });
}
export function rateLimitSessionBootstrap(
  request: Request,
  context: HostedContext,
  env: Record<string, string | undefined> = process.env,
): void {
  requireBrowserOrigin(request, context);
  if (resolveSession(request, context)) return;
  const limits: Limit[] = [
    {
      ownerScope: PLATFORM_OWNER_SCOPE,
      namespace: "session-bootstrap-global",
      identity: "deployment",
      maximum: 100,
      windowMs: 3600000,
    },
  ];
  if (env.LOOPBENCH_TRUSTED_PROXY_HEADERS === "1") {
    const address = request.headers.get("x-forwarded-for")?.trim();
    if (!address || !isIP(address))
      throw new HostedError(
        "ORIGIN_FORBIDDEN",
        "A trusted proxy address is required.",
        403,
      );
    limits.push({
      ownerScope: PLATFORM_OWNER_SCOPE,
      namespace: "session-bootstrap-ip",
      identity: address,
      maximum: 30,
      windowMs: 3600000,
    });
  }
  consumeRateLimits(limits, context);
}
export function rateLimitCredentialConnect(
  input: { ownerScope: string; apiKey?: string },
  context: HostedContext,
): void {
  const limits: Limit[] = [
    {
      ownerScope: input.ownerScope,
      namespace: "credential-connect-session",
      identity: input.ownerScope,
      maximum: 5,
      windowMs: 900000,
    },
  ];
  if (input.apiKey) {
    const fingerprint = createHmac(
      "sha256",
      context.config.credentialFingerprintKey,
    )
      .update(input.apiKey)
      .digest("hex");
    limits.push({
      ownerScope: PLATFORM_OWNER_SCOPE,
      namespace: "credential-connect-fingerprint",
      identity: fingerprint,
      maximum: 5,
      windowMs: 900000,
    });
  }
  consumeRateLimits(limits, context);
}
export function rateLimitCatalog(
  input: { ownerScope: string; credentialId: string },
  context: HostedContext,
): void {
  const credential = context.db
    .prepare("SELECT fingerprint FROM credentials WHERE owner_scope=? AND id=?")
    .get(input.ownerScope, input.credentialId);
  if (!credential)
    throw new HostedError(
      "NOT_FOUND",
      "The requested resource was not found.",
      404,
    );
  consumeRateLimits(
    [
      {
        ownerScope: input.ownerScope,
        namespace: "catalog-session",
        identity: input.ownerScope,
        maximum: 10,
        windowMs: 900000,
      },
      {
        ownerScope: PLATFORM_OWNER_SCOPE,
        namespace: "catalog-fingerprint",
        identity: dbString(credential.fingerprint),
        maximum: 10,
        windowMs: 900000,
      },
    ],
    context,
  );
}
