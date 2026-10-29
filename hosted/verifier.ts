import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadBenchmark } from "../core/benchmarks";
import { projectRoot } from "../core/store";
import type { RemoteSandbox } from "./e2b";
import type { SubmissionArtifact } from "./task-workspaces";
import type { Benchmark } from "../core/benchmarks";

/** Only trusted case labels and fixed categories cross the verifier boundary.
 * A submitted function can put hidden arguments in an exception message. */
export function sanitizeVerifierFailure(
  raw: string | null,
  task: Benchmark["tasks"][number],
): string {
  let prefix = "Submission",
    cause = raw ?? "";
  for (const [index, item] of task.cases.entries()) {
    const label = item.label
      ? `Case: ${item.label}`
      : `Hidden check ${index + 1}`;
    if (cause.startsWith(label + ": ")) {
      prefix = label;
      cause = cause.slice(label.length + 2);
      break;
    }
  }
  const category =
    cause === "result mismatch"
      ? "result mismatch"
      : cause === "Function mutated input"
        ? "input mutation"
        : /^Script execution timed out after \d+ms$/.test(cause)
          ? "execution time limit"
          : "submission error";
  return `${prefix}: ${category}`;
}

export type VerificationResult =
  | {
      status: "passed" | "benchmark_failed";
      passed: boolean;
      error: string | null;
      graderSha256: string;
      benchmarkHash: string;
    }
  | {
      status: "infrastructure_failed";
      error: string;
      graderSha256: string;
      benchmarkHash: string;
    };
export async function verifySubmission(input: {
  remote: RemoteSandbox;
  submission: SubmissionArtifact;
  taskId: string;
  benchmarkHash: string;
  nodeVersion: string;
  benchmarkPath?: string;
}): Promise<VerificationResult> {
  const evaluator = await readFile(
    path.join(projectRoot, "benchmarks", "evaluate.mjs"),
    "utf8",
  );
  const graderSha256 = createHash("sha256").update(evaluator).digest("hex");
  const identity = { graderSha256, benchmarkHash: input.benchmarkHash };
  try {
    const benchmark = await loadBenchmark(
      input.benchmarkPath ?? "coding-adversarial-v1",
    );
    if (benchmark.hash !== input.benchmarkHash)
      throw new Error("Benchmark identity mismatch");
    const task = benchmark.tasks.find((task) => task.id === input.taskId);
    if (!task) throw new Error("Unknown verification task");
    const runtime = await input.remote.run("node --version", {
      timeoutMs: 5000,
    });
    if (runtime.exitCode !== 0 || runtime.stdout.trim() !== input.nodeVersion)
      throw new Error("Verifier Node runtime mismatch");
    await input.remote.writeFile("/opt/loopbench/evaluate.mjs", evaluator);
    await input.remote.writeFile(
      "/opt/loopbench/input.json",
      JSON.stringify({
        output: input.submission.contents,
        cases: task.cases,
        nonMutating: task.nonMutating,
      }),
    );
    const check = await input.remote.run(
      "sha256sum /opt/loopbench/evaluate.mjs",
      { timeoutMs: 5000 },
    );
    if (check.exitCode !== 0 || check.stdout.split(/\s/)[0] !== graderSha256)
      throw new Error("Verifier grader bytes mismatch");
    const result = await input.remote.run(
      "env -i PATH=/usr/local/bin:/usr/bin:/bin NODE_ENV=production node --permission --allow-fs-read=/opt/loopbench/evaluate.mjs --max-old-space-size=64 /opt/loopbench/evaluate.mjs < /opt/loopbench/input.json",
      { timeoutMs: 15_000, user: "root" },
    );
    if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) > 64_000)
      throw new Error("Verifier process failed");
    const verdict = z
      .object({ passed: z.boolean(), error: z.string().max(8000).nullable() })
      .strict()
      .parse(JSON.parse(result.stdout));
    if (
      (verdict.passed && verdict.error !== null) ||
      (!verdict.passed && verdict.error === null)
    )
      throw new Error("Invalid verifier result protocol");
    return {
      ...identity,
      status: verdict.passed ? "passed" : "benchmark_failed",
      ...verdict,
      error: verdict.passed
        ? null
        : sanitizeVerifierFailure(verdict.error, task),
    };
  } catch {
    return {
      ...identity,
      status: "infrastructure_failed",
      error: "Trusted verifier failed; no benchmark score recorded",
    };
  }
}
