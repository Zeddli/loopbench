import { strict as assert } from "node:assert";
import { test } from "node:test";
import { openHostedDatabase } from "../hosted/database";
import { loadHostedConfig } from "../hosted/config";
import {
  importSelectedArchive,
  listPublishedSnapshots,
  getPublishedSnapshot,
  getLatestPublishedSnapshot,
  publishCampaignSnapshot,
} from "../hosted/publication";

test("public archive contains only explicitly reviewed immutable snapshots", () => {
  const db = openHostedDatabase({ path: ":memory:" });
  const context = { db, config: loadHostedConfig({}) };
  try {
    assert.deepEqual(listPublishedSnapshots(context), []);
    assert.throws(() =>
      importSelectedArchive(
        {
          source: "legacy-local",
          reviewed: false,
          tree: {},
          operationId: "bad",
        },
        context,
      ),
    );
    assert.equal(getPublishedSnapshot("unknown", context), null);
  } finally {
    db.close();
  }
});

test("latest lookup starts from a published snapshot and cannot select private campaigns", () => {
  const db = openHostedDatabase({ path: ":memory:" }),
    context = { db, config: loadHostedConfig({}) };
  try {
    assert.equal(
      getLatestPublishedSnapshot("unknown-private-campaign", context),
      null,
    );
  } finally {
    db.close();
  }
});

test("same-campaign public follow retains immutable history and updated execution state", () => {
  const db = openHostedDatabase({ path: ":memory:" }),
    context = { db, config: loadHostedConfig({}) };
  try {
    const tree = {
      id: "public-tree",
      domain: "coding",
      model: "measured-model",
      harness: "Pi",
      benchmarkId: "test",
      benchmarkHash: "test-hash",
      totalTasks: 1,
      nodes: [],
      updatedAt: "2026-10-28T09:00:00Z",
    };
    const first = publishCampaignSnapshot(
      {
        tree,
        reviewed: true,
        operationId: randomUUID(),
        campaignId: "published-a",
      },
      context,
    );
    const latest = publishCampaignSnapshot(
      {
        tree: {
          ...tree,
          execution: {
            status: "waiting",
            waitReason: "compute_budget",
            observedAt: "2026-10-28T09:01:00Z",
          },
        },
        reviewed: true,
        operationId: randomUUID(),
        campaignId: "published-a",
      },
      context,
    );
    publishCampaignSnapshot(
      {
        tree,
        reviewed: true,
        operationId: randomUUID(),
        campaignId: "published-b",
      },
      context,
    );
    assert.equal(getLatestPublishedSnapshot(first.id, context)?.id, latest.id);
    assert.equal(
      getLatestPublishedSnapshot(first.id, context)?.tree.execution?.waitReason,
      "compute_budget",
    );
    assert.equal(
      getPublishedSnapshot(first.id, context)?.tree.execution,
      undefined,
    );
    assert.equal(getPublishedSnapshot(first.id, context)?.sha256, first.sha256);
  } finally {
    db.close();
  }
});
import { randomUUID } from "node:crypto";
import {
  publicationProgress,
  publishedTreeSchema,
} from "../hosted/publication-schema";
import { nodeRecordSchema } from "../core/types";

test("published progress changes for fresh-parent task progress without leaking private checkpoint fields", () => {
  const first = publicationProgress(
    {
      status: "running",
      waitReason: null,
      checkpoint: {
        phase: "parent",
        round: 1,
        level: 2,
        taskIndex: 1,
        proposalIndex: 0,
        privateToken: "never-publish",
      },
    },
    6,
    18,
  );
  const next = publicationProgress(
    {
      status: "running",
      waitReason: null,
      checkpoint: {
        phase: "parent",
        round: 1,
        level: 2,
        taskIndex: 2,
        proposalIndex: 0,
        privateToken: "never-publish",
      },
    },
    6,
    18,
  );
  assert.notEqual(JSON.stringify(first), JSON.stringify(next));
  assert.equal(next.tasksCompleted, 2);
  assert.equal(next.proposalCount, 6);
  assert.equal(next.level, 2);
  assert.equal(next.taskTotal, 18);
  const serialized = publishedTreeSchema.shape.execution.parse({
    ...next,
    observedAt: "2026-10-29T01:00:00Z",
  });
  assert.equal(serialized?.level, 2);
  assert.equal(serialized?.taskTotal, 18);
  assert(!JSON.stringify(next).includes("never-publish"));
  assert(!("privateToken" in next));
});

test("reviewed snapshot excludes raw task output and is immutable without changing source", () => {
  const db = openHostedDatabase({ path: ":memory:" });
  const context = { db, config: loadHostedConfig({}) };
  const node = nodeRecordSchema.parse({
    id: "node-real-source",
    treeId: "historical-tree",
    parentId: null,
    hypothesis: "Historical baseline",
    createdAt: "2026-10-27T00:00:00Z",
    completedAt: "2026-10-27T00:01:00Z",
    harnessHash: "historical-digest",
    config: {
      adapterId: "local-codex",
      domain: "coding",
      model: "historical-model",
      harness: "historical-harness",
      benchmarkId: "historical-suite",
      benchmarkHash: "historical-suite-hash",
      settings: { instructions: "private configuration" },
      benchmarkPath: "D:/private/internal.json",
    },
    status: "baseline",
    totalTasks: 1,
    tasks: [
      {
        taskId: "one",
        passed: true,
        durationMs: 1,
        output: "private raw output",
        error: null,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
      },
    ],
    score: 1,
    comparison: null,
    error: null,
  });
  const tree = {
    id: node.treeId,
    domain: "coding",
    model: node.config.model,
    harness: node.config.harness,
    benchmarkId: node.config.benchmarkId,
    benchmarkHash: node.config.benchmarkHash,
    totalTasks: 1,
    nodes: [node],
    updatedAt: node.completedAt,
  };
  const sourceBytes = JSON.stringify(tree);
  const operationId = randomUUID();
  try {
    const snapshot = importSelectedArchive(
      { source: "legacy-local", reviewed: true, tree, operationId },
      context,
    );
    assert.equal(JSON.stringify(tree), sourceBytes);
    assert(!JSON.stringify(snapshot).includes("private raw output"));
    assert(!JSON.stringify(snapshot).includes("D:/private"));
    assert(!JSON.stringify(snapshot).includes("private configuration"));
    assert.equal(
      getPublishedSnapshot(snapshot.id, context)?.source,
      "local_archive",
    );
    assert.equal(
      importSelectedArchive(
        { source: "legacy-local", reviewed: true, tree, operationId },
        context,
      ).id,
      snapshot.id,
    );
    assert.throws(
      () =>
        importSelectedArchive(
          {
            source: "legacy-local",
            reviewed: true,
            tree: { ...tree, model: "different-model" },
            operationId,
          },
          context,
        ),
      /cannot be overwritten/,
    );
  } finally {
    db.close();
  }
});
