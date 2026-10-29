import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  dbNumber,
  dbString,
  HostedError,
  now,
  type HostedContext,
} from "./schema";
import { getCampaign } from "./store";

export function ensureArtifacts(context: HostedContext): void {
  context.db.exec(
    `CREATE TABLE IF NOT EXISTS hosted_artifacts(id TEXT PRIMARY KEY,owner_scope TEXT NOT NULL,campaign_id TEXT NOT NULL,kind TEXT NOT NULL,visibility TEXT NOT NULL CHECK(visibility IN ('owner','internal_only')),state TEXT NOT NULL,contents BLOB NOT NULL,byte_length INTEGER NOT NULL,sha256 TEXT NOT NULL,created_at INTEGER NOT NULL,FOREIGN KEY(owner_scope,campaign_id) REFERENCES campaigns(owner_scope,id)) STRICT;`,
  );
}
export interface ArtifactMetadata {
  id: string;
  campaignId: string;
  kind: string;
  state: "ready";
  byteLength: number;
  sha256: string;
  createdAt: number;
  downloadUrl: string;
}
function metadata(row: Record<string, unknown>): ArtifactMetadata {
  return {
    id: dbString(row.id),
    campaignId: dbString(row.campaign_id),
    kind: dbString(row.kind),
    state: "ready",
    byteLength: dbNumber(row.byte_length),
    sha256: dbString(row.sha256),
    createdAt: dbNumber(row.created_at),
    downloadUrl: `/api/hosted/artifacts/${dbString(row.id)}`,
  };
}
/** Internal service accepts bytes, never filesystem paths supplied by a browser. */
export function saveArtifact(
  input: {
    ownerScope: string;
    campaignId: string;
    kind: string;
    contents: string | Uint8Array;
    visibility: "owner" | "internal_only";
  },
  context: HostedContext,
): ArtifactMetadata {
  ensureArtifacts(context);
  if (!getCampaign(input, context))
    throw new HostedError(
      "NOT_FOUND",
      "The requested resource was not found.",
      404,
    );
  const kind = z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,63}$/)
    .parse(input.kind);
  const contents = Buffer.from(input.contents);
  if (contents.length > 1_048_576)
    throw new HostedError(
      "ARTIFACT_TOO_LARGE",
      "The artifact exceeds the evidence size limit.",
      422,
    );
  // Raw verifier diagnostics are never authorized through a browser session.
  if (
    input.visibility === "owner" &&
    /hidden|expected|verifier[_-]raw|verifier[_-]log|pi[_-]events|credential|gateway/.test(
      kind,
    )
  )
    throw new HostedError(
      "ARTIFACT_VISIBILITY",
      "This evidence must remain internal.",
      422,
    );
  const id = randomUUID();
  const createdAt = now(context);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  context.db
    .prepare(
      "INSERT INTO hosted_artifacts(id,owner_scope,campaign_id,kind,visibility,state,contents,byte_length,sha256,created_at) VALUES(?,?,?,?,?,'ready',?,?,?,?)",
    )
    .run(
      id,
      input.ownerScope,
      input.campaignId,
      kind,
      input.visibility,
      contents,
      contents.length,
      sha256,
      createdAt,
    );
  return {
    id,
    campaignId: input.campaignId,
    kind,
    state: "ready",
    byteLength: contents.length,
    sha256,
    createdAt,
    downloadUrl: `/api/hosted/artifacts/${id}`,
  };
}
export function listArtifacts(
  input: { ownerScope: string; campaignId: string },
  context: HostedContext,
): ArtifactMetadata[] {
  ensureArtifacts(context);
  return context.db
    .prepare(
      "SELECT id,campaign_id,kind,byte_length,sha256,created_at FROM hosted_artifacts WHERE owner_scope=? AND campaign_id=? AND visibility='owner' AND state='ready' ORDER BY created_at DESC LIMIT 100",
    )
    .all(input.ownerScope, input.campaignId)
    .map(metadata);
}
export function getArtifact(
  input: { ownerScope: string; artifactId: string },
  context: HostedContext,
): { metadata: ArtifactMetadata; contents: Uint8Array } | null {
  ensureArtifacts(context);
  const row = context.db
    .prepare(
      "SELECT * FROM hosted_artifacts WHERE owner_scope=? AND id=? AND visibility='owner' AND state='ready'",
    )
    .get(input.ownerScope, input.artifactId);
  if (!row) return null;
  if (!(row.contents instanceof Uint8Array))
    throw new HostedError(
      "ARTIFACT_UNAVAILABLE",
      "The artifact is unavailable.",
      409,
    );
  return { metadata: metadata(row), contents: row.contents };
}
