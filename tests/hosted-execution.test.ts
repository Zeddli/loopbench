import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createE2BTransport,
  AmbiguousSandboxCreateError,
  type E2BTransport,
  type RemoteSandbox,
  type SandboxRecord,
} from "../hosted/e2b";
import {
  createAttemptSandbox,
  reconcileSandboxIntent,
  terminateOwnedSandbox,
  type SandboxContext,
  type SandboxIntent,
} from "../hosted/sandboxes";
import { loadBenchmark } from "../core/benchmarks";
import {
  curriculumOracle,
  curriculumTaskIdSchema,
} from "../core/curriculum-oracles";
import {
  buildTaskWorkspace,
  extractSubmission,
} from "../hosted/task-workspaces";
import {
  hashHarnessArtifact,
  validateHarnessArtifact,
} from "../hosted/harnesses";
import {
  initialPiRunState,
  parsePiEvent,
  reducePiEvent,
  replayPiLog,
  piExecutionSucceeded,
  canGradeSettledCallLimit,
  canGradeSettledOutputLimit,
} from "../hosted/pi-events";
import {
  buildComparisonContext,
  evaluateVersion,
  type VersionEvaluation,
} from "../hosted/evaluation";
import { decidePairedVerdict } from "../hosted/comparisons";
import { verifySubmission, sanitizeVerifierFailure } from "../hosted/verifier";

test("verifier diagnostics cannot return hidden inputs through submitted exception messages", async () => {
  const benchmark = await loadBenchmark("coding-adversarial-v1");
  const task = benchmark.tasks[0],
    label = task.cases[0].label;
  assert.ok(label);
  const sentinel = "PRIVATE-HIDDEN-INPUT-SENTINEL";
  const sanitized = sanitizeVerifierFailure(
    `Case: ${label}: ${sentinel}`,
    task,
  );
  assert.equal(sanitized, `Case: ${label}: submission error`);
  assert.ok(!sanitized.includes(sentinel));
  assert.equal(
    sanitizeVerifierFailure(`Case: ${label}: result mismatch`, task),
    `Case: ${label}: result mismatch`,
  );
  assert.equal(
    sanitizeVerifierFailure(sentinel, task),
    "Submission: submission error",
  );
});
import { runTaskAttempt } from "../hosted/attempts";
import { HostedError } from "../hosted/schema";
import { fixture } from "./hosted-foundation-fixture";
import { getBudgetSummary } from "../hosted/budget";
import { initializeEvolution } from "../hosted/evolution";
import { enqueueJob, claimJob } from "../hosted/jobs";
import { makeSandboxContext } from "../hosted/runtime-sandboxes";

