import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { campaignSchema, nodeRecordSchema } from "../core/types";

const origin = "http://127.0.0.1:3000";
const treeId = process.argv[2] ?? "bb13cb4c6dc76d23df68";
if (!/^[a-zA-Z0-9-]{1,100}$/.test(treeId)) throw new Error("Invalid tree ID");
async function read(path: string) {
  const response = await fetch(origin + path, {
    signal: AbortSignal.timeout(30000),
    cache: "no-store",
  });
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
  return response;
}
const [
  treeResponse,
  campaignsResponse,
  homeResponse,
  detailResponse,
  historicalResponse,
] = await Promise.all([
  read(`/api/trees/${treeId}`),
  read("/api/campaigns"),
  read("/"),
  read(`/tree/${treeId}`),
  read("/tree/fa5449a6a8b22fd1f85f"),
]);
const tree = z
  .object({ id: z.string(), nodes: z.array(nodeRecordSchema) })
  .parse(await treeResponse.json());
const campaigns = z.array(campaignSchema).parse(await campaignsResponse.json());
const current = campaigns.find(
  (campaign) => campaign.options.continuous && campaign.lineageId === tree.id,
);
assert.ok(
  current,
  "The continuous campaign must remain in the existing measured tree",
);
assert.ok(current.callsUsed <= current.maxCalls);
assert.equal(current.callsUsed, current.calls.length);
assert.notEqual(
  current.status,
  "completed",
  "Continuous search must checkpoint rather than complete at a fixed generation",
);
const home = await homeResponse.text();
assert.ok(
  home.includes("Active evolution"),
  "The homepage should prioritize the current continuous search",
);
const detail = await detailResponse.text();
assert.ok(
  detail.includes("Fit all"),
  "The deep graph should expose fit-to-view controls",
);
assert.ok(detail.toLowerCase().includes("continuous"));
const historical = await historicalResponse.text();
assert.ok(historical.includes("Historical benchmark revision"));
assert.ok(
  historical.includes(`/tree/${tree.id}`),
  "Historical pages should link to the active lineage",
);
const ids = new Set(tree.nodes.map((node) => node.id));
const childCounts = new Map<string, number>();
for (const node of tree.nodes)
  if (node.parentId) {
    assert.ok(ids.has(node.parentId), "Measured ancestry must be retained");
    childCounts.set(node.parentId, (childCounts.get(node.parentId) || 0) + 1);
  }
const proposalRounds = [
  ...new Set(current.proposals.map((proposal) => proposal.round)),
];
assert.ok(
  proposalRounds.length > 0,
  "The actual model must have proposed sibling experiments",
);
for (const round of proposalRounds) {
  const siblings: typeof current.proposals = current.proposals.filter(
    (proposal) => proposal.round === round,
  );
  assert.ok(siblings.length >= 2 && siblings.length <= 6);
  assert.equal(new Set(siblings.map((proposal) => proposal.parentId)).size, 1);
  assert.equal(
    new Set(siblings.map((proposal) => proposal.instructions)).size,
    siblings.length,
  );
  for (const proposal of siblings)
    if (proposal.nodeId) assert.ok(ids.has(proposal.nodeId));
}
assert.ok(
  [...childCounts.values()].some((count) => count >= 2),
  "The displayed real lineage must have competing children",
);
const challenges = tree.nodes.filter((node) => node.event === "challenge");
assert.ok(
  challenges.length > 0,
  "A mastered suite should already have advanced to a real challenge checkpoint",
);
for (const node of challenges) {
  assert.equal(
    node.comparison,
    null,
    "Challenge checkpoints must not claim paired improvements",
  );
  assert.notEqual(node.status, "accepted");
  const parent = tree.nodes.find((candidate) => candidate.id === node.parentId);
  assert.ok(parent);
  assert.equal(
    node.harnessHash,
    parent.harnessHash,
    "Challenge checkpoints must preserve the harness",
  );
  assert.notEqual(node.config.benchmarkHash, parent.config.benchmarkHash);
}
const result = {
  checkedAt: new Date().toISOString(),
  treeId: tree.id,
  campaignId: current.id,
  status: current.status,
  callsUsed: current.callsUsed,
  maxCalls: current.maxCalls,
  nodes: tree.nodes.length,
  branchPoints: [...childCounts.values()].filter((count) => count >= 2).length,
  recordedSiblingWidths: proposalRounds.map(
    (round) =>
      current.proposals.filter((proposal) => proposal.round === round).length,
  ),
  completeEvaluations: tree.nodes.filter(
    (node) => node.status !== "failed" && node.status !== "running",
  ).length,
  failedOrInterruptedEvaluations: tree.nodes.filter(
    (node) => node.status === "failed",
  ).length,
  challengeCheckpoints: challenges.length,
  curriculumLevel: current.curriculum?.level,
  checks: [
    "live tree API",
    "live campaign API",
    "continuous homepage",
    "deep graph controls",
    "historical redirect link",
    "retained ancestry",
    "actual 2–6 distinct same-parent sibling proposals",
    "actual branching lineage",
    "unchanged-harness challenge provenance",
  ],
};
await mkdir("artifacts", { recursive: true });
await writeFile(
  "artifacts/live-verification.json",
  JSON.stringify(result, null, 2),
);
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
