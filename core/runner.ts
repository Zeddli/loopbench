import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { callAdapter, runProcess } from "./adapters";
import { evaluateCode, loadBenchmark, type Benchmark } from "./benchmarks";
import { getCampaign } from "./campaigns";
import {
  getNode,
  listAdapters,
  projectRoot,
  saveNode,
  treeIdentity,
} from "./store";
import {
  runConfigSchema,
  learningSchema,
  type AdapterManifest,
  type NodeRecord,
  type RunConfig,
  type TaskResult,
} from "./types";

export const runOptionsSchema = z.object({
  adapterId: z.string().min(1),
  domain: z.string().min(1),
  model: z.string().min(1),
  harness: z.string().min(1),
  benchmark: z.string().min(1),
  hypothesis: z.string().min(1),
  parentId: z.string().optional(),
  settings: z.record(z.string(), z.string()).default({}),
  learning: learningSchema.optional(),
});
export type RunOptions = z.input<typeof runOptionsSchema>;
export type RunProgress = (node: NodeRecord) => unknown;
export interface CallContext {
  nodeId: string;
  taskId: string;
  kind: "baseline" | "parent" | "candidate" | "challenge";
}
export interface RunControls {
  campaignId?: string;
  challenge?: boolean;
  beforeCall?: (context: CallContext) => Promise<void>;
  onUsage?: (
    context: CallContext,
    usage: { inputTokens?: number; outputTokens?: number; costUsd?: number },
  ) => Promise<void>;
  onCallError?: (context: CallContext, error: string) => Promise<void>;
}
function errorMessage(error: unknown): string {
  let message = (error instanceof Error ? error.message : String(error))
    .slice(0, 8000)
    .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, "[redacted]");
  for (const [key, value] of Object.entries(process.env))
    if (
      /key|token|secret|password|authorization/i.test(key) &&
      value &&
      value.length >= 6
    )
      message = message.split(value).join("[redacted]");
  return message;
}
async function fingerprint(
  config: RunConfig,
  adapter: AdapterManifest,
): Promise<string> {
  const artifacts: Record<string, string> = {};
  for (const argument of adapter.args.filter((value) =>
    path.isAbsolute(value),
  )) {
    try {
      artifacts[argument] = createHash("sha256")
        .update(await readFile(argument))
        .digest("hex");
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "EISDIR")
      ))
        throw error;
    }
  }
  const codexVersion =
    adapter.id === "codex-cli"
      ? (
          await runProcess("codex", ["--version"], "", projectRoot, 10000)
        ).stdout.trim()
      : null;
  return createHash("sha256")
    .update(
      JSON.stringify({
        adapter,
        harness: config.harness,
        settings: config.settings,
        artifacts,
        nodeVersion: process.version,
        codexVersion,
      }),
    )
    .digest("hex");
}
const score = (tasks: TaskResult[]) =>
  tasks.filter((task) => task.passed).length / tasks.length;