const remote: RemoteSandbox = {
  id: "sandbox-one",
  async readFile() {
    return "";
  },
  async writeFile() {},
  async run() {
    return { stdout: "", stderr: "", exitCode: 0 };
  },
  async start() {
    return 1;
  },
  async killProcess() {},
};
function simulator() {
  const intents = new Map<string, SandboxIntent>();
  const records = new Map<string, SandboxRecord>();
  let creates = 0;
  let loseCreate = false;
  let failKill = false;
  const transport: E2BTransport = {
    async create(input) {
      creates++;
      const row: SandboxRecord = {
        id: `sandbox-${creates}`,
        templateId: input.templateId,
        metadata: input.metadata,
        state: "running",
        endAt: "2026-10-28T00:10:00.000Z",
        connection: {
          envdVersion: "0.4.0",
          envdAccessToken: "controller-secret",
        },
      };
      records.set(row.id, row);
      if (loseCreate) throw new AmbiguousSandboxCreateError();
      return row;
    },
    async list(metadata) {
      return [...records.values()].filter((row) =>
        Object.entries(metadata).every(
          ([key, value]) => row.metadata[key] === value,
        ),
      );
    },
    async inspect(id) {
      return records.get(id) ?? null;
    },
    async connect() {
      return remote;
    },
    async terminate(id) {
      if (failKill) throw new Error("lost kill response");
      records.delete(id);
    },
  };
  const context: SandboxContext = {
    transport,
    async prepare(input) {
      const old = intents.get(input.id);
      if (old) return old;
      if (
        [...intents.values()].filter((row) => row.status !== "terminated")
          .length >= 2
      )
        throw new Error("Global sandbox slots full");
      const intent: SandboxIntent = {
        ...input,
        status: "prepared",
        sandboxId: null,
      };
      intents.set(input.id, intent);
      return intent;
    },
    async get(id) {
      const intent = intents.get(id);
      if (!intent) throw new Error("No intent");
      return intent;
    },
    async claim(id) {
      const intent = intents.get(id);
      if (!intent || intent.status !== "prepared") return false;
      intents.set(id, { ...intent, status: "creating" });
      return true;
    },
    async update(id, status, sandboxId) {
      const intent = await context.get(id);
      intents.set(id, {
        ...intent,
        status,
        sandboxId: sandboxId ?? intent.sandboxId,
      });
    },
    async confirmTerminated(id) {
      await context.update(id, "terminated");
    },
    async assertFence() {},
  };
  const input = {
    id: "intent-1",
    ownerScope: "owner",
    campaignId: "campaign",
    attemptId: "attempt",
    role: "agent" as const,
    templateId: "pinned",
    gatewayOrigin: "https://gateway.example.invalid",
    ttlSeconds: 600,
  };
  return {
    context,
    input,
    records,
    intents,
    creates: () => creates,
    loseCreate: () => {
      loseCreate = true;
    },
    failKill: () => {
      failKill = true;
    },
  };
}
test("accepted create with lost response is discovered once without a new POST", async () => {
  const sim = simulator();
  sim.loseCreate();
  await assert.rejects(
    createAttemptSandbox(sim.input, sim.context),
    AmbiguousSandboxCreateError,
  );
  assert.equal((await sim.context.get(sim.input.id)).status, "unknown");
  const recovered = await reconcileSandboxIntent(sim.input.id, sim.context);
  assert.ok(recovered);
  await createAttemptSandbox(sim.input, sim.context);
  assert.equal(sim.creates(), 1);
});
test("two workers cannot create the same intent; verifier consumes global slots", async () => {
  const sim = simulator();
  const results = await Promise.allSettled([
    createAttemptSandbox(sim.input, sim.context),
    createAttemptSandbox(sim.input, sim.context),
  ]);
  assert.equal(results.filter((row) => row.status === "fulfilled").length, 1);
  assert.equal(sim.creates(), 1);
  await createAttemptSandbox(
    { ...sim.input, id: "intent-2", role: "verifier" },
    sim.context,
  );
  await assert.rejects(
    createAttemptSandbox({ ...sim.input, id: "intent-3" }, sim.context),
    /slots/,
  );
});
test("failed kill retains obligation; unowned sandbox is never killed", async () => {
  const sim = simulator();
  const handle = await createAttemptSandbox(sim.input, sim.context);
  sim.failKill();
  await assert.rejects(terminateOwnedSandbox(handle, sim.context));
  assert.equal((await sim.context.get(sim.input.id)).status, "running");
  const row = sim.records.get(handle.record.id);
  assert.ok(row);
  row.metadata.ownerScope = "foreign";
  await assert.rejects(terminateOwnedSandbox(handle, sim.context), /unowned/);
  assert.equal(sim.records.size, 1);
});
test("owned cleanup retries a transient first inspection without recreating a sandbox", async () => {
  const sim = simulator();
  const handle = await createAttemptSandbox(sim.input, sim.context);
  const inspect = sim.context.transport.inspect;
  let inspections = 0;
  sim.context.transport.inspect = async (id) => {
    if (++inspections === 1) throw new TypeError("fetch failed");
    return inspect(id);
  };
  assert.equal(await terminateOwnedSandbox(handle, sim.context), true);
  assert.equal(inspections, 3);
  assert.equal(sim.creates(), 1);
  assert.equal((await sim.context.get(sim.input.id)).status, "terminated");
});
test("owned cleanup reconciles accepted kill with a lost response before any second kill", async () => {
  const sim = simulator();
  const handle = await createAttemptSandbox(sim.input, sim.context);
  const terminate = sim.context.transport.terminate;
  let kills = 0;
  sim.context.transport.terminate = async (id) => {
    kills++;
    await terminate(id);
    throw new TypeError("fetch failed");
  };
  assert.equal(await terminateOwnedSandbox(handle, sim.context), true);
  assert.equal(kills, 1);
  assert.equal(sim.creates(), 1);
  assert.equal((await sim.context.get(sim.input.id)).status, "terminated");
});
test("owned cleanup retries an unaccepted transient kill and confirms absence once", async () => {
  const sim = simulator();
  const handle = await createAttemptSandbox(sim.input, sim.context);
  const terminate = sim.context.transport.terminate;
  let kills = 0,
    confirmations = 0;
  sim.context.transport.terminate = async (id) => {
    if (++kills === 1) throw new TypeError("fetch failed");
    await terminate(id);
  };
  const confirm = sim.context.confirmTerminated;
  sim.context.confirmTerminated = async (id) => {
    confirmations++;
    await confirm(id);
  };
  assert.equal(await terminateOwnedSandbox(handle, sim.context), true);
  assert.equal(kills, 2);
  assert.equal(confirmations, 1);
  assert.equal(sim.creates(), 1);
});
test("owned cleanup recovers a lost post-kill inspection without issuing another kill", async () => {
  const sim = simulator();
  const handle = await createAttemptSandbox(sim.input, sim.context);
  const inspect = sim.context.transport.inspect;
  const terminate = sim.context.transport.terminate;
  let inspections = 0,
    kills = 0;
  sim.context.transport.inspect = async (id) => {
    if (++inspections === 2) throw new TypeError("fetch failed");
    return inspect(id);
  };
  sim.context.transport.terminate = async (id) => {
    kills++;
    await terminate(id);
  };
  assert.equal(await terminateOwnedSandbox(handle, sim.context), true);
  assert.equal(inspections, 3);
  assert.equal(kills, 1);
});
test("owned cleanup does not retry accounting or lease errors after confirmed absence", async () => {
  const sim = simulator();
  const handle = await createAttemptSandbox(sim.input, sim.context);
  let confirmations = 0;
  sim.context.confirmTerminated = async () => {
    confirmations++;
    throw new HostedError(
      "STALE_LEASE",
      "Worker lease is no longer current",
      409,
    );
  };
  await assert.rejects(
    terminateOwnedSandbox(handle, sim.context),
    (error: unknown) =>
      error instanceof HostedError && error.code === "STALE_LEASE",
  );
  assert.equal(confirmations, 1);
  assert.equal((await sim.context.get(sim.input.id)).status, "running");
});
test("owned cleanup exhausts three inspection attempts without releasing an uncertain obligation", async () => {
  const sim = simulator();
  const handle = await createAttemptSandbox(sim.input, sim.context);
  let inspections = 0,
    kills = 0,
    confirmations = 0;
  sim.context.transport.inspect = async () => {
    inspections++;
    throw new TypeError("fetch failed");
  };
  sim.context.transport.terminate = async () => {
    kills++;
  };
  sim.context.confirmTerminated = async () => {
    confirmations++;
  };
  await assert.rejects(
    terminateOwnedSandbox(handle, sim.context),
    /fetch failed/,
  );
  assert.equal(inspections, 3);
  assert.equal(kills, 0);
  assert.equal(confirmations, 0);
  assert.equal((await sim.context.get(sim.input.id)).status, "running");
  assert.equal(sim.records.size, 1);
});
test("owned cleanup rechecks ownership after a transient error and never kills foreign metadata", async () => {
  const sim = simulator();
  const handle = await createAttemptSandbox(sim.input, sim.context);
  const inspect = sim.context.transport.inspect;
  let inspections = 0,
    kills = 0,
    confirmations = 0;
  sim.context.transport.inspect = async (id) => {
    if (++inspections === 1) throw new TypeError("fetch failed");
    const row = await inspect(id);
    if (row) row.metadata.ownerScope = "foreign";
    return row;
  };
  sim.context.transport.terminate = async () => {
    kills++;
  };
  sim.context.confirmTerminated = async () => {
    confirmations++;
  };
  await assert.rejects(terminateOwnedSandbox(handle, sim.context), /unowned/);
  assert.equal(inspections, 2);
  assert.equal(kills, 0);
  assert.equal(confirmations, 0);
});
test("owned cleanup keeps the real compute hold on exhaustion and charges the full bound after recovery", async () => {
  const f = fixture();
  const originalRate = process.env.LOOPBENCH_E2B_USD_PER_SECOND;
  process.env.LOOPBENCH_E2B_USD_PER_SECOND = "0.000037";
  try {
    const campaign = f.campaign();
    initializeEvolution(f.context);
    const job = enqueueJob(
      { ownerScope: campaign.ownerScope, campaignId: campaign.id },
      f.context,
    );
    const lease = claimJob(
      { workerId: "cleanup-regression", jobId: job.id },
      f.context,
    );
    assert.ok(lease);
    const context = makeSandboxContext({ lease }, f.context);
    const sim = simulator();
    context.transport = sim.context.transport;
    const handle = await createAttemptSandbox(
      {
        ...sim.input,
        id: randomUUID(),
        attemptId: randomUUID(),
        ownerScope: campaign.ownerScope,
        campaignId: campaign.id,
      },
      context,
    );
    const budget = () =>
      getBudgetSummary(
        { ownerScope: campaign.ownerScope, campaignId: campaign.id },
        f.context,
      ).compute;
    assert.equal(budget().reservedUsdMicros, 22200n);
    const inspect = context.transport.inspect;
    let inspections = 0;
    context.transport.inspect = async () => {
      inspections++;
      throw new TypeError("fetch failed");
    };
    await assert.rejects(
      terminateOwnedSandbox(handle, context),
      /fetch failed/,
    );
    assert.equal(inspections, 3);
    assert.equal(budget().reservedUsdMicros, 22200n);
    assert.equal(budget().settledUsdMicros, 0n);
    assert.equal((await context.get(handle.intent.id)).status, "running");
    context.transport.inspect = inspect;
    const terminate = context.transport.terminate;
    let kills = 0;
    context.transport.terminate = async (id) => {
      kills++;
      await terminate(id);
      throw new TypeError("fetch failed");
    };
    assert.equal(await terminateOwnedSandbox(handle, context), true);
    assert.equal(kills, 1);
    assert.equal(budget().reservedUsdMicros, 0n);
    assert.equal(budget().settledUsdMicros, 22200n);
    assert.equal((await context.get(handle.intent.id)).status, "terminated");
  } finally {
    if (originalRate === undefined)
      delete process.env.LOOPBENCH_E2B_USD_PER_SECOND;
    else process.env.LOOPBENCH_E2B_USD_PER_SECOND = originalRate;
    f.close();
  }
});
test("REST create is a single POST with deny-all gateway-only policy and inspected ownership", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const transport = createE2BTransport({
    apiKey: "platform-secret",
    controller: async () => remote,
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (init?.method === "POST")
        return Response.json(
          { sandboxID: "one", templateID: "pinned" },
          { status: 201 },
        );
      return Response.json({
        sandboxID: "one",
        templateID: "pinned",
        metadata: { ownerScope: "actual-owner" },
        state: "running",
      });
    },
  });
  const row = await transport.create({
    templateId: "pinned",
    ttlSeconds: 600,
    role: "agent",
    gatewayOrigin: "https://gateway.example.invalid/api/hosted/gateway/v1",
    metadata: { ownerScope: "claimed-owner" },
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.endsWith("/v2/sandboxes"));
  assert.equal(row.metadata.ownerScope, "actual-owner");
  assert.deepEqual(calls[0].body, {
    templateID: "pinned",
    timeout: 600,
    autoPause: false,
    autoResume: { enabled: false },
    metadata: { ownerScope: "claimed-owner" },
    network: {
      denyOut: ["0.0.0.0/0"],
      allowOut: ["gateway.example.invalid"],
      allowPublicTraffic: false,
    },
  });
  let posts = 0;
  const failed = createE2BTransport({
    apiKey: "secret",
    controller: async () => remote,
    fetch: async () => {
      posts++;
      throw new Error("disconnect");
    },
  });
  await assert.rejects(
    failed.create({
      templateId: "pinned",
      ttlSeconds: 600,
      role: "verifier",
      gatewayOrigin: "https://gateway.example.invalid",
      metadata: {},
    }),
    AmbiguousSandboxCreateError,
  );
  assert.equal(posts, 1);
});
test("only a fully settled run with authenticated scoped-call-limit evidence can grade a bounded artifact", () => {
  const state = {
    ...initialPiRunState(),
    accepted: true,
    started: true,
    settled: true,
    processEnded: true,
    exitCode: 0,
    lastStopReason: "error",
  };
  assert.equal(canGradeSettledCallLimit(state, true), true);
  assert.equal(canGradeSettledCallLimit(state, false), false);
  assert.equal(
    canGradeSettledCallLimit({ ...state, settled: false }, true),
    false,
  );
  assert.equal(
    canGradeSettledCallLimit({ ...state, aborted: true }, true),
    false,
  );
  assert.equal(
    canGradeSettledCallLimit(
      { ...state, protocolError: "Provider failure" },
      true,
    ),
    false,
  );
  assert.equal(
    canGradeSettledCallLimit({ ...state, processEnded: false }, true),
    false,
  );
});
test("a token-limited settled submission requires completed-provider evidence before grading", () => {
  const state = {
    ...initialPiRunState(),
    accepted: true,
    started: true,
    settled: true,
    processEnded: true,
    exitCode: 0,
    lastStopReason: "length",
  };
  assert.equal(canGradeSettledOutputLimit(state, true), true);
  assert.equal(canGradeSettledOutputLimit(state, false), false);
  assert.equal(
    canGradeSettledOutputLimit({ ...state, lastStopReason: "error" }, true),
    false,
  );
  assert.equal(
    canGradeSettledOutputLimit({ ...state, settled: false }, true),
    false,
  );
  assert.equal(
    canGradeSettledOutputLimit(
      { ...state, protocolError: "Network error" },
      true,
    ),
    false,
  );
});
test("Pi prompt acceptance and agent_end do not finish a run; recovery requires settled plus process end", () => {
  let state = initialPiRunState();
  for (const raw of [
    { type: "response", command: "prompt", success: true },
    { type: "agent_start" },
    {
      type: "message_end",
      message: { role: "assistant", stopReason: "error" },
    },
    { type: "agent_end", willRetry: true },
  ])
    state = reducePiEvent(state, parsePiEvent(raw));
  assert.equal(piExecutionSucceeded(state), false);
  for (const raw of [
    { type: "agent_start" },
    { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
    { type: "agent_settled", aborted: false },
  ])
    state = reducePiEvent(state, parsePiEvent(raw));
  assert.equal(piExecutionSucceeded(state), false);
  state = reducePiEvent(
    state,
    parsePiEvent({ type: "supervisor_end", exitCode: 0 }),
  );
  assert.equal(piExecutionSucceeded(state), true);
  state = reducePiEvent(
    state,
    parsePiEvent({
      type: "message_end",
      message: { role: "assistant", stopReason: "length" },
    }),
  );
  assert.equal(piExecutionSucceeded(state), false);
});
test("Pi durable log replay preserves partial LF frames and Unicode separators", () => {
  const log =
    JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "a\u2028b" },
    }) +
    "\n" +
    '{"type":"agent_';
  const first = replayPiLog(log),
    second = replayPiLog(log);
  assert.deepEqual(first, second);
  assert.equal(first.events.length, 1);
  assert.equal(first.partial, '{"type":"agent_');
  assert.throws(() => replayPiLog("not-json\n"));
});
test("all six clean task workspaces contain no acceptance cases; public smoke expected values agree with independent oracles", async () => {
  const benchmark = await loadBenchmark("coding-adversarial-v1");
  assert.equal(benchmark.tasks.length, 6);
  for (const task of benchmark.tasks) {
    const workspace = await buildTaskWorkspace({
      taskId: task.id,
      benchmarkHash: benchmark.hash,
    });
    assert.equal(Object.keys(workspace.files).length, 4);
    assert.ok(
      !JSON.stringify(workspace.files).includes(
        task.cases[0].label ?? "Hidden check",
      ),
    );
    assert.ok(
      workspace.files["src/solution.cjs"].includes("Implement the contract"),
    );
    const smoke = workspace.files["test/public-smoke.cjs"];
    const match = /assert\.deepEqual\(solution\(\.\.\.(.+)\), (.+)\);/.exec(
      smoke,
    );
    assert.ok(match);
    assert.deepEqual(
      curriculumOracle(
        curriculumTaskIdSchema.parse(task.id),
        JSON.parse(match[1]),
      ),
      JSON.parse(match[2]),
    );
  }
});
test("canonical extraction refuses remote symlink/escape failures and never falls back to an agent answer", async () => {
  let script = "";
  await assert.rejects(
    extractSubmission({
      remote: {
        ...remote,
        async writeFile(_path, contents) {
          script = contents;
        },
        async run() {
          return { stdout: "", stderr: "Unsafe submission path", exitCode: 1 };
        },
      },
    }),
  );
  assert.ok(script.includes("O_NOFOLLOW"));
  assert.ok(script.includes("isSymbolicLink"));
  assert.ok(script.includes("nlink!==1"));
});
test("harness artifact hash is stable, strict and rejects executable/credential escapes", async () => {
  const runtime = {
    piVersion: "1.4.0",
    nodeVersion: "v24.15.0",
    templateId: "pinned",
    verifierTemplateId: "verifier",
    supervisorSha256: "a".repeat(64),
    toolDefinitionsSha256: "b".repeat(64),
  };
  const artifact = validateHarnessArtifact({
    schemaVersion: 1,
    systemPrompt: "Review edge cases",
    skills: [],
    tools: "read-write-edit-bash",
    verificationPolicy: "public-smoke",
    compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 8192 },
    runtime,
  });
  assert.equal(
    hashHarnessArtifact(artifact),
    hashHarnessArtifact({ ...artifact }),
  );
  assert.throws(() =>
    validateHarnessArtifact({ ...artifact, extension: "danger" }),
  );
  assert.throws(() =>
    validateHarnessArtifact({
      ...artifact,
      systemPrompt: "module.exports = function() {}",
    }),
  );
  assert.throws(() =>
    validateHarnessArtifact({
      ...artifact,
      systemPrompt: "api_key: a-secret-long-enough-credential",
    }),
  );
  const bytes = await readFile("sandbox/pi/supervisor.mjs");
  assert.notEqual(
    createHash("sha256").update(bytes).digest("hex"),
    artifact.runtime.supervisorSha256,
  );
});
test("grader process failures and malformed protocol are infrastructure failures", async () => {
  const benchmark = await loadBenchmark("coding-adversarial-v1");
  const submission = {
    contents: "module.exports=()=>[]",
    sha256: "a".repeat(64),
    bytes: 22,
    path: "/home/user/task/src/solution.cjs" as const,
  };
  const result = await verifySubmission({
    remote,
    submission,
    taskId: "strict-csv",
    benchmarkHash: benchmark.hash,
    nodeVersion: process.version,
  });
  assert.equal(result.status, "infrastructure_failed");
});

