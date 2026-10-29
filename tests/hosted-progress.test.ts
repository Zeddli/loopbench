import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PublishedProgress } from "../components/hosted/PublishedProgress";
import { PublishedWorkspace } from "../components/hosted/PublishedWorkspace";
import { nodeRecordSchema } from "../core/types";

test("parent reruns expose verified tasks and the current sibling before a graph node exists", () => {
  const html = renderToStaticMarkup(
    createElement(PublishedProgress, {
      execution: {
        status: "running",
        waitReason: null,
        observedAt: "2026-10-29T01:00:00Z",
        phase: "parent",
        round: 1,
        level: 0,
        tasksCompleted: 2,
        taskTotal: 6,
        proposalIndex: 0,
        proposalCount: 6,
      },
      totalTasks: 6,
      scoredVersions: 1,
      following: true,
    }),
  );
  assert.match(html, /Verifying the parent before sibling 1 of 6/);
  assert.match(html, /<progress[^>]*value="2"[^>]*max="6"/);
  assert.match(html, /2 of 6 tasks verified/);
  assert.match(html, /saved baseline stays unchanged/);
  assert(!html.includes("16.7%"));
});

test("candidate activity uses actual curriculum task totals and completed sibling index", () => {
  const html = renderToStaticMarkup(
    createElement(PublishedProgress, {
      execution: {
        status: "running",
        waitReason: null,
        observedAt: "2026-10-29T01:00:00Z",
        phase: "candidate",
        round: 3,
        level: 2,
        tasksCompleted: 7,
        taskTotal: 18,
        proposalIndex: 2,
        proposalCount: 4,
      },
      totalTasks: 6,
      scoredVersions: 9,
      following: true,
    }),
  );
  assert.match(html, /Evaluating sibling 3 of 4/);
  assert.match(html, /<progress[^>]*value="7"[^>]*max="18"/);
  assert.match(html, /7 of 18 tasks verified/);
});

test("waiting checkpoints retain measured progress without claiming active execution", () => {
  const html = renderToStaticMarkup(
    createElement(PublishedProgress, {
      execution: {
        status: "waiting",
        waitReason: "inference_budget",
        observedAt: "2026-10-29T01:00:00Z",
        phase: "parent",
        round: 1,
        tasksCompleted: 3,
        taskTotal: 6,
        proposalIndex: 0,
        proposalCount: 2,
      },
      totalTasks: 6,
      scoredVersions: 1,
      following: false,
    }),
  );
  assert.match(html, /Waiting/);
  assert.match(html, /inference budget/);
  assert.match(html, /3 of 6 tasks verified/);
  assert(!html.includes("Live ·"));
});

test("public progress excludes unscored failures even when they have completion timestamps", () => {
  const baseline = nodeRecordSchema.parse({
    id: "baseline",
    treeId: "tree",
    parentId: null,
    hypothesis: "Baseline",
    createdAt: "2026-10-29T01:00:00Z",
    completedAt: "2026-10-29T01:01:00Z",
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
    status: "baseline",
    totalTasks: 6,
    tasks: [],
    score: 0,
    comparison: null,
    error: null,
  });
  const html = renderToStaticMarkup(
    createElement(PublishedWorkspace, {
      snapshot: {
        id: "snapshot",
        source: "hosted_published",
        campaignId: "campaign",
        publishedAt: Date.parse("2026-10-29T01:02:00Z"),
        sha256: "fixture",
        tree: {
          id: "tree",
          domain: "coding",
          model: "fixture",
          harness: "Pi",
          benchmarkId: "fixture",
          benchmarkHash: "fixture",
          totalTasks: 6,
          updatedAt: "2026-10-29T01:02:00Z",
          nodes: [
            baseline,
            {
              ...baseline,
              id: "unscored-failure",
              parentId: baseline.id,
              status: "failed",
              score: null,
              error: "Infrastructure failed",
            },
          ],
          execution: {
            status: "running",
            waitReason: null,
            observedAt: "2026-10-29T01:02:00Z",
            phase: "parent",
            tasksCompleted: 0,
            taskTotal: 6,
          },
        },
      },
    }),
  );
  assert.match(html, /<dt>Scored evaluations<\/dt><dd>1<\/dd>/);
});
