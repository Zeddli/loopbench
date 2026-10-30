import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PublishedWorkspace } from "../components/hosted/PublishedWorkspace";
import { ProposalEvidence } from "../components/hosted/ProposalEvidence";
import { projectionSchema } from "../components/hosted/contracts";
import { nodeRecordSchema, type NodeRecord } from "../core/types";
import { openHostedDatabase } from "../hosted/database";
import { loadHostedConfig } from "../hosted/config";
import { publishCampaignSnapshot } from "../hosted/publication";

function task(taskId: string, passed: boolean) {
  return {
    taskId,
    passed,
    durationMs: 23,
    output: "private-submission-source",
    error: passed ? null : "private-input-and-expected-value",
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  };
}
function version() {
  return nodeRecordSchema.parse({
    id: "selected",
    treeId: "tree",
    parentId: "parent",
    hypothesis: "A measured branch",
    createdAt: "2026-10-30T01:00:00Z",
    completedAt: "2026-10-30T01:01:00Z",
    harnessHash: "fixture",
    config: {
      adapterId: "fixture",
      domain: "coding",
      model: "fixture",
      harness: "Pi",
      benchmarkId: "fixture",
      benchmarkHash: "fixture",
      settings: {},
    },
    status: "accepted",
    totalTasks: 3,
    tasks: [task("candidate-pass", true), task("candidate-fail", false)],
    score: 1 / 3,
    error: null,
    comparison: {
      parentScore: 0,
      candidateScore: 1 / 3,
      delta: 1 / 3,
      method: "paired",
      parentTasks: [
        task("parent-one", false),
        task("parent-two", false),
        task("parent-three", false),
      ],
      reason: "Measured paired comparison",
    },
  });
}
function renderPublished(nodes: NodeRecord[]) {
  const db = openHostedDatabase({ path: ":memory:" });
  try {
    const snapshot = publishCampaignSnapshot(
      {
        operationId: randomUUID(),
        reviewed: true,
        tree: {
          id: "tree",
          domain: "coding",
          model: "fixture",
          harness: "Pi",
          benchmarkId: "fixture",
          benchmarkHash: "fixture",
          totalTasks: 3,
          nodes,
          updatedAt: "2026-10-30T01:01:00Z",
        },
      },
      { db, config: loadHostedConfig({}) },
    );
    return renderToStaticMarkup(
      createElement(PublishedWorkspace, { snapshot }),
    );
  } finally {
    db.close();
  }
}

test("published full-record links reach selected task verdicts and a fresh-parent comparison", () => {
  const candidate = version();
  const html = renderPublished([
    {
      ...candidate,
      id: "parent",
      parentId: null,
      status: "baseline",
      score: 0,
      comparison: null,
      tasks: [task("baseline-only-task", false)],
    },
    candidate,
  ]);
  assert(html.includes('href="#task-results"'));
  assert(html.includes('id="task-results"'));
  assert(html.includes("2 of 3 task verdicts recorded"));
  assert(html.includes("Fresh parent evaluation"));
  assert(html.includes("3 of 3 task verdicts recorded"));
  assert(html.includes("candidate-pass"));
  assert(html.includes("candidate-fail"));
  assert(html.includes("parent-three"));
  const selectedResults = html.slice(html.indexOf('id="task-results"'));
  assert(!selectedResults.includes("baseline-only-task"));
  assert(!html.includes("private-submission-source"));
  assert(!html.includes("private-input-and-expected-value"));
  assert(!html.includes("/api/hosted/artifacts/"));
});

test("published task evidence keeps its anchor and honest empty state before any records exist", () => {
  const empty = renderPublished([]);
  assert(empty.includes('id="task-results"'));
  assert(empty.includes("No harness evaluation is selected"));
  const unstarted = renderPublished([
    {
      ...version(),
      tasks: [],
      comparison: null,
      score: null,
      status: "running",
      completedAt: null,
    },
  ]);
  assert(unstarted.includes("0 of 3 task verdicts recorded"));
  assert(unstarted.includes("No task verdicts have been recorded"));
  assert(!unstarted.includes("0 of 0"));
});

test("quarantined comparisons survive UI parsing and cannot appear as pending hypotheses", () => {
  const projection = projectionSchema.parse({
    campaign: {
      id: "campaign",
      status: "running",
      revision: 1,
      modelId: "model",
      benchmarkId: "benchmark",
      harnessId: "pi-1.4.0",
    },
    nodes: [],
    proposals: [
      {
        parentId: "parent",
        hypothesis: "Pending trial",
        nodeId: null,
        round: 2,
      },
      {
        parentId: "parent",
        hypothesis: "Parent memory failure",
        nodeId: null,
        round: 1,
        outcome: "quarantined",
        failurePhase: "parent",
        error:
          "Submission exhausted the memory allowance; comparison remains unscored.",
      },
      {
        parentId: "parent",
        hypothesis: "Candidate memory failure",
        nodeId: "executed-failed-node",
        round: 1,
        outcome: "quarantined",
        failurePhase: "candidate",
        error:
          "Submission exhausted the memory allowance; comparison remains unscored.",
      },
    ],
  });
  assert.equal(projection.proposals[1]?.outcome, "quarantined");
  const html = renderToStaticMarkup(
    createElement(ProposalEvidence, { proposals: projection.proposals }),
  );
  assert(html.includes("Saved hypotheses awaiting execution · 1"));
  assert(html.includes("Unscored failed comparisons · 2"));
  const pending = html.slice(0, html.indexOf("Unscored failed comparisons"));
  assert(!pending.includes("Parent memory failure"));
  assert(!pending.includes("Candidate memory failure"));
  assert(html.includes("parent evaluation"));
  assert(html.includes("candidate evaluation"));
  assert(html.includes("comparison remains unscored"));
  assert.equal(projection.nodes.length, 0);
  assert(!html.includes("<svg"));
});