for (const scenario of [
  "confirmed",
  "bad_preflight",
  "bad_postflight",
  "wrong_exit",
  "legacy",
] as const) {
  test(`resource quarantine requires exact heap exit and healthy controls: ${scenario}`, async () => {
    const benchmark = await loadBenchmark("coding-adversarial-v1");
    const graderHash = createHash("sha256")
      .update(await readFile("benchmarks/evaluate.mjs"))
      .digest("hex");
    let controls = 0;
    const result = await verifySubmission({
      remote: {
        ...remote,
        async writeFile() {},
        async run(command) {
          if (command === "node --version")
            return { exitCode: 0, stdout: process.version, stderr: "" };
          if (command.startsWith("sha256sum"))
            return { exitCode: 0, stdout: graderHash, stderr: "" };
          if (command.includes("verifier-control.json")) {
            controls++;
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                passed: !(
                  (scenario === "bad_preflight" && controls === 1) ||
                  (scenario === "bad_postflight" && controls === 2)
                ),
                error: null,
              }),
              stderr: "",
            };
          }
          return {
            exitCode: scenario === "wrong_exit" ? 1 : 134,
            stdout: "PRIVATE-HIDDEN-OUTPUT",
            stderr:
              "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory PRIVATE-HIDDEN-INPUT",
          };
        },
      },
      submission: {
        contents: "module.exports=()=>null",
        sha256: "a".repeat(64),
        bytes: 22,
        path: "/home/user/task/src/solution.cjs",
      },
      taskId: "strict-csv",
      benchmarkHash: benchmark.hash,
      nodeVersion: process.version,
      outcomePolicy:
        scenario === "legacy"
          ? "trusted-verifier-infrastructure-v1"
          : "trusted-resource-quarantine-v2",
    });
    assert.equal(result.status, "infrastructure_failed");
    if (result.status !== "infrastructure_failed")
      throw Error("Expected unscored outcome");
    assert.equal(Boolean(result.resourceExhaustion), scenario === "confirmed");
    if (scenario === "confirmed") {
      assert.equal(controls, 2);
      assert.equal(result.resourceExhaustion?.graderSha256, graderHash);
      assert.equal(result.resourceExhaustion?.submissionHash, "a".repeat(64));
    }
    if (scenario === "legacy") assert.equal(controls, 0);
    assert.equal(JSON.stringify(result).includes("PRIVATE-"), false);
  });
}

