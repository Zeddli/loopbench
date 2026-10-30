import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadBenchmark } from "../core/benchmarks";
import { projectRoot } from "../core/store";
import type { RemoteSandbox } from "./e2b";
import type { SubmissionArtifact } from "./task-workspaces";
import type { Benchmark } from "../core/benchmarks";
import {
  TokenSandboxHttpError,
  TokenSandboxProcessError,
} from "./tokenfactory-client";

export const legacyVerifierOutcomePolicy = "trusted-verifier-infrastructure-v1";
export const verifierOutcomePolicy = "trusted-resource-quarantine-v2";
export const verifierOutcomePolicySchema = z.enum([
  legacyVerifierOutcomePolicy,
  verifierOutcomePolicy,
]);
export const trustedResourceReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    outcome: z.literal("candidate_resource_exhausted"),
    policy: z.literal(verifierOutcomePolicy),
    attemptId: z.string().min(1),
    submissionHash: z.string().regex(/^[a-f0-9]{64}$/),
    benchmarkHash: z.string().regex(/^[a-f0-9]{64}$/),
    graderSha256: z.string().regex(/^[a-f0-9]{64}$/),
    nodeVersion: z.string(),
    healthyBefore: z.literal(true),
    healthyAfter: z.literal(true),
    processExitCode: z.literal(134),
    processFailure: z.literal("heap_exhausted"),
  })
  .strict();

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

type VerificationStage =
  | "runtime"
  | "prepare_grader"
  | "prepare_input"
  | "integrity"
  | "execution"
  | "decode";
type ResourceExhaustion = Omit<
  z.infer<typeof trustedResourceReceiptSchema>,
  "attemptId"
>;
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
      diagnostic: {
        stage: VerificationStage;
        adapterCode?: string;
        httpStatus?: number;
        processExitCode?: number;
        processSignal?: number;
        processFailure?:
          | "nonzero_exit"
          | "output_limit"
          | "heap_exhausted"
          | "permission_denied"
          | "unsupported_option"
          | "module_unavailable"
          | TokenSandboxProcessError["processFailure"];
      };
      resourceExhaustion?: ResourceExhaustion;
    };