async function evaluateTask(
  task: Benchmark["tasks"][number],
  config: RunConfig,
  adapter: AdapterManifest,
  onUsage: (usage: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  }) => Promise<void> = async () => {},
): Promise<TaskResult> {
  const start = Date.now();
  const cwd = await mkdtemp(path.join(tmpdir(), "loopbench-task-"));
  try {
    const response = await callAdapter(
      adapter,
      { id: task.id, prompt: task.prompt },
      config,
      cwd,
    );
    await onUsage(response);
    const evaluation = await evaluateCode(response.output, task, cwd);
    return {
      taskId: task.id,
      ...evaluation,
      durationMs: Date.now() - start,
      output: response.output,
      inputTokens: response.inputTokens ?? null,
      outputTokens: response.outputTokens ?? null,
      costUsd: response.costUsd ?? null,
    };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
export async function runBenchmark(
  raw: RunOptions,
  onProgress: RunProgress = () => {},
  controls: RunControls = {},
): Promise<NodeRecord> {
  const options = runOptionsSchema.parse(raw);
  if (
    Object.keys(options.settings).some(
      (key) =>
        /key|token$|secret|password|authorization/i.test(key) &&
        key !== "maxTokens",
    )
  )
    throw new Error(
      "Pass credentials through environment variables, not run settings",
    );
  const benchmark = await loadBenchmark(options.benchmark);
  if (benchmark.domain !== options.domain)
    throw new Error(
      `Benchmark domain is ${benchmark.domain}, not ${options.domain}`,
    );
  const campaign = controls.campaignId
    ? await getCampaign(controls.campaignId)
    : null;
  if (
    controls.campaignId &&
    (!campaign?.options.continuous ||
      !campaign.lineageId ||
      !campaign.curriculum ||
      campaign.curriculum.benchmarkHash !== benchmark.hash ||
      campaign.domain !== options.domain ||
      campaign.model !== options.model ||
      campaign.harness !== options.harness ||
      campaign.adapterId !== options.adapterId)
  )
    throw new Error(
      "Continuous run must match its persisted campaign and current curriculum",
    );
  const config = runConfigSchema.parse({
    adapterId: options.adapterId,
    domain: options.domain,
    model: options.model,
    harness: options.harness,
    benchmarkId: benchmark.id,
    benchmarkHash: benchmark.hash,
    benchmarkPath: benchmark.sourcePath,
    settings: options.settings,
    ...(campaign?.lineageId ? { lineageId: campaign.lineageId } : {}),
  });
  const adapters = await listAdapters();
  const adapter = adapters.find((item) => item.id === config.adapterId);
  if (!adapter)
    throw new Error(
      `Unknown adapter: ${config.adapterId}. Register it with adapter add.`,
    );
  const parent = options.parentId ? await getNode(options.parentId) : null;
  if (options.parentId && !parent)
    throw new Error(`Parent node ${options.parentId} does not exist`);
  // An ordinary manual child can continue a recorded lineage on exactly the
  // same suite. Only the campaign control path can authorise a stage transition.
  if (
    !campaign &&
    parent?.config.lineageId &&
    parent.config.benchmarkHash === benchmark.hash
  )
    config.lineageId = parent.config.lineageId;
  const treeId = treeIdentity(config);
  if (
    parent &&
    (parent.config.domain !== config.domain ||
      parent.config.model !== config.model ||
      parent.config.harness !== config.harness)
  )
    throw new Error(
      "Parent must belong to the same domain/model/harness/benchmark tree",
    );
  const challenge = Boolean(
    controls.challenge &&
    campaign?.curriculum &&
    parent &&
    campaign.curriculum.transitionParentId === parent.id &&
    campaign.curriculum.baselineNodeId === null &&
    (parent.config.lineageId || parent.treeId) === campaign.lineageId &&
    (parent.curriculum?.level ?? 0) === campaign.curriculum.level - 1 &&
    parent.config.benchmarkHash !== benchmark.hash,
  );
  if (controls.challenge && !challenge)
    throw new Error(
      "Challenge transition is not authorised by the persisted continuous campaign",
    );
  if (
    challenge &&
    parent &&
    JSON.stringify(options.settings) !== JSON.stringify(parent.config.settings)
  )
    throw new Error(
      "Challenge baseline must preserve the champion's exact instructions and settings",
    );
  if (challenge && parent?.config.adapterId !== options.adapterId)
    throw new Error("Challenge baseline must preserve the champion's adapter");
  if (
    parent &&
    (parent.treeId !== treeId ||
      (!challenge && parent.config.benchmarkHash !== benchmark.hash))
  )
    throw new Error(
      "Parent must belong to the same domain/model/harness/benchmark tree",
    );
  if (
    parent &&
    (parent.status === "running" ||
      parent.status === "failed" ||
      parent.score === null ||
      parent.tasks.length !== parent.totalTasks ||
      !parent.completedAt)
  )
    throw new Error("Parent must be a completed valid evaluation");
  const node: NodeRecord = {
    id: randomUUID(),
    treeId,
    parentId: parent?.id || null,
    hypothesis: options.hypothesis,
    createdAt: new Date().toISOString(),
    completedAt: null,
    harnessHash: await fingerprint(config, adapter),
    config,
    status: "running",
    totalTasks: benchmark.tasks.length,
    tasks: [],
    score: null,
    comparison: null,
    error: null,
    ...(options.learning ? { learning: options.learning } : {}),
    ...(campaign?.curriculum
      ? {
          event: challenge ? "challenge" : "evaluation",
          curriculum: {
            level: campaign.curriculum.level,
            benchmarkHash: benchmark.hash,
            benchmarkId: benchmark.id,
          },
        }
      : parent?.curriculum && parent.config.benchmarkHash === benchmark.hash
        ? { event: "evaluation", curriculum: { ...parent.curriculum } }
        : {}),
  };
  const publish = async () => {
    await saveNode(node);
    await onProgress(structuredClone(node));
  };
  await publish();
  try {
    const parentTasks: TaskResult[] = [];
    let parentAdapter: AdapterManifest | undefined;
    if (parent) {
      parentAdapter = adapters.find(
        (item) => item.id === parent.config.adapterId,
      );
      if (
        !parentAdapter ||
        (await fingerprint(parent.config, parentAdapter)) !== parent.harnessHash
      )
        throw new Error(
          "Parent adapter manifest, entrypoint or runtime changed or is missing; cannot reproduce its recorded configuration",
        );
    }
    const controlledTask = async (
      task: Benchmark["tasks"][number],
      taskConfig: RunConfig,
      taskAdapter: AdapterManifest,
      kind: CallContext["kind"],
    ) => {
      const context = { nodeId: node.id, taskId: task.id, kind };
      await controls.beforeCall?.(context);
      let usageReported = false;
      try {
        const result = await evaluateTask(
          task,
          taskConfig,
          taskAdapter,
          async (usage) => {
            await controls.onUsage?.(context, usage);
            usageReported = true;
          },
        );
        return result;
      } catch (error) {
        if (!usageReported)
          await controls.onCallError?.(context, errorMessage(error));
        throw error;
      }
    };
    for (const task of benchmark.tasks) {
      // The same task is rerun with the parent's original configuration before the candidate.
      if (parent && parentAdapter && !challenge)
        parentTasks.push(
          await controlledTask(task, parent.config, parentAdapter, "parent"),
        );
      node.tasks.push(
        await controlledTask(
          task,
          config,
          adapter,
          challenge ? "challenge" : parent ? "candidate" : "baseline",
        ),
      );
      await publish();
    }
    node.score = score(node.tasks);
    if (parent && !challenge) {
      const parentScore = score(parentTasks);
      const delta = node.score - parentScore;
      node.status = delta > 0 ? "accepted" : "rejected";
      node.comparison = {
        parentScore,
        candidateScore: node.score,
        delta,
        method: "paired",
        parentTasks,
        reason:
          delta > 0
            ? "Candidate passed more tasks in this single paired run."
            : "Candidate did not improve task pass rate in this single paired run.",
      };
    } else node.status = "baseline";
  } catch (error) {
    node.status = "failed";
    node.error = errorMessage(error);
  }
  node.completedAt = new Date().toISOString();
  await publish();
  return node;
}