for (const stage of [
  "runtime",
  "prepare_grader",
  "prepare_input",
  "integrity",
  "execution",
  "decode",
] as const) {
  test(`verifier reports safe ${stage} stage without adapter secrets or hidden grader output`, async () => {
    const benchmark = await loadBenchmark("coding-adversarial-v1");
    const privateSentinel = "SECRET-AND-HIDDEN-INPUT-SENTINEL";
    const graderHash = createHash("sha256")
      .update(await readFile("benchmarks/evaluate.mjs"))
      .digest("hex");
    const result = await verifySubmission({
      remote: {
        ...remote,
        async writeFile(path) {
          if (
            (stage === "prepare_grader" && path.endsWith("evaluate.mjs")) ||
            (stage === "prepare_input" && path.endsWith("input.json"))
          )
            throw Object.assign(new Error(privateSentinel), { code: "EPIPE" });
        },
        async run(command) {
          if (command === "node --version") {
            if (stage === "runtime")
              throw Object.assign(new Error(privateSentinel), {
                code: "EAGAIN",
              });
            return { exitCode: 0, stdout: process.version, stderr: "" };
          }
          if (command.startsWith("sha256sum"))
            return {
              exitCode: 0,
              stdout: stage === "integrity" ? privateSentinel : graderHash,
              stderr: "",
            };
          return {
            exitCode: stage === "execution" ? 1 : 0,
            stdout: privateSentinel,
            stderr: privateSentinel,
          };
        },
      },
      submission: {
        contents: "module.exports=()=>[]",
        sha256: "a".repeat(64),
        bytes: 22,
        path: "/home/user/task/src/solution.cjs",
      },
      taskId: "strict-csv",
      benchmarkHash: benchmark.hash,
      nodeVersion: process.version,
    });
    assert.equal(result.status, "infrastructure_failed");
    if (result.status !== "infrastructure_failed")
      throw Error("Expected infrastructure failure");
    assert.equal(result.diagnostic?.stage, stage);
    if (stage === "execution") {
      assert.equal(result.diagnostic.processExitCode, 1);
      assert.equal(result.diagnostic.processFailure, "nonzero_exit");
    }
    assert.equal(JSON.stringify(result).includes(privateSentinel), false);
    assert.equal(
      JSON.stringify(result).includes(JSON.stringify(benchmark.tasks[0].cases)),
      false,
    );
  });
}

