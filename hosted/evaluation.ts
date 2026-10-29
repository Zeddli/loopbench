import { createHash } from "node:crypto";
import { loadBenchmark } from "../core/benchmarks";
import type { TaskAttemptResult } from "./attempts";

export interface ComparisonContext {
  schemaVersion: 1;
  benchmarkHash: string;
  taskIds: string[];
  modelId: string;
  templateId: string;
  verifierTemplateId: string;
  piVersion: string;
  nodeVersion: string;
  graderSha256: string;
  networkPolicyHash: string;
  hardwarePolicyHash: string;
  hash: string;
}
export interface VersionEvaluation {
  versionId: string;
  contextHash: string;
  comparisonId: string;
  role: "baseline" | "parent" | "candidate";
  taskIds: string[];
  attempts: TaskAttemptResult[];
  status: "complete" | "incomplete" | "failed";
  passed: number;
  total: number;
  score: number | null;
}
export function buildComparisonContext(
  input: Omit<ComparisonContext, "schemaVersion" | "hash">,
): ComparisonContext {
  if (
    new Set(input.taskIds).size !== input.taskIds.length ||
    input.taskIds.length < 1 ||
    input.taskIds.length > 6
  )
    throw new Error("Invalid comparison task set");
  const canonical = {
    schemaVersion: 1,
    benchmarkHash: input.benchmarkHash,
    taskIds: [...input.taskIds],
    modelId: input.modelId,
    templateId: input.templateId,
    verifierTemplateId: input.verifierTemplateId,
    piVersion: input.piVersion,
    nodeVersion: input.nodeVersion,
    graderSha256: input.graderSha256,
    networkPolicyHash: input.networkPolicyHash,
    hardwarePolicyHash: input.hardwarePolicyHash,
  };
  return {
    ...canonical,
    schemaVersion: 1,
    hash: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
  };
}
export async function evaluateVersion(
  input: {
    versionId: string;
    comparisonId: string;
    role: VersionEvaluation["role"];
    context: ComparisonContext;
    fullSuite: boolean;
    benchmarkPath?: string;
  },
  context: {
    executeTask(taskId: string): Promise<TaskAttemptResult>;
    checkpoint(evaluation: VersionEvaluation): Promise<void>;
  },
): Promise<VersionEvaluation> {
  const benchmark = await loadBenchmark(
    input.benchmarkPath ?? "coding-adversarial-v1",
  );
  if (benchmark.hash !== input.context.benchmarkHash)
    throw new Error("Evaluation benchmark mismatch");
  const canonical = benchmark.tasks.map((task) => task.id);
  if (
    input.context.taskIds.some((id) => !canonical.includes(id)) ||
    (input.fullSuite &&
      (input.context.taskIds.length !== 6 ||
        canonical.some((id) => !input.context.taskIds.includes(id))))
  )
    throw new Error("Full-suite evaluation requires all six original tasks");
  const evaluation: VersionEvaluation = {
    versionId: input.versionId,
    comparisonId: input.comparisonId,
    role: input.role,
    contextHash: input.context.hash,
    taskIds: [...input.context.taskIds],
    attempts: [],
    status: "incomplete",
    passed: 0,
    total: input.context.taskIds.length,
    score: null,
  };
  for (const taskId of input.context.taskIds) {
    const attempt = await context.executeTask(taskId);
    evaluation.attempts.push(attempt);
    if (attempt.status === "passed") evaluation.passed++;
    if (attempt.status === "infrastructure_failed" || attempt.cleanupPending) {
      evaluation.status = "failed";
      await context.checkpoint(evaluation);
      return evaluation;
    }
    await context.checkpoint(evaluation);
  }
  evaluation.status = "complete";
  evaluation.score = evaluation.passed / evaluation.total;
  await context.checkpoint(evaluation);
  return evaluation;
}
