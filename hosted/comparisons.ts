import type { ComparisonContext, VersionEvaluation } from "./evaluation";
export { buildComparisonContext } from "./evaluation";
export type VersionVerdict =
  | {
      status: "accepted" | "rejected";
      delta: number;
      reason: "improved" | "tie" | "regressed";
    }
  | {
      status: "failed";
      delta: null;
      reason: "incomplete_evidence" | "context_mismatch" | "parent_not_fresh";
    };
export function decidePairedVerdict(
  parent: VersionEvaluation,
  candidate: VersionEvaluation,
  comparisonContext: ComparisonContext,
): VersionVerdict {
  if (
    parent.role !== "parent" ||
    candidate.role !== "candidate" ||
    parent.comparisonId !== candidate.comparisonId ||
    parent.versionId === candidate.versionId
  )
    return { status: "failed", delta: null, reason: "parent_not_fresh" };
  if (
    parent.contextHash !== comparisonContext.hash ||
    candidate.contextHash !== comparisonContext.hash ||
    JSON.stringify(parent.taskIds) !==
      JSON.stringify(comparisonContext.taskIds) ||
    JSON.stringify(candidate.taskIds) !==
      JSON.stringify(comparisonContext.taskIds)
  )
    return { status: "failed", delta: null, reason: "context_mismatch" };
  if (
    [parent, candidate].some(
      (row) =>
        row.status !== "complete" ||
        row.score === null ||
        row.total !== comparisonContext.taskIds.length ||
        row.passed !==
          row.attempts.filter((attempt) => attempt.status === "passed")
            .length ||
        row.attempts.length !== comparisonContext.taskIds.length ||
        row.attempts.some(
          (attempt) => attempt.status === "infrastructure_failed",
        ) ||
        new Set(row.attempts.map((attempt) => attempt.taskId)).size !==
          row.taskIds.length ||
        row.taskIds.some(
          (taskId) =>
            !row.attempts.some((attempt) => attempt.taskId === taskId),
        ),
    )
  )
    return { status: "failed", delta: null, reason: "incomplete_evidence" };
  const delta =
    candidate.passed / candidate.total - parent.passed / parent.total;
  return {
    status: delta > 0 ? "accepted" : "rejected",
    delta,
    reason: delta > 0 ? "improved" : delta === 0 ? "tie" : "regressed",
  };
}
