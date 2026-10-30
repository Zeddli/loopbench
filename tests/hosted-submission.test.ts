import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  extractSubmission,
  MissingSubmissionError,
  createSubmissionExtractorScript,
} from "../hosted/task-workspaces";
import { runTaskAttempt } from "../hosted/attempts";
import { validateHarnessArtifact } from "../hosted/harnesses";
import { loadBenchmark } from "../core/benchmarks";
import type { RemoteSandbox, SandboxRecord } from "../hosted/e2b";
import type { SandboxContext, SandboxIntent } from "../hosted/sandboxes";

async function executeExtractor(script: string, directory: string) {
  const filename = path.join(directory, "trusted-extractor.cjs");
  await writeFile(filename, script);
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [filename], {
        windowsHide: true,
        env: { NODE_ENV: "test" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) =>
        resolve({ stdout, stderr, exitCode: code ?? -1 }),
      );
    },
  );
}
function remoteForExtraction(run: RemoteSandbox["run"]): RemoteSandbox {
  return {
    id: "fixture",
    async writeFile() {},
    async readFile() {
      return "";
    },
    run,
    async start() {
      return 1;
    },
    async killProcess() {},
  };
}
test("real trusted extractor emits missing receipt only for absent leaf with validated existing ancestors", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "loopbench-missing-submission-"),
  );
  try {
    const source = path.join(directory, "src");
    await mkdir(source);
    const target = path.join(source, "solution.cjs");
    const script = createSubmissionExtractorScript({
      submissionPath: target,
      ancestors: [directory, source],
    });
    const missing = await executeExtractor(script, directory);
    assert.equal(missing.exitCode, 0);
    assert.deepEqual(JSON.parse(missing.stdout), {
      kind: "missing_submission",
    });
    await assert.rejects(
      extractSubmission({ remote: remoteForExtraction(async () => missing) }),
      MissingSubmissionError,
    );
    await rm(source, { recursive: true });
    const missingAncestor = await executeExtractor(script, directory);
    assert.notEqual(missingAncestor.exitCode, 0);
    assert.equal(missingAncestor.stdout, "");
    await assert.rejects(
      extractSubmission({
        remote: remoteForExtraction(async () => missingAncestor),
      }),
      (error) => !(error instanceof MissingSubmissionError),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("real trusted extractor refuses linked leaves and linked ancestors instead of emitting missing receipts", async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "loopbench-linked-submission-"),
  );
  try {
    const source = path.join(directory, "src");
    await mkdir(source);
    const target = path.join(source, "solution.cjs");
    try {
      await symlink(
        source,
        target,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EPERM"
      ) {
        t.skip("Host sandbox does not permit creating filesystem links");
        return;
      }
      throw error;
    }
    const linked = await executeExtractor(
      createSubmissionExtractorScript({
        submissionPath: target,
        ancestors: [directory, source],
      }),
      directory,
    );
    assert.notEqual(linked.exitCode, 0);
    assert.equal(linked.stdout, "");
    await assert.rejects(
      extractSubmission({ remote: remoteForExtraction(async () => linked) }),
      (error) => !(error instanceof MissingSubmissionError),
    );
    const linkedAncestor = await executeExtractor(
      createSubmissionExtractorScript({
        submissionPath: path.join(target, "absent.cjs"),
        ancestors: [directory, source, target],
      }),
      directory,
    );
    assert.notEqual(linkedAncestor.exitCode, 0);
    assert.equal(linkedAncestor.stdout, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("extractor rejects malformed missing receipts, nonzero exits, and controller failures as infrastructure", async () => {
  for (const stdout of [
    '{"kind":"missing_submission","unexpected":true}',
    '{"kind":"other"}',
    "not-json",
  ]) {
    await assert.rejects(
      extractSubmission({
        remote: remoteForExtraction(async () => ({
          stdout,
          stderr: "",
          exitCode: 0,
        })),
      }),
      (error) => !(error instanceof MissingSubmissionError),
    );
  }
  await assert.rejects(
    extractSubmission({
      remote: remoteForExtraction(async () => ({
        stdout: '{"kind":"missing_submission"}',
        stderr: "unexpected IO failure",
        exitCode: 1,
      })),
    }),
    (error) => !(error instanceof MissingSubmissionError),
  );
  await assert.rejects(
    extractSubmission({
      remote: remoteForExtraction(async () => {
        throw new TypeError("fetch failed");
      }),
    }),
    (error) => !(error instanceof MissingSubmissionError),
  );
});
async function missingAttempt(
  mode: "success" | "call_limit" | "provider_error" | "incomplete",
) {
  const benchmark = await loadBenchmark("coding-adversarial-v1");
  const digest = async (filename: string) =>
    createHash("sha256")
      .update(await readFile(path.join("sandbox", "pi", filename)))
      .digest("hex");
  const harness = validateHarnessArtifact({
    schemaVersion: 1,
    systemPrompt: "Follow the task contract",
    skills: [],
    tools: "read-write-edit-bash",
    verificationPolicy: "public-smoke",
    compaction: { enabled: false, reserveTokens: 4096, keepRecentTokens: 8192 },
    runtime: {
      piVersion: "1.4.0",
      nodeVersion: "v24.15.0",
      templateId: "fixture-template",
      verifierTemplateId: "fixture-template",
      supervisorSha256: await digest("supervisor.mjs"),
      toolDefinitionsSha256: await digest("request-identity.mjs"),
    },
  });
  const frames = [
    { type: "response", command: "prompt", success: true },
    { type: "agent_start" },
    {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: mode === "success" ? "stop" : "error",
      },
    },
    ...(mode === "incomplete"
      ? []
      : [{ type: "agent_settled", aborted: false }]),
    { type: "supervisor_end", exitCode: mode === "incomplete" ? 1 : 0 },
  ];
  const log = frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n";
  const intents = new Map<string, SandboxIntent>(),
    records = new Map<string, SandboxRecord>();
  const artifacts: { kind: string; contents: string }[] = [],
    events: string[] = [],
    roles: string[] = [];
  let extractions = 0,
    confirmations = 0,
    revocations = 0;
  const remote = remoteForExtraction(async (command) => {
    if (command.includes("agent-confined"))
      return { stdout: "agent-confined", stderr: "", exitCode: 0 };
    if (command.includes("sudo -n"))
      return { stdout: "", stderr: "denied", exitCode: 1 };
    if (command.includes("head -c"))
      return { stdout: log, stderr: "", exitCode: 0 };
    if (command.includes("result.json"))
      return { stdout: JSON.stringify(frames.at(-1)), stderr: "", exitCode: 0 };
    if (command === "node /opt/loopbench/extract.cjs") {
      extractions++;
      return {
        stdout: '{"kind":"missing_submission"}',
        stderr: "",
        exitCode: 0,
      };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  });
  const sandboxes: SandboxContext = {
    transport: {
      async create(input) {
        roles.push(input.role);
        const record: SandboxRecord = {
          id: input.metadata.intentId,
          templateId: input.templateId,
          metadata: input.metadata,
          state: "running",
          endAt: "2026-10-28T00:10:00.000Z",
          connection: { envdVersion: "0.10.0", envdAccessToken: "test-only" },
        };
        records.set(record.id, record);
        return record;
      },
      async inspect(id) {
        return records.get(id) ?? null;
      },
      async list() {
        return [...records.values()];
      },
      async connect() {
        return remote;
      },
      async terminate(id) {
        records.delete(id);
      },
    },
    async prepare(input) {
      const intent: SandboxIntent = {
        ...input,
        status: "prepared",
        sandboxId: null,
      };
      intents.set(intent.id, intent);
      return intent;
    },
    async get(id) {
      const intent = intents.get(id);
      if (!intent) throw new Error("Not admitted");
      return intent;
    },
    async claim(id) {
      const intent = await sandboxes.get(id);
      if (intent.status !== "prepared") return false;
      intent.status = "creating";
      return true;
    },
    async update(id, status, sandboxId) {
      const intent = await sandboxes.get(id);
      intent.status = status;
      if (sandboxId) intent.sandboxId = sandboxId;
    },
    async confirmTerminated(id) {
      confirmations++;
      await sandboxes.update(id, "terminated");
    },
    async assertFence() {},
  };
  const result = await runTaskAttempt(
    {
      attemptId: "attempt",
      ownerScope: "owner",
      campaignId: "campaign",
      taskId: "json-pointer-patch",
      benchmarkHash: benchmark.hash,
      harness,
      model: { id: "test-only", contextWindow: 32768, maxTokens: 4096 },
      gatewayOrigin: "https://gateway.example.invalid",
      agentIntentId: "agent",
      verifierIntentId: "verifier",
    },
    {
      sandboxes,
      async grant() {
        return {
          token: "test-only-scoped-token",
          async revoke() {
            revocations++;
          },
        };
      },
      async event(type) {
        events.push(type);
      },
      async saveArtifact(kind, contents) {
        artifacts.push({ kind, contents });
        return kind;
      },
      async assertFence() {},
      async scopedCallLimitConfirmed() {
        return mode === "call_limit";
      },
      async completedProviderCallsConfirmed() {
        return mode === "success";
      },
    },
  );
  return {
    result,
    artifacts,
    events,
    roles,
    extractions,
    confirmations,
    revocations,
    records,
  };
}
test("missing canonical submission after eligible settlement is a trusted benchmark rejection with no verifier or fabricated code", async () => {
  for (const mode of ["success", "call_limit"] satisfies (
    "success" | "call_limit"
  )[]) {
    const run = await missingAttempt(mode);
    assert.equal(run.result.status, "benchmark_failed");
    assert.equal(run.result.failureCode, "MISSING_SUBMISSION");
    assert.equal(run.result.submissionHash, null);
    assert.equal(run.result.cleanupPending, false);
    assert.deepEqual(run.roles, ["agent"]);
    assert.equal(run.extractions, 1);
    assert.equal(run.confirmations, 1);
    assert.equal(run.records.size, 0);
    assert.equal(run.revocations, 1);
    assert.ok(
      run.artifacts.some(
        (artifact) => artifact.kind === "submission-rejection",
      ),
    );
    assert.ok(run.events.includes("attempt_submission_rejected"));
    assert.ok(
      !run.artifacts.some((artifact) =>
        ["submission", "verifier-result"].includes(artifact.kind),
      ),
    );
  }
});
test("provider errors and incomplete settlement cannot become missing-submission benchmark failures", async () => {
  for (const mode of ["provider_error", "incomplete"] satisfies (
    "provider_error" | "incomplete"
  )[]) {
    const run = await missingAttempt(mode);
    assert.equal(run.result.status, "infrastructure_failed");
    assert.equal(run.extractions, 0);
    assert.equal(run.result.submissionHash, null);
    assert.equal(run.result.cleanupPending, false);
    assert.equal(run.records.size, 0);
    assert.ok(
      !run.artifacts.some(
        (artifact) => artifact.kind === "submission-rejection",
      ),
    );
    assert.ok(!run.events.includes("attempt_submission_rejected"));
  }
});