test("attempt admission/grant failures retain categories and clean up owned resources before returning", async () => {
  const benchmark = await loadBenchmark("coding-adversarial-v1");
  const sim = simulator();
  const harness = validateHarnessArtifact({
    schemaVersion: 1,
    systemPrompt: "Review boundary conditions",
    skills: [],
    tools: "read-write-edit",
    verificationPolicy: "public-smoke",
    compaction: { enabled: false, reserveTokens: 4096, keepRecentTokens: 8192 },
    runtime: {
      piVersion: "1.4.0",
      nodeVersion: "v24.15.0",
      templateId: "pinned",
      verifierTemplateId: "pinned",
      supervisorSha256: "a".repeat(64),
      toolDefinitionsSha256: "b".repeat(64),
    },
  });
  const input = {
    attemptId: "attempt",
    ownerScope: "owner",
    campaignId: "campaign",
    taskId: "strict-csv",
    benchmarkHash: benchmark.hash,
    harness,
    model: { id: "fixture-model", contextWindow: 32768, maxTokens: 4096 },
    gatewayOrigin: "https://gateway.example.invalid",
    agentIntentId: "agent-intent",
    verifierIntentId: "verifier-intent",
  };
  const context = {
    sandboxes: sim.context,
    async grant(): Promise<{ token: string; revoke(): Promise<void> }> {
      throw new HostedError(
        "INFERENCE_BUDGET",
        "The inference allowance is exhausted.",
        429,
      );
    },
    async event() {},
    async saveArtifact() {
      throw new Error("No artifacts expected");
    },
    async assertFence() {},
  };
  const result = await runTaskAttempt(input, context);
  assert.equal(result.status, "infrastructure_failed");
  assert.equal(result.failureCode, "INFERENCE_BUDGET");
  assert.equal(result.error, "The inference allowance is exhausted.");
  assert.equal(result.submissionHash, null);
  assert.equal(result.cleanupPending, false);
  assert.equal(sim.records.size, 0);
  assert.equal(sim.creates(), 1);
  const uncertain = simulator();
  uncertain.loseCreate();
  const lost = await runTaskAttempt(input, {
    ...context,
    sandboxes: uncertain.context,
  });
  assert.equal(lost.failureCode, "SANDBOX_OUTCOME_UNKNOWN");
  assert.equal(lost.cleanupPending, true);
  assert.equal(uncertain.records.size, 1);
  assert.equal((await uncertain.context.get("agent-intent")).status, "unknown");
});
test("full suite requires all six tasks; paired decision refuses historical parent, cross context, incomplete and ties", async () => {
  const benchmark = await loadBenchmark("coding-adversarial-v1");
  const context = buildComparisonContext({
    benchmarkHash: benchmark.hash,
    taskIds: benchmark.tasks.map((task) => task.id),
    modelId: "nemotron",
    templateId: "pinned",
    verifierTemplateId: "verify",
    piVersion: "1.4.0",
    nodeVersion: process.version,
    graderSha256: "a".repeat(64),
    networkPolicyHash: "b".repeat(64),
    hardwarePolicyHash: "c".repeat(64),
  });
  const execute = async (taskId: string) => ({
    attemptId: taskId,
    taskId,
    status: "passed" as const,
    error: null,
    submissionHash: "a",
    artifacts: [],
    cleanupPending: false,
  });
  const parent = await evaluateVersion(
    {
      versionId: "parent",
      comparisonId: "comparison",
      role: "parent",
      context,
      fullSuite: true,
    },
    { executeTask: execute, async checkpoint() {} },
  );
  const candidate: VersionEvaluation = {
    ...parent,
    versionId: "candidate",
    role: "candidate",
  };
  assert.equal(
    decidePairedVerdict(parent, candidate, context).status,
    "rejected",
  );
  assert.equal(
    decidePairedVerdict({ ...parent, role: "baseline" }, candidate, context)
      .status,
    "failed",
  );
  assert.equal(
    decidePairedVerdict(
      parent,
      { ...candidate, contextHash: "different" },
      context,
    ).status,
    "failed",
  );
  assert.equal(
    decidePairedVerdict(
      { ...parent, attempts: parent.attempts.slice(1) },
      candidate,
      context,
    ).status,
    "failed",
  );
  await assert.rejects(
    evaluateVersion(
      {
        versionId: "candidate",
        comparisonId: "comparison",
        role: "candidate",
        context: { ...context, taskIds: context.taskIds.slice(0, 1) },
        fullSuite: true,
      },
      { executeTask: execute, async checkpoint() {} },
    ),
    /all six/,
  );
});

