import assert from "node:assert/strict";
import test from "node:test";
import type { NodeRecord } from "../core/types";
import {
  ancestryOf,
  layoutLineage,
  lineageSummary,
  benchmarkGroups,
  isImprovement,
  nodeLabel,
} from "../components/lineage";

test("only competing children classify a record as branching evolution", () => {
  assert.equal(
    lineageSummary([version("failed", null, "failed")]).kind,
    "Failed run",
  );
  assert.equal(
    lineageSummary([version("baseline", null, "baseline")]).kind,
    "Baseline only",
  );
  const linear = [version("root", null, "baseline"), version("child", "root")];
  assert.equal(lineageSummary(linear).kind, "Single-branch experiment");
  const branching = [
    ...linear,
    version("alternative", "root", "rejected"),
    version("next", "child"),
  ];
  assert.deepEqual(lineageSummary(branching), {
    kind: "Branching evolution",
    branchPoints: 1,
    branches: 2,
    depth: 2,
  });
  assert.deepEqual(
    [...ancestryOf(branching, "next")],
    ["next", "child", "root"],
  );
});

function version(
  id: string,
  parentId: string | null,
  status: NodeRecord["status"] = "accepted",
): NodeRecord {
  return {
    id,
    parentId,
    status,
    treeId: "layout-test",
    hypothesis: id,
    createdAt: "2026-10-27T00:00:00Z",
    completedAt: null,
    harnessHash: id,
    config: {
      adapterId: "test",
      domain: "coding",
      model: "test",
      harness: "test",
      benchmarkId: "test",
      benchmarkHash: "test",
      settings: {},
    },
    totalTasks: 1,
    tasks: [],
    score: null,
    comparison: null,
    error: null,
  };
}

test("lineage includes every generation at readable horizontal spacing", () => {
  const nodes = Array.from({ length: 50 }, (_, index) =>
    version(`v${index}`, index ? `v${index - 1}` : null),
  );
  const { points, width } = layoutLineage(nodes);
  assert.equal(points.size, nodes.length);
  for (let index = 1; index < nodes.length; index++) {
    const current = points.get(`v${index}`);
    const previous = points.get(`v${index - 1}`);
    assert.ok(current && previous);
    assert.equal(current.x - previous.x, 420);
  }
  assert.ok(width > 20000, "large trees scroll instead of scaling labels down");
});

test("parent centres over branches with an accepted child between failures", () => {
  const nodes = [
    version("root", null, "baseline"),
    version("pass", "root"),
    version("fail-a", "root", "rejected"),
    version("fail-b", "root", "failed"),
  ];
  const { points, height } = layoutLineage(nodes);
  const root = points.get("root");
  const pass = points.get("pass");
  const a = points.get("fail-a");
  const b = points.get("fail-b");
  assert.ok(root && pass && a && b);
  assert.ok(a.y < pass.y && pass.y < b.y);
  assert.equal(root.y, (a.y + b.y) / 2);
  assert.ok(height >= 620);
});

test("disconnected roots and legacy cyclic records remain visible", () => {
  const nodes = [
    version("root", null),
    version("orphan", "missing"),
    version("cycle-a", "cycle-b"),
    version("cycle-b", "cycle-a"),
  ];
  const { points } = layoutLineage(nodes);
  assert.equal(points.size, nodes.length);
  assert.ok(
    [...points.values()].every(
      (point) => Number.isFinite(point.x) && Number.isFinite(point.y),
    ),
  );
});

test("curriculum keeps deep wide history and groups identical tests separately", () => {
  const nodes = [version("root", null, "baseline")];
  let head = "root";
  for (let depth = 1; depth <= 18; depth++) {
    const level = Math.floor(depth / 6);
    const hash = `benchmark-${level}`;
    for (let branch = 0; branch < 5; branch++) {
      const node = version(
        `depth-${depth}-branch-${branch}`,
        head,
        branch ? "rejected" : "accepted",
      );
      node.config.benchmarkHash = hash;
      node.config.benchmarkId = hash;
      node.curriculum = { level, benchmarkHash: hash, benchmarkId: hash };
      node.totalTasks = 6 + level * 4;
      nodes.push(node);
    }
    head = `depth-${depth}-branch-0`;
  }
  const layout = layoutLineage(nodes);
  assert.equal(layout.points.size, 91);
  assert.equal(layout.points.get(head)?.depth, 18);
  assert.ok(layout.height > 6000);
  assert.ok(layout.width > 7500);
  const groups = benchmarkGroups(nodes);
  assert.equal(groups.length, 5);
  assert.ok(
    groups.every((group) =>
      group.nodes.every((node) => node.config.benchmarkHash === group.hash),
    ),
  );
  assert.equal(groups.at(-1)?.totalTasks, 18);
});

test("challenge checkpoint is a new baseline, never an accepted improvement or competing proposal", () => {
  const root = version("root", null, "baseline");
  const accepted = version("accepted", "root");
  accepted.comparison = {
    parentScore: 0.5,
    candidateScore: 1,
    delta: 0.5,
    method: "paired",
    parentTasks: [],
    reason: "Improved",
  };
  const challenge = version("harder", "root", "baseline");
  challenge.harnessHash = root.harnessHash;
  challenge.event = "challenge";
  challenge.curriculum = {
    level: 1,
    benchmarkHash: "harder",
    benchmarkId: "harder",
  };
  challenge.config.benchmarkHash = "harder";
  challenge.totalTasks = 12;
  assert.equal(isImprovement(accepted), true);
  assert.equal(isImprovement(challenge), false);
  challenge.status = "accepted";
  challenge.comparison = accepted.comparison;
  assert.equal(
    isImprovement(challenge),
    false,
    "a challenge never counts as a learned upgrade, even in legacy records marked accepted",
  );
  assert.equal(nodeLabel(challenge), "Level 1 challenge");
  assert.equal(challenge.harnessHash, root.harnessHash, "the challenge re-evaluates the same harness fingerprint");
  assert.equal(lineageSummary([root, accepted, challenge]).branchPoints, 0);
  assert.equal(benchmarkGroups([root, accepted, challenge]).length, 2);
});