export async function verifySubmission(input: {
  remote: RemoteSandbox;
  submission: SubmissionArtifact;
  taskId: string;
  benchmarkHash: string;
  nodeVersion: string;
  benchmarkPath?: string;
  outcomePolicy?: z.infer<typeof verifierOutcomePolicySchema>;
}): Promise<VerificationResult> {
  const identity = { graderSha256: "", benchmarkHash: input.benchmarkHash };
  let stage: VerificationStage = "prepare_grader";
  let processExitCode: number | undefined;
  let processFailure: Extract<
    VerificationResult,
    { status: "infrastructure_failed" }
  >["diagnostic"]["processFailure"];
  let healthyBefore = false;
  const graderCommand = (inputPath: string) =>
    `env -i PATH=/usr/local/bin:/usr/bin:/bin NODE_ENV=production node --permission --allow-fs-read=/opt/loopbench/evaluate.mjs --max-old-space-size=64 /opt/loopbench/evaluate.mjs < ${inputPath}`;
  async function healthyControl() {
    const result = await input.remote.run(
      graderCommand("/opt/loopbench/verifier-control.json"),
      { timeoutMs: 15000, user: "root" },
    );
    if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) > 64000)
      return false;
    return z
      .object({ passed: z.literal(true), error: z.null() })
      .strict()
      .safeParse(JSON.parse(result.stdout)).success;
  }
  try {
    const evaluator = await readFile(
      path.join(projectRoot, "benchmarks", "evaluate.mjs"),
      "utf8",
    );
    const graderSha256 = createHash("sha256").update(evaluator).digest("hex");
    identity.graderSha256 = graderSha256;
    stage = "integrity";
    const benchmark = await loadBenchmark(
      input.benchmarkPath ?? "coding-adversarial-v1",
    );
    if (benchmark.hash !== input.benchmarkHash)
      throw new Error("Benchmark identity mismatch");
    const task = benchmark.tasks.find((task) => task.id === input.taskId);
    if (!task) throw new Error("Unknown verification task");
    stage = "runtime";
    const runtime = await input.remote.run("node --version", {
      timeoutMs: 5000,
    });
    if (runtime.exitCode !== 0 || runtime.stdout.trim() !== input.nodeVersion)
      throw new Error("Verifier Node runtime mismatch");
    stage = "prepare_grader";
    await input.remote.writeFile("/opt/loopbench/evaluate.mjs", evaluator);
    stage = "prepare_input";
    await input.remote.writeFile(
      "/opt/loopbench/input.json",
      JSON.stringify({
        output: input.submission.contents,
        cases: task.cases,
        nonMutating: task.nonMutating,
      }),
    );
    stage = "integrity";
    const check = await input.remote.run(
      "sha256sum /opt/loopbench/evaluate.mjs",
      { timeoutMs: 5000 },
    );
    if (check.exitCode !== 0 || check.stdout.split(/\s/)[0] !== graderSha256)
      throw new Error("Verifier grader bytes mismatch");
    if (input.outcomePolicy === verifierOutcomePolicy) {
      await input.remote.writeFile(
        "/opt/loopbench/verifier-control.json",
        JSON.stringify({
          output: "module.exports = function(){ return null; };",
          cases: [{ args: [], expected: null }],
          nonMutating: false,
        }),
      );
      healthyBefore = await healthyControl();
      if (!healthyBefore) throw Error("Trusted verifier preflight failed");
    }
    stage = "execution";
    const result = await input.remote.run(
      graderCommand("/opt/loopbench/input.json"),
      { timeoutMs: 15_000, user: "root" },
    );
    processExitCode = result.exitCode;
    if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) > 64_000) {
      // Match fixed runtime failure signatures without retaining their text.
      processFailure =
        result.exitCode === 0
          ? "output_limit"
          : /FATAL ERROR:.*(?:heap|allocation).*memory|Reached heap limit|JavaScript heap out of memory/i.test(
                result.stderr,
              )
            ? "heap_exhausted"
            : /ERR_ACCESS_DENIED|Permission denied/.test(result.stderr)
              ? "permission_denied"
              : /node: bad option:/.test(result.stderr)
                ? "unsupported_option"
                : /Cannot find module|ERR_MODULE_NOT_FOUND/.test(result.stderr)
                  ? "module_unavailable"
                  : "nonzero_exit";
      throw new Error("Verifier process failed");
    }
    stage = "decode";
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
  } catch (error) {
    const observedExitCode =
      error instanceof TokenSandboxProcessError
        ? error.processExitCode
        : processExitCode;
    const observedFailure =
      error instanceof TokenSandboxProcessError
        ? error.processFailure
        : processFailure;
    if (
      input.outcomePolicy === verifierOutcomePolicy &&
      stage === "execution" &&
      healthyBefore &&
      observedExitCode === 134 &&
      observedFailure === "heap_exhausted"
    ) {
      try {
        if (await healthyControl()) {
          const resourceExhaustion: ResourceExhaustion = {
            schemaVersion: 1,
            outcome: "candidate_resource_exhausted",
            policy: verifierOutcomePolicy,
            submissionHash: input.submission.sha256,
            benchmarkHash: input.benchmarkHash,
            graderSha256: identity.graderSha256,
            nodeVersion: input.nodeVersion,
            healthyBefore: true,
            healthyAfter: true,
            processExitCode: 134,
            processFailure: "heap_exhausted",
          };
          return {
            ...identity,
            status: "infrastructure_failed",
            error:
              "Submission exhausted the memory allowance; comparison remains unscored.",
            diagnostic: {
              stage: "execution",
              processExitCode: 134,
              processFailure: "heap_exhausted",
            },
            resourceExhaustion,
          };
        }
      } catch {
        /* An unhealthy verifier cannot authenticate a candidate resource outcome. */
      }
    }
    // Never persist exception messages, stdout, stderr or parser input here.
    const adapterCode =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string" &&
      [
        "EAGAIN",
        "EPIPE",
        "ENOENT",
        "EACCES",
        "ECONNRESET",
        "ETIMEDOUT",
      ].includes(error.code)
        ? error.code
        : undefined;
    return {
      ...identity,
      status: "infrastructure_failed",
      error: "Trusted verifier failed; no benchmark score recorded",
      diagnostic: {
        stage,
        ...(adapterCode ? { adapterCode } : {}),
        ...(error instanceof TokenSandboxHttpError
          ? { httpStatus: error.httpStatus }
          : {}),
        ...(error instanceof TokenSandboxProcessError
          ? {
              processExitCode: error.processExitCode,
              processFailure: error.processFailure,
              ...(error.processSignal === undefined
                ? {}
                : { processSignal: error.processSignal }),
            }
          : {
              ...(processExitCode === undefined ? {} : { processExitCode }),
              ...(processFailure ? { processFailure } : {}),
            }),
      },
    };
  }
}