async function childProcess(args: string[], input = "") {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { NODE_ENV: "test" },
      });
      let stdout = "",
        stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Fixture deadline exceeded"));
      }, 10000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? -1 });
      });
      child.stdin.end(input);
    },
  );
}
async function finiteAttemptWithProviderCompletion(
  providerCompletion: boolean | undefined,
  verifierFailure = false,
  resourceQuarantine = false,
) {
  // Explicit protocol fixture, NOT a real Pi/model/E2B run. E2B control plane is simulated.
  const benchmark = await loadBenchmark("coding-adversarial-v1");
  const sim = simulator();
  const directory = await mkdtemp(
    path.join(tmpdir(), "loopbench-hosted-verifier-"),
  );
  const solution =
    "module.exports=function(tasks){const m=new Map(tasks.map(t=>[t.id,new Set(t.deps)]));if(m.size!==tasks.length)return null;for(const d of m.values())for(const id of d)if(!m.has(id))return null;const done=new Set(),out=[];while(done.size<m.size){const layer=[...m].filter(([id,d])=>!done.has(id)&&[...d].every(x=>done.has(x))).map(([id])=>id).sort();if(!layer.length)return null;out.push(layer);for(const id of layer)done.add(id);}return out;};";
  const agentFiles = new Map<string, string>(),
    verifierFiles = new Map<string, string>();
  let verifierStarted = false;
  let revoked = false;
  let log = "";
  const agent: RemoteSandbox = {
    ...remote,
    async writeFile(name, contents) {
      agentFiles.set(name, contents);
    },
    async start() {
      const fixture = [
        { type: "response", command: "prompt", success: true },
        { type: "agent_start" },
        {
          type: "tool_execution_start",
          toolCallId: "fixture-write",
          toolName: "write",
          args: { path: "src/solution.cjs" },
        },
        {
          type: "tool_execution_end",
          toolCallId: "fixture-write",
          toolName: "write",
          isError: false,
        },
        {
          type: "message_end",
          message: { role: "assistant", stopReason: "stop" },
        },
        { type: "agent_end", willRetry: false },
        { type: "agent_settled", aborted: false },
        { type: "supervisor_end", exitCode: 0 },
      ];
      const result = await childProcess([
        "-e",
        `for(const event of ${JSON.stringify(fixture)})process.stdout.write(JSON.stringify(event)+'\\n');`,
      ]);
      assert.equal(result.exitCode, 0);
      log = result.stdout;
      return 7;
    },
    async run(command) {
      if (command.includes("agent-confined"))
        return { stdout: "agent-confined", stderr: "", exitCode: 0 };
      if (command.includes("sudo -n"))
        return { stdout: "", stderr: "denied", exitCode: 1 };
      if (command.includes("head -c"))
        return { stdout: log, stderr: "", exitCode: 0 };
      if (command.includes("result.json"))
        return {
          stdout: '{"type":"supervisor_end","exitCode":0}',
          stderr: "",
          exitCode: 0,
        };
      if (command === "node /opt/loopbench/extract.cjs")
        return {
          stdout: JSON.stringify({
            base64: Buffer.from(solution).toString("base64"),
          }),
          stderr: "",
          exitCode: 0,
        };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
  const verifier: RemoteSandbox = {
    ...remote,
    async writeFile(name, contents) {
      verifierFiles.set(name, contents);
    },
    async run(command) {
      if (command === "node --version")
        return { stdout: process.version, stderr: "", exitCode: 0 };
      if (command.startsWith("sha256sum"))
        return {
          stdout:
            createHash("sha256")
              .update(verifierFiles.get("/opt/loopbench/evaluate.mjs") ?? "")
              .digest("hex") + "  evaluate.mjs",
          stderr: "",
          exitCode: 0,
        };
      if (command.includes("--permission")) {
        verifierStarted = true;
        if (command.includes("verifier-control.json"))
          return {
            exitCode: 0,
            stdout: '{"passed":true,"error":null}',
            stderr: "",
          };
        if (verifierFailure)
          return {
            exitCode: resourceQuarantine ? 134 : 1,
            stdout: "PRIVATE-GRADER-OUTPUT",
            stderr: resourceQuarantine
              ? "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory PRIVATE-ADAPTER-SECRET"
              : "PRIVATE-ADAPTER-SECRET",
          };
        assert.equal(
          verifierFiles.has("/opt/loopbench/run/config.json"),
          false,
        );
        assert.equal(
          verifierFiles.has("/opt/loopbench/pi-agent/models.json"),
          false,
        );
        const evaluator = path.join(directory, "evaluate.mjs");
        await writeFile(
          evaluator,
          verifierFiles.get("/opt/loopbench/evaluate.mjs") ?? "",
        );
        return childProcess(
          [
            "--permission",
            `--allow-fs-read=${evaluator}`,
            "--max-old-space-size=64",
            evaluator,
          ],
          verifierFiles.get("/opt/loopbench/input.json"),
        );
      }
      throw new Error("Unexpected verifier command");
    },
  };
  sim.context.transport.connect = async (row) =>
    row.metadata.role === "agent" ? agent : verifier;
  const digest = async (name: string) =>
    createHash("sha256")
      .update(await readFile(`sandbox/pi/${name}`))
      .digest("hex");
  const harness = validateHarnessArtifact({
    schemaVersion: 1,
    systemPrompt: "Review boundaries",
    skills: [],
    tools: "read-write-edit-bash",
    verificationPolicy: "public-smoke",
    compaction: {
      enabled: false,
      reserveTokens: 4096,
      keepRecentTokens: 8192,
    },
    runtime: {
      piVersion: "1.4.0",
      nodeVersion: "v24.15.0",
      templateId: "pinned",
      verifierTemplateId: "pinned",
      supervisorSha256: await digest("supervisor.mjs"),
      toolDefinitionsSha256: await digest("request-identity.mjs"),
    },
  });
  // E2B transport reports the pinned cloud runtime; the local evaluator child uses the test host's Node version.
  verifier.run = ((original) => async (command, options) =>
    command === "node --version"
      ? { stdout: harness.runtime.nodeVersion, stderr: "", exitCode: 0 }
      : original(command, options))(verifier.run);
  const events: string[] = [];
  const artifacts = new Map<string, string>();
  try {
    const result = await runTaskAttempt(
      {
        attemptId: "attempt",
        ownerScope: "owner",
        campaignId: "campaign",
        taskId: "dependency-layers",
        benchmarkHash: benchmark.hash,
        harness,
        model: {
          id: "fixture-model",
          contextWindow: 32768,
          maxTokens: 4096,
        },
        gatewayOrigin: "https://gateway.example.invalid",
        agentIntentId: "agent-intent",
        verifierIntentId: "verifier-intent",
        verifierOutcomePolicy: resourceQuarantine
          ? "trusted-resource-quarantine-v2"
          : "trusted-verifier-infrastructure-v1",
      },
      {
        sandboxes: sim.context,
        async grant() {
          return {
            token: "scoped-fixture-only",
            async revoke() {
              revoked = true;
            },
          };
        },
        async event(type) {
          events.push(type);
        },
        async saveArtifact(kind, contents) {
          artifacts.set(kind, contents);
          return kind;
        },
        async assertFence() {},
        ...(providerCompletion === undefined
          ? {}
          : {
              async completedProviderCallsConfirmed() {
                return providerCompletion;
              },
            }),
      },
    );
    if (providerCompletion !== true) {
      assert.equal(result.status, "infrastructure_failed");
      assert.equal(result.failureCode, "RECONCILIATION_REQUIRED");
      assert.equal(result.submissionHash, null);
      assert.equal(verifierStarted, false);
      assert.equal(artifacts.has("submission"), false);
      assert.equal(artifacts.has("pi-events"), true);
      assert.equal(events.includes("attempt_verifying"), false);
      assert.equal(sim.creates(), 1);
      assert.equal(sim.records.size, 0);
      assert.equal(result.cleanupPending, false);
      assert.equal(revoked, true);
      return;
    }
    if (verifierFailure) {
      assert.equal(result.status, "infrastructure_failed");
      assert.equal(
        result.failureCode,
        resourceQuarantine ? "CANDIDATE_RESOURCE_EXHAUSTED" : "VERIFIER_FAILED",
      );
      assert.equal(
        JSON.parse(artifacts.get("platform-diagnostic") ?? "{}").stage,
        "execution",
      );
      assert.equal(
        JSON.parse(artifacts.get("platform-diagnostic") ?? "{}")
          .processExitCode,
        resourceQuarantine ? 134 : 1,
      );
      if (resourceQuarantine) {
        const proof = JSON.parse(
          artifacts.get("trusted-resource-result") ?? "{}",
        );
        assert.equal(proof.submissionHash, result.submissionHash);
        assert.equal(proof.healthyBefore, true);
        assert.equal(proof.healthyAfter, true);
        assert.equal(proof.attemptId, "attempt");
        assert.equal(
          artifacts.get("verifier-result")?.includes("resourceExhaustion"),
          false,
        );
      }
      assert.equal(
        artifacts.get("verifier-result")?.includes("diagnostic"),
        false,
      );
      assert.equal(JSON.stringify([...artifacts]).includes("PRIVATE-"), false);
      assert.equal(sim.records.size, 0);
      return;
    }
    assert.equal(result.status, "passed");
    assert.equal(result.cleanupPending, false);
    assert.equal(revoked, true);
    assert.equal(verifierStarted, true);
    assert.equal(sim.creates(), 2);
    assert.equal(sim.records.size, 0);
    assert.deepEqual(
      events.filter((type) => type !== "attempt_progress"),
      [
        "attempt_preparing",
        "attempt_running",
        "attempt_verifying",
        "attempt_result",
      ],
    );
    assert.ok(artifacts.has("submission"));
    assert.ok(artifacts.has("pi-events"));
    assert.ok(!JSON.stringify([...agentFiles]).includes('"cases"'));
    assert.equal(
      (await sim.context.get("verifier-intent")).status,
      "terminated",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("finite attempt uses real child-process event fixture and immutable evaluator in a fresh verifier transport", () =>
  finiteAttemptWithProviderCompletion(true));

test("attempt persists safe verifier stage in its internal diagnostic artifact", () =>
  finiteAttemptWithProviderCompletion(true, true));

test("attempt persists a separate trusted unscored resource receipt without exposing private verifier bytes", () =>
  finiteAttemptWithProviderCompletion(true, true, true));

for (const providerCompletion of [false, undefined]) {
  test(`ordinary successful Pi settlement refuses verification when provider completion is ${String(providerCompletion)}`, () =>
    finiteAttemptWithProviderCompletion(providerCompletion));
}
