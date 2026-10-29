import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { type TreeSummary } from "@/core/types";
import { publishedTreeSchema as treeSchema } from "./publication-schema";
import {
  dbNumber,
  dbString,
  HostedError,
  now,
  type HostedContext,
} from "./schema";

export interface PublishedSnapshot {
  id: string;
  source: "local_archive" | "hosted_published";
  campaignId: string | null;
  publishedAt: number;
  sha256: string;
  tree: z.infer<typeof treeSchema>;
}
function ensurePublications(context: HostedContext) {
  context.db.exec(
    "CREATE TABLE IF NOT EXISTS hosted_publications(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,source TEXT NOT NULL,campaign_id TEXT,published_at INTEGER NOT NULL,sha256 TEXT NOT NULL,tree_json TEXT NOT NULL) STRICT;",
  );
}
function fromRow(row: Record<string, unknown>): PublishedSnapshot {
  const source = z
    .enum(["local_archive", "hosted_published"])
    .parse(row.source);
  return {
    id: dbString(row.id),
    source,
    campaignId: row.campaign_id === null ? null : dbString(row.campaign_id),
    publishedAt: dbNumber(row.published_at),
    sha256: dbString(row.sha256),
    tree: treeSchema.parse(JSON.parse(dbString(row.tree_json))),
  };
}
/** Publication is an operator-reviewed, immutable allowlisted copy. It never updates the source. */
export function publishCampaignSnapshot(
  input: {
    tree: unknown;
    reviewed: boolean;
    operationId: string;
    campaignId?: string;
    source?: "local_archive" | "hosted_published";
  },
  context: HostedContext,
): PublishedSnapshot {
  ensurePublications(context);
  if (input.reviewed !== true)
    throw new HostedError(
      "PUBLICATION_REVIEW_REQUIRED",
      "Publication requires an explicit review.",
      422,
    );
  const operationId = z.uuid().parse(input.operationId);
  const tree = treeSchema.parse(input.tree);
  // Explicit allowlist excludes settings, raw output and raw diagnostics from publication.
  const safeTree: z.infer<typeof treeSchema> = {
    ...tree,
    nodes: tree.nodes.map((node) => ({
      ...node,
      config: { ...node.config, settings: {}, benchmarkPath: undefined },
      tasks: node.tasks.map((task) => ({
        ...task,
        output: "",
        error: task.error ? "Task failed. Private diagnostics excluded." : null,
      })),
      comparison: node.comparison
        ? {
            ...node.comparison,
            parentTasks: node.comparison.parentTasks.map((task) => ({
              ...task,
              output: "",
              error: task.error
                ? "Task failed. Private diagnostics excluded."
                : null,
            })),
          }
        : null,
      error: node.error
        ? "Execution failed. Private diagnostics excluded."
        : null,
    })),
  };
  const serialized = JSON.stringify(safeTree);
  if (
    Buffer.byteLength(serialized) > 4_194_304 ||
    /(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+\S{8,}|-----BEGIN .*PRIVATE KEY)/i.test(
      serialized,
    )
  )
    throw new HostedError(
      "PUBLICATION_REDACTION",
      "The snapshot failed the publication check.",
      422,
    );
  const sha256 = createHash("sha256").update(serialized).digest("hex");
  const prior = context.db
    .prepare("SELECT * FROM hosted_publications WHERE operation_id=?")
    .get(operationId);
  if (prior) {
    if (
      prior.sha256 !== sha256 ||
      prior.campaign_id !== (input.campaignId ?? null) ||
      prior.source !== (input.source ?? "hosted_published")
    )
      throw new HostedError(
        "IDEMPOTENCY_CONFLICT",
        "A published snapshot cannot be overwritten.",
        409,
      );
    return fromRow(prior);
  }
  const id = randomUUID();
  const publishedAt = now(context);
  const source = input.source ?? "hosted_published";
  context.db
    .prepare(
      "INSERT INTO hosted_publications(id,operation_id,source,campaign_id,published_at,sha256,tree_json) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      id,
      operationId,
      source,
      input.campaignId ?? null,
      publishedAt,
      sha256,
      serialized,
    );
  return {
    id,
    source,
    campaignId: input.campaignId ?? null,
    publishedAt,
    sha256,
    tree: safeTree,
  };
}
export function importSelectedArchive(
  input: {
    tree: unknown;
    reviewed: boolean;
    operationId: string;
    source: "legacy-local";
  },
  context: HostedContext,
): PublishedSnapshot {
  return publishCampaignSnapshot(
    { ...input, source: "local_archive" },
    context,
  );
}
export function listPublishedSnapshots(
  context: HostedContext,
): PublishedSnapshot[] {
  ensurePublications(context);
  const snapshots = context.db
    .prepare(
      "SELECT * FROM hosted_publications ORDER BY published_at DESC,id LIMIT 100",
    )
    .all()
    .map(fromRow);
  const seen = new Set<string>();
  return snapshots.filter((snapshot) => {
    if (!snapshot.campaignId) return true;
    if (seen.has(snapshot.campaignId)) return false;
    seen.add(snapshot.campaignId);
    return true;
  });
}
export function getPublishedSnapshot(
  id: string,
  context: HostedContext,
): PublishedSnapshot | null {
  ensurePublications(context);
  const row = context.db
    .prepare("SELECT * FROM hosted_publications WHERE id=?")
    .get(id);
  return row ? fromRow(row) : null;
}

/** Only already-published copies are eligible. This never reads live private records. */
export function getLatestPublishedSnapshot(
  id: string,
  context: HostedContext,
): PublishedSnapshot | null {
  const seed = getPublishedSnapshot(id, context);
  if (!seed || seed.source !== "hosted_published" || !seed.campaignId)
    return seed;
  const row = context.db
    .prepare(
      "SELECT * FROM hosted_publications WHERE source='hosted_published' AND campaign_id=? ORDER BY published_at DESC,rowid DESC LIMIT 1",
    )
    .get(seed.campaignId);
  return row ? fromRow(row) : seed;
}
