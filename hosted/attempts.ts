import { createHash } from "node:crypto";
import type { HarnessArtifact } from "./harnesses";
import {
  createAttemptSandbox,
  terminateOwnedSandbox,
  type SandboxContext,
  type SandboxHandle,
} from "./sandboxes";
import {
  buildTaskWorkspace,
  extractSubmission,
  MissingSubmissionError,
  canonicalSubmissionPolicy,
} from "./task-workspaces";
import { startPi, collectPiExecution, type PiModel } from "./pi";
import { verifySubmission, type verifierOutcomePolicySchema } from "./verifier";
import type { z } from "zod";
import {
  canGradeSettledCallLimit,
  canGradeSettledOutputLimit,
} from "./pi-events";
import { HostedError } from "./schema";
import { AmbiguousSandboxCreateError } from "./e2b";

export interface TaskAttemptInput {
  attemptId: string;
  ownerScope: string;
  campaignId: string;
  taskId: string;
  benchmarkHash: string;
  benchmarkPath?: string;
  harness: HarnessArtifact;
  model: PiModel;
  gatewayOrigin: string;
  agentIntentId: string;
  verifierIntentId: string;
  verifierOutcomePolicy?: z.infer<typeof verifierOutcomePolicySchema>;
}
export interface TaskAttemptResult {
  attemptId: string;
  taskId: string;
  status: "passed" | "benchmark_failed" | "infrastructure_failed";
  error: string | null;
  failureCode?: string;
  terminationReason?:
    "agent_completed" | "attempt_call_limit" | "output_token_limit";
  submissionHash: string | null;
  artifacts: string[];
  cleanupPending: boolean;
}
export interface TaskAttemptContext {
  sandboxes: SandboxContext;
  grant(): Promise<{ token: string; revoke(): Promise<void> }>;
  event(type: string, payload: Record<string, unknown>): Promise<void>;
  saveArtifact(kind: string, contents: string, sha256: string): Promise<string>;
  assertFence(): Promise<void>;
  /** Durable worker heartbeat/cancellation checkpoint. Default polling only delays locally. */
  poll?(): Promise<void>;
  scopedCallLimitConfirmed?(): Promise<boolean>;
  /** Authenticated gateway settlement for this attempt. Omission fails closed. */
  completedProviderCallsConfirmed?(): Promise<boolean>;
}
export async function runTaskAttempt(
  input: TaskAttemptInput,
  context: TaskAttemptContext,
): Promise<TaskAttemptResult> {
  const result: TaskAttemptResult = {
    attemptId: input.attemptId,
    taskId: input.taskId,
    status: "infrastructure_failed",
    error: null,
    submissionHash: null,
    artifacts: [],
    cleanupPending: false,
  };
  const handles: SandboxHandle[] = [];
  let extractionInProgress = false;
  let grant: Awaited<ReturnType<TaskAttemptContext["grant"]>> | undefined;
  async function artifact(kind: string, contents: string) {
    const digest = createHash("sha256").update(contents).digest("hex");
    result.artifacts.push(await context.saveArtifact(kind, contents, digest));
  }
  const base = {
    ownerScope: input.ownerScope,
    campaignId: input.campaignId,
    attemptId: input.attemptId,
    gatewayOrigin: input.gatewayOrigin,
    ttlSeconds: 600,
  };
  try {
    await context.assertFence();
    const workspace = await buildTaskWorkspace({
      benchmarkHash: input.benchmarkHash,
      taskId: input.taskId,
      benchmarkPath: input.benchmarkPath,
    });
    await context.event("attempt_preparing", {
      attemptId: input.attemptId,
      taskId: input.taskId,
      workspaceHash: workspace.hash,
    });
    const agent = await createAttemptSandbox(
      {
        ...base,
        id: input.agentIntentId,
        role: "agent",
        templateId: input.harness.runtime.templateId,
      },
      context.sandboxes,
    );
    handles.push(agent);
    await context.assertFence();
    grant = await context.grant();
    const execution = await startPi({
      remote: agent.remote,
      workspace,
      harness: input.harness,
      model: input.model,
      gatewayOrigin: input.gatewayOrigin,
      gatewayToken: grant.token,
    });
    await context.event("attempt_running", {
      attemptId: input.attemptId,
      sandboxId: agent.record.id,
    });
    let collected = await collectPiExecution(execution);
    const deadline = Date.now() + 510_000;
    let emitted = 0;
    while (!collected.complete) {
      await context.assertFence();
      if (Date.now() > deadline)
        throw new Error("Pi supervision deadline exceeded");
      if (collected.state.events > emitted) {
        emitted = collected.state.events;
        await context.event("attempt_progress", {
          attemptId: input.attemptId,
          eventCount: emitted,
          toolCalls: collected.state.toolCalls,
        });
      }
      await (context.poll
        ? context.poll()
        : new Promise<void>((resolve) => setTimeout(resolve, 1000)));
      collected = await collectPiExecution(execution);
    }
    await grant.revoke();
    grant = undefined;
    await artifact("pi-events", collected.log);
    const bounded = canGradeSettledCallLimit(
      collected.state,
      (await context.scopedCallLimitConfirmed?.()) ?? false,
    );
    const completedProviderCalls =
      (await context.completedProviderCallsConfirmed?.()) ?? false;
    const outputBounded = canGradeSettledOutputLimit(
      collected.state,
      completedProviderCalls,
    );
    result.terminationReason = outputBounded
      ? "output_token_limit"
      : bounded
        ? "attempt_call_limit"
        : "agent_completed";
    if (!collected.success && !bounded && !outputBounded) {
      result.failureCode = !collected.state.started
        ? "RUNTIME_INVALID"
        : "PI_EXECUTION_FAILED";
      throw new Error("Pi did not finish with successful settled execution");
    }
    // Pi can receive a usable final answer before the provider's terminal usage
    // frame arrives. Local settlement alone does not prove the gateway outcome.
    if (collected.success && !completedProviderCalls)
      throw new HostedError(
        "RECONCILIATION_REQUIRED",
        "Provider calls require confirmed completion before benchmark verification.",
        503,
      );
    const frozen = await agent.remote.run(
      "pkill -KILL -u user || test $? -eq 1",
      { user: "root", timeoutMs: 5000 },
    );
    if (frozen.exitCode !== 0)
      throw new Error("Could not stop agent processes before extraction");
    extractionInProgress = true;
    const submission = await extractSubmission({ remote: agent.remote });
    extractionInProgress = false;
    result.submissionHash = submission.sha256;
    await artifact("submission", submission.contents);
    // A clean verifier consumes another global slot. Release agent only on confirmed absence.
    const agentStopped = await terminateOwnedSandbox(agent, context.sandboxes);
    if (!agentStopped) throw new Error("Agent cleanup remains uncertain");
    handles.splice(handles.indexOf(agent), 1);
    await context.assertFence();
    await context.event("attempt_verifying", {
      attemptId: input.attemptId,
      submissionHash: submission.sha256,
    });
    const verifier = await createAttemptSandbox(
      {
        ...base,
        id: input.verifierIntentId,
        role: "verifier",
        templateId: input.harness.runtime.verifierTemplateId,
      },
      context.sandboxes,
    );
    handles.push(verifier);
    const verdict = await verifySubmission({
      remote: verifier.remote,
      submission,
      taskId: input.taskId,
      benchmarkHash: input.benchmarkHash,
      benchmarkPath: input.benchmarkPath,
      nodeVersion: input.harness.runtime.nodeVersion,
      outcomePolicy: input.verifierOutcomePolicy,
    });
    if (verdict.status === "infrastructure_failed") {
      const { diagnostic, resourceExhaustion, ...ownerVerdict } = verdict;
      await artifact("verifier-result", JSON.stringify(ownerVerdict));
      await artifact(
        "platform-diagnostic",
        JSON.stringify({
          attemptId: input.attemptId,
          source: "trusted_verifier",
          ...diagnostic,
        }),
      );
      if (resourceExhaustion)
        await artifact(
          "trusted-resource-result",
          JSON.stringify({ ...resourceExhaustion, attemptId: input.attemptId }),
        );
    } else {
      await artifact("verifier-result", JSON.stringify(verdict));
    }
    await context.assertFence();
    result.status = verdict.status;
    result.error = verdict.error;
    if (verdict.status === "infrastructure_failed")
      result.failureCode = verdict.resourceExhaustion
        ? "CANDIDATE_RESOURCE_EXHAUSTED"
        : "VERIFIER_FAILED";
    await context.event("attempt_result", {
      attemptId: input.attemptId,
      status: result.status,
      submissionHash: submission.sha256,
      graderSha256: verdict.graderSha256,
    });
  } catch (error) {
    if (extractionInProgress && error instanceof MissingSubmissionError) {
      await context.assertFence();
      const rejection = {
        schemaVersion: 1,
        attemptId: input.attemptId,
        taskId: input.taskId,
        reason: error.reason,
        policy: canonicalSubmissionPolicy,
        source: "trusted_canonical_extractor",
        verifierRun: false,
      };
      await artifact("submission-rejection", JSON.stringify(rejection));
      await context.event("attempt_submission_rejected", {
        ...rejection,
        status: "benchmark_failed",
      });
      result.status = "benchmark_failed";
      result.failureCode = "MISSING_SUBMISSION";
      result.error = error.message;
    } else {
      try {
        let diagnostic =
          error instanceof Error ? error.message : "Unknown execution failure";
        if (grant)
          diagnostic = diagnostic.split(grant.token).join("[redacted]");
        for (const [key, value] of Object.entries(process.env))
          if (
            /key|token|secret|password/i.test(key) &&
            value &&
            value.length >= 8
          )
            diagnostic = diagnostic.split(value).join("[redacted]");
        await artifact(
          "platform-diagnostic",
          JSON.stringify({
            attemptId: input.attemptId,
            message: diagnostic.slice(0, 4000),
          }),
        );
      } catch {
        /* Diagnostic storage never replaces the original execution outcome. */
      }
      result.status = "infrastructure_failed";
      result.failureCode =
        error instanceof HostedError
          ? error.code
          : error instanceof AmbiguousSandboxCreateError
            ? "SANDBOX_OUTCOME_UNKNOWN"
            : (result.failureCode ?? "EXECUTION_FAILED");
      result.error =
        error instanceof HostedError
          ? error.message
          : "Task attempt could not complete trusted execution";
    }
  } finally {
    if (grant) {
      try {
        await grant.revoke();
      } catch {
        result.cleanupPending = true;
      }
    }
    for (const handle of handles) {
      try {
        if (!(await terminateOwnedSandbox(handle, context.sandboxes)))
          result.cleanupPending = true;
      } catch {
        result.cleanupPending = true;
      }
    }
    // Uncertain creation intents have no handle, but remain reserved in the durable store.
    for (const id of [input.agentIntentId, input.verifierIntentId]) {
      try {
        const intent = await context.sandboxes.get(id);
        if (intent.status !== "terminated" && intent.status !== "prepared")
          result.cleanupPending = true;
      } catch {
        /* The phase may not have admitted an intent. */
      }
    }
  }
  await context.assertFence();
  return result;
}
