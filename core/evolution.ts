import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { callAdapter } from "./adapters";
import { loadBenchmark, type Benchmark } from "./benchmarks";
import {
  clearCampaignControl,
  getCampaign,
  readCampaignControl,
  requestCampaignControl,
  saveCampaign,
  withCampaignLock,
} from "./campaigns";
import { generateCurriculumBenchmark } from "./curriculum";
import { runBenchmark, type CallContext, type RunControls } from "./runner";
import { getNode, getTree, listAdapters, projectRoot, saveNode } from "./store";
import {
  evolutionOptionsSchema,
  proposalSchema,
  type AdapterManifest,
  type EvolutionCampaign,
  type EvolutionOptions,
  type NodeRecord,
  type RunConfig,
} from "./types";

export type EvolutionProgress = (campaign: EvolutionCampaign) => unknown;
const proposerManifest: AdapterManifest = {
  id: "codex-proposer",
  name: "Codex experiment proposer",
  command: process.execPath,
  args: [path.join(projectRoot, "adapters", "codex-proposer.mjs")],
  description:
    "Generates evidence-grounded sibling proposals with actual Codex inference.",
  protocol: "loopbench.task.v1",
  timeoutMs: 180000,
};
function safeError(error: unknown): string {
  let message = (error instanceof Error ? error.message : String(error)).slice(
    0,
    8000,
  );
  for (const [key, value] of Object.entries(process.env))
    if (
      /key|token|secret|password|authorization/i.test(key) &&
      value &&
      value.length >= 6
    )
      message = message.split(value).join("[redacted]");
  return message.replace(/\bsk-[A-Za-z0-9_-]{10,}/g, "[redacted]");
}
function providerLimit(message: string | null): boolean {
  return (
    message !== null &&
    /usage limit|insufficient_quota|quota (?:exceeded|exhausted)|rate.?limit|too many requests|HTTP 429/i.test(
      message,
    )
  );
}
function eligible(node: NodeRecord): boolean {
  return (
    node.status !== "running" &&
    node.status !== "failed" &&
    node.score !== null &&
    node.completedAt !== null &&
    node.tasks.length === node.totalTasks
  );
}
export function adaptiveBranchCount(
  evidence: Pick<NodeRecord, "tasks" | "comparison">[],
): number {
  const failedTasks = new Set(
    evidence.flatMap((node) =>
      [...node.tasks, ...(node.comparison?.parentTasks || [])]
        .filter((task) => !task.passed)
        .map((task) => task.taskId),
    ),
  );
  return Math.min(6, 2 + failedTasks.size);
}

function completedSiblingRound(
  campaign: EvolutionCampaign,
  nodes: NodeRecord[],
  benchmarkHash: string,
): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (let round = campaign.completedRounds; round >= 1; round--) {
    const siblings = campaign.proposals.filter(
      (proposal) => proposal.round === round,
    );
    if (siblings.length < 2 || siblings.length > 6) continue;
    if (new Set(siblings.map((proposal) => proposal.parentId)).size !== 1)
      continue;
    if (
      siblings.every((proposal) => {
        const node = proposal.nodeId ? byId.get(proposal.nodeId) : undefined;
        return (
          node?.config.benchmarkHash === benchmarkHash &&
          node.status !== "running" &&
          node.completedAt !== null
        );
      })
    )
      return true;
  }
  return false;
}
async function regressionPins(
  nodes: NodeRecord[],
): Promise<
  { taskId: string; case: Benchmark["tasks"][number]["cases"][number] }[]
> {
  const suites = new Map<string, Benchmark>();
  const pins = new Map<
    string,
    { taskId: string; case: Benchmark["tasks"][number]["cases"][number] }
  >();
  for (const node of nodes) {
    const failures = [
      ...node.tasks,
      ...(node.comparison?.parentTasks || []),
    ].filter((task) => !task.passed && task.error);
    if (!failures.length) continue;
    let suite = suites.get(node.config.benchmarkHash);
    if (!suite) {
      suite = await loadBenchmark(
        node.config.benchmarkPath || node.config.benchmarkId,
      );
      if (suite.hash !== node.config.benchmarkHash)
        throw new Error(
          "Historical regression suite changed; cannot safely retain observed failing checks",
        );
      suites.set(suite.hash, suite);
    }
    for (const result of failures) {
      const task = suite.tasks.find((item) => item.id === result.taskId);
      if (!task)
        throw new Error(
          "Historical failed task is absent from its recorded suite",
        );
      for (const [index, check] of task.cases.entries()) {
        const diagnostic = check.label
          ? `Case: ${check.label}:`
          : `Hidden check ${index + 1}:`;
        if (result.error?.startsWith(diagnostic))
          pins.set(JSON.stringify([task.id, check]), {
            taskId: task.id,
            case: check,
          });
      }
    }
  }
  return [...pins.values()];
}
export function evidenceDigest(
  benchmark: Benchmark,
  nodes: NodeRecord[],
  eligibleParents: NodeRecord[],
  branches: number,
  round: number,
  bounded = false,
): string {
  const selectedIds = new Set(eligibleParents.map((node) => node.id));
  if (bounded) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    // Keep current beam parents and nearby ancestry alongside recent experiments.
    for (const parent of eligibleParents) {
      let ancestor: NodeRecord | undefined = parent;
      for (
        let depth = 0;
        ancestor && depth < 8 && selectedIds.size < 32;
        depth++
      ) {
        selectedIds.add(ancestor.id);
        ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined;
      }
    }
    if (nodes[0]) selectedIds.add(nodes[0].id);
    for (const node of nodes.slice(-24).reverse()) {
      if (selectedIds.size >= 40) break;
      selectedIds.add(node.id);
    }
  }
  const selected = bounded
    ? nodes.filter((node) => selectedIds.has(node.id))
    : nodes;
  const failures = new Map<string, number>();
  const strategies = new Map<string, number>();
  if (bounded)
    for (const node of nodes) {
      for (const task of [
        ...node.tasks,
        ...(node.comparison?.parentTasks || []),
      ].filter((task) => !task.passed)) {
        const category = `${task.taskId}: ${(task.error || "Unknown failure").replace(/curriculum level \d+/g, "curriculum level #").slice(0, 180)}`;
        failures.set(category, (failures.get(category) || 0) + 1);
      }
      if (node.learning) {
        const lesson = `${node.status}: ${node.learning.change.slice(0, 240)}`;
        strategies.set(lesson, (strategies.get(lesson) || 0) + 1);
      }
    }
  const evidence = selected.map((node) => ({
    id: node.id,
    parentId: node.parentId,
    status: node.status,
    score: node.score,
    curriculum: node.curriculum || null,
    benchmarkHash: node.config.benchmarkHash,
    event: node.event || "evaluation",
    hypothesis: node.hypothesis.slice(0, bounded ? 500 : 2000),
    instructions: (node.config.settings.instructions || "").slice(
      0,
      bounded ? 1600 : 12000,
    ),
    learning:
      bounded && node.learning
        ? {
            ...node.learning,
            learnedFrom: node.learning.learnedFrom.slice(-12),
            diagnosis: node.learning.diagnosis.slice(0, 400),
            change: node.learning.change.slice(0, 400),
            prediction: node.learning.prediction.slice(0, 300),
          }
        : node.learning || null,
    error: node.error?.slice(0, bounded ? 500 : 8000) || null,
    totalMeasuredTasks: node.tasks.length,
    tasks: (bounded
      ? [...node.tasks]
          .sort((a, b) => Number(a.passed) - Number(b.passed))
          .slice(0, 12)
      : node.tasks
    ).map((task) => ({
      id: task.taskId,
      passed: task.passed,
      output: task.output.slice(0, bounded ? 450 : 2500),
      diagnostic: task.error?.slice(0, bounded ? 350 : 8000) || null,
    })),
    pairedComparison: node.comparison
      ? {
          parentScore: node.comparison.parentScore,
          candidateScore: node.comparison.candidateScore,
          delta: node.comparison.delta,
          parentFailures: node.comparison.parentTasks
            .filter((task) => !task.passed)
            .slice(0, bounded ? 12 : undefined)
            .map((task) => ({
              id: task.taskId,
              diagnostic: task.error?.slice(0, bounded ? 350 : 8000) || null,
              output: task.output.slice(0, bounded ? 300 : 1500),
            })),
        }
      : null,
  }));
  const archive = bounded
    ? {
        totalNodes: nodes.length,
        omittedNodes: nodes.length - evidence.length,
        failedObservations: [...failures.values()].reduce(
          (sum, count) => sum + count,
          0,
        ),
        failureClassCount: failures.size,
        failureClasses: [...failures]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 64)
          .map(([diagnostic, count]) => ({ diagnostic, count })),
        priorStrategyCount: strategies.size,
        priorStrategies: [...strategies]
          .slice(-24)
          .map(([lesson, count]) => ({ lesson, count })),
        retention:
          "All original node records and exact observed failing checks remain in persistent storage. This prompt contains a bounded evidence window and aggregate history.",
      }
    : undefined;
  const digest = {
    round,
    branches,
    eligibleParentIds: eligibleParents.map((node) => node.id),
    publicTasks: benchmark.tasks.map((task) => ({
      id: task.id,
      prompt: task.prompt,
    })),
    evidence,
    ...(archive ? { archive } : {}),
  };
  if (bounded) {
    const requiredIds = new Set(eligibleParents.map((node) => node.id));
    while (JSON.stringify(digest).length > 120000) {
      const removable = evidence.findIndex((node) => !requiredIds.has(node.id));
      if (removable < 0) break;
      evidence.splice(removable, 1);
    }
    if (archive) archive.omittedNodes = nodes.length - evidence.length;
    if (JSON.stringify(digest).length > 120000)
      throw new Error(
        "Public tasks and required parent evidence exceed the bounded proposer context; use a smaller task frontier",
      );
  }
  return JSON.stringify(digest);
}
function proposalPrompt(digest: string, branches: number): string {
  return `Design exactly ${branches} distinct sibling harness-instruction experiments from this actual evaluation history. Select ONE shared parentId from eligibleParentIds for every sibling. Diagnose specific failed task IDs, rejected strategies or measured regressions. Explain what each experiment learns from referenced node IDs; include the shared parent in learnedFrom. Every learnedFrom ID must be present in evidence. Include at least one relevant measured mistake from the visible evidence in learnedFrom whenever failures exist, and explain its lesson alongside relevant successful strategies. Review the compact archive summaries of older failures and strategies as well. Raw history remains on disk and every identified failing check is permanently pinned in the curriculum. Use all prior failures and successful strategies to avoid repeating disproven changes. Prefer the newest competitive frontier to extend successful branches beyond the root. Scores on different benchmark hashes cannot be compared; challenge baselines measure a new suite without proving improvement. Distinguish competing explanations with different changes. Write complete replacement instructions that apply generally across tasks; do not embed task-specific answer code or manipulate evaluation. Do not invent measurements or claim success in advance. Public task prompts and measured outputs are provided; hidden checks/expected answers are not available.\nReturn exactly JSON: {"branches":[{"parentId":"eligible ID","hypothesis":"testable hypothesis","instructions":"full candidate instructions","learnedFrom":["evidence ID"],"diagnosis":"specific observed failure and reasoning","change":"concrete general change","prediction":"falsifiable expected outcome"}]}. No Markdown.\n\nEVIDENCE_JSON:\n${digest}`;
}
function currentUsage(campaign: EvolutionCampaign): void {
  campaign.callsUsed = campaign.calls.length;
  campaign.usage = {
    inputTokens: campaign.calls.reduce(
      (sum, call) => sum + (call.inputTokens || 0),
      0,
    ),
    outputTokens: campaign.calls.reduce(
      (sum, call) => sum + (call.outputTokens || 0),
      0,
    ),
    costUsd: campaign.calls.reduce((sum, call) => sum + (call.costUsd || 0), 0),
    unknownCostCalls: campaign.calls.filter((call) => call.costUsd === null)
      .length,
  };
}
async function execute(
  campaign: EvolutionCampaign,
  progress: EvolutionProgress,
): Promise<EvolutionCampaign> {
  const options = campaign.options;
  const publish = async () => {
    campaign.updatedAt = new Date().toISOString();
    currentUsage(campaign);
    await saveCampaign(campaign);
    await progress(structuredClone(campaign));
  };
  const checkpointControl = async () => {
    const control = await readCampaignControl(campaign.id);
    if (!control) return false;
    campaign.status = control === "pause" ? "paused" : "stopped";
    campaign.selectionReason = `Worker ${campaign.status} at a persisted evaluation boundary.`;
    return true;
  };
  const reserve = async (
    kind: EvolutionCampaign["calls"][number]["kind"],
    taskId: string,
    nodeId: string | null,
  ) => {
    if (campaign.calls.length >= campaign.maxCalls)
      throw new Error("Campaign adapter-call budget exhausted");
    const call = {
      id: randomUUID(),
      kind,
      taskId,
      nodeId,
      round: campaign.round,
      startedAt: new Date().toISOString(),
      completedAt: null,
      status: "reserved",
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      error: null,
    } satisfies EvolutionCampaign["calls"][number];
    campaign.calls.push(call);
    await publish();
    return call.id;
  };
  const finish = async (
    id: string,
    usage: {
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
    } | null,
    error: string | null,
  ) => {
    const call = campaign.calls.find((item) => item.id === id);
    if (!call) throw new Error("Missing reserved campaign call");
    call.status = error ? "failed" : "completed";
    call.completedAt = new Date().toISOString();
    call.error = error;
    call.inputTokens = usage?.inputTokens ?? null;
    call.outputTokens = usage?.outputTokens ?? null;
    call.costUsd = usage?.costUsd ?? null;
    await publish();
  };
  const activeCalls = new Map<string, string>();
  const contextKey = (context: CallContext) =>
    `${context.nodeId}:${context.kind}:${context.taskId}`;
  const controls: RunControls = {
    ...(options.continuous ? { campaignId: campaign.id } : {}),
    beforeCall: async (context) => {
      activeCalls.set(
        contextKey(context),
        await reserve(context.kind, context.taskId, context.nodeId),
      );
    },
    onUsage: async (context, usage) => {
      const id = activeCalls.get(contextKey(context));
      if (!id) throw new Error("Unreserved adapter call");
      await finish(id, usage, null);
    },
    onCallError: async (context, error) => {
      const id = activeCalls.get(contextKey(context));
      if (id) await finish(id, null, error);
    },
  };
  try {
    // Reserved attempts survive crashes and are never silently repeated on resume.
    for (const call of campaign.calls.filter(
      (item) => item.status === "reserved",
    )) {
      call.status = "failed";
      call.completedAt = new Date().toISOString();
      call.error =
        "Worker interrupted after reserving this attempt; usage unknown, no automatic retry.";
    }
    if (campaign.activeNodeId) {
      const interrupted = await getNode(campaign.activeNodeId);
      if (interrupted?.status === "running")
        await saveNode({
          ...interrupted,
          status: "failed",
          completedAt: new Date().toISOString(),
          error:
            "Evolution worker interrupted; incomplete evaluation retained without retry.",
        });
      campaign.activeNodeId = null;
    }
    await publish();
    const baseBenchmark = await loadBenchmark(options.benchmark);
    const regressionBase = campaign.curriculum
      ? await loadBenchmark(campaign.curriculum.baseBenchmarkPath)
      : baseBenchmark;
    let benchmark =
      options.continuous && campaign.curriculum
        ? await loadBenchmark(campaign.curriculum.benchmarkPath)
        : baseBenchmark;
    if (benchmark.hash !== campaign.benchmarkHash)
      throw new Error("Campaign benchmark content changed; resume refused");
    const availableAdapters = await listAdapters();
    if (!availableAdapters.some((adapter) => adapter.id === options.adapterId))
      throw new Error(
        `Unknown adapter: ${options.adapterId}. Register it with adapter add before evolution.`,
      );
    if (
      options.proposerAdapterId !== "codex-proposer" &&
      !availableAdapters.some(
        (adapter) => adapter.id === options.proposerAdapterId,
      )
    )
      throw new Error(
        `Unknown proposer adapter: ${options.proposerAdapterId}. Register it before evolution.`,
      );
    if (await checkpointControl()) {
      await publish();
      return campaign;
    }
    if (!campaign.rootId) {
      if (campaign.maxCalls - campaign.callsUsed < benchmark.tasks.length) {
        campaign.status = options.continuous
          ? "waiting_budget"
          : "budget_exhausted";
        campaign.error =
          "Budget cannot cover the baseline; no model calls started.";
        await publish();
        return campaign;
      }
      const root = await runBenchmark(
        {
          adapterId: options.adapterId,
          domain: options.domain,
          model: options.model,
          harness: options.harness,
          benchmark: options.benchmark,
          hypothesis:
            "Baseline harness before autonomous evidence-driven evolution",
          settings: options.settings,
        },
        async (node) => {
          campaign.rootId = node.id;
          campaign.activeNodeId = node.status === "running" ? node.id : null;
          await publish();
        },
        controls,
      );
      if (!eligible(root))
        throw new Error(
          `Baseline failed: ${root.error || "incomplete evaluation"}`,
        );
    }
    if (!campaign.rootId) throw new Error("Campaign root was not recorded");
    const root = await getNode(campaign.rootId);
    if (!root || !eligible(root))
      throw new Error("Campaign root is missing or invalid");
    if (
      root.config.benchmarkHash !== baseBenchmark.hash ||
      root.config.domain !== options.domain ||
      root.config.model !== options.model ||
      root.config.harness !== options.harness
    )
      throw new Error(
        "Parent must belong to the configured domain/model/harness/benchmark tree",
      );
    if (
      options.continuous &&
      campaign.curriculum?.level === (root.curriculum?.level ?? 0) &&
      !campaign.curriculum.baselineNodeId
    ) {
      campaign.curriculum.baselineNodeId = root.id;
      await publish();
    }
    search: while (
      options.continuous ||
      campaign.completedRounds < options.rounds
    ) {
      if (await checkpointControl()) break;
      campaign.round = campaign.completedRounds + 1;
      if (
        options.continuous &&
        campaign.curriculum &&
        !campaign.curriculum.baselineNodeId &&
        campaign.curriculum.transitionParentId
      ) {
        if (campaign.maxCalls - campaign.callsUsed < benchmark.tasks.length) {
          campaign.status = "waiting_budget";
          campaign.error = `Challenge baseline needs ${benchmark.tasks.length} calls; ${campaign.maxCalls - campaign.callsUsed} remain. Grant calls explicitly to resume.`;
          break;
        }
        const champion = await getNode(campaign.curriculum.transitionParentId);
        if (!champion || !eligible(champion))
          throw new Error("Challenge champion is missing or invalid");
        const challenge = await runBenchmark(
          {
            adapterId: options.adapterId,
            domain: options.domain,
            model: options.model,
            harness: options.harness,
            benchmark: benchmark.sourcePath,
            hypothesis: `Unchanged champion evaluated on harder curriculum level ${campaign.curriculum.level}; this baseline makes no improvement claim`,
            parentId: champion.id,
            settings: champion.config.settings,
          },
          async (node) => {
            campaign.activeNodeId = node.status === "running" ? node.id : null;
            await publish();
          },
          { ...controls, challenge: true },
        );
        if (!eligible(challenge)) {
          campaign.status = "waiting_challenge";
          campaign.error = `Challenge evaluation incomplete: ${challenge.error || "incomplete evaluation"}`;
          campaign.selectionReason =
            "Challenge infrastructure did not produce a complete evaluation. History is checkpointed; no improvement or successful stage completion is claimed.";
          break;
        }
        campaign.curriculum.baselineNodeId = challenge.id;
        campaign.activeNodeId = null;
        await publish();
        continue;
      }
      const tree = await getTree(root.treeId);
      const nodes = tree?.nodes || [root];
      const valid = nodes
        .filter(
          (node) =>
            eligible(node) && node.config.benchmarkHash === benchmark.hash,
        )
        .sort(
          (a, b) =>
            (b.score || 0) - (a.score || 0) ||
            b.createdAt.localeCompare(a.createdAt),
        );
      const champion = valid.find((node) => node.score === 1);
      const existing = campaign.proposals.filter(
        (proposal) => proposal.round === campaign.round,
      );
      if (
        champion &&
        (!options.continuous ||
          (!existing.length &&
            completedSiblingRound(campaign, nodes, benchmark.hash)))
      ) {
        if (!options.continuous || !campaign.curriculum) {
          campaign.status = "saturated";
          campaign.selectionReason =
            "A measured node passed every task. This benchmark cannot establish further score improvement; choose a harder benchmark.";
          break;
        }
        try {
          const pinnedCases = await regressionPins(nodes);
          const generated = await generateCurriculumBenchmark({
            baseBenchmarkPath: campaign.curriculum.baseBenchmarkPath,
            level: campaign.curriculum.level + 1,
            seed: campaign.lineageId || campaign.id,
            pinnedCases,
          });
          const harder = await loadBenchmark(generated.benchmarkPath);
          const retains = (
            taskId: string,
            check: Benchmark["tasks"][number]["cases"][number],
          ) =>
            harder.tasks
              .find((task) => task.id === taskId)
              ?.cases.some(
                (next) => JSON.stringify(next) === JSON.stringify(check),
              );
          const oldCases = new Set(
            benchmark.tasks.flatMap((task) =>
              task.cases.map((check) =>
                JSON.stringify([task.id, check.args, check.expected]),
              ),
            ),
          );
          const hasFreshChecks = harder.tasks.some((task) =>
            task.cases.some(
              (check) =>
                !oldCases.has(
                  JSON.stringify([task.id, check.args, check.expected]),
                ),
            ),
          );
          if (
            harder.hash === benchmark.hash ||
            harder.domain !== benchmark.domain ||
            !hasFreshChecks ||
            regressionBase.tasks.some(
              (task) =>
                harder.tasks.find((item) => item.id === task.id)?.prompt !==
                  task.prompt ||
                task.cases.some((check) => !retains(task.id, check)),
            ) ||
            pinnedCases.some((pin) => !retains(pin.taskId, pin.case))
          )
            throw new Error(
              "No independently checked fresh suite retaining base checks and every observed regression is available",
            );
          campaign.curriculum = {
            ...campaign.curriculum,
            level: campaign.curriculum.level + 1,
            benchmarkPath: harder.sourcePath,
            benchmarkHash: harder.hash,
            benchmarkId: harder.id,
            baselineNodeId: null,
            transitionParentId: champion.id,
          };
          campaign.benchmarkId = harder.id;
          campaign.benchmarkHash = harder.hash;
          campaign.selectionReason = `Level ${campaign.curriculum.level - 1} passed every check. Advancing to independently checked level ${campaign.curriculum.level} with retained regression cases.`;
          benchmark = harder;
          await publish();
          continue;
        } catch (error) {
          campaign.status = "waiting_challenge";
          campaign.error = safeError(error);
          campaign.selectionReason =
            "The current suite is solved. Waiting for a validated harder challenge; evolution has not completed.";
          break;
        }
      }
      if (
        existing.length &&
        (existing.length < 2 ||
          existing.length > 6 ||
          (!options.adaptiveBranches && existing.length !== options.branches))
      )
        throw new Error(
          "Incomplete sibling proposal set retained; refusing a partial round",
        );
      const previousRoundIds = new Set(
        campaign.proposals
          .filter((proposal) => proposal.round === campaign.completedRounds)
          .map((proposal) => proposal.nodeId),
      );
      const currentEvidence = nodes.filter(
        (node) =>
          node.config.benchmarkHash === benchmark.hash &&
          previousRoundIds.has(node.id),
      );
      const branchCount =
        existing.length ||
        (options.adaptiveBranches
          ? adaptiveBranchCount([
              ...valid.slice(0, options.beamWidth),
              ...currentEvidence,
            ])
          : options.branches);
      campaign.branches = branchCount;
      const remaining = options.maxCandidates - campaign.candidateIds.length;
      if (!options.continuous && !existing.length && remaining < branchCount) {
        campaign.selectionReason =
          "Candidate limit reached; no partial sibling round was started.";
        campaign.status = "completed";
        break;
      }
      const callsNeeded =
        (existing.length
          ? existing.filter((proposal) => proposal.nodeId === null).length
          : branchCount) *
          2 *
          benchmark.tasks.length +
        (existing.length ? 0 : 1);
      if (campaign.maxCalls - campaign.callsUsed < callsNeeded) {
        campaign.status = options.continuous
          ? "waiting_budget"
          : "budget_exhausted";
        campaign.error = `Next sibling round needs ${callsNeeded} adapter-call attempts; ${campaign.maxCalls - campaign.callsUsed} remain. No calls for this round started. Grant calls explicitly to resume.`;
        break;
      }
      if (!existing.length) {
        if (
          campaign.proposerRuns.some(
            (run) => run.round === campaign.round && !providerLimit(run.error),
          )
        )
          throw new Error(
            "Interrupted or invalid proposer response retained; no automatic retry. Start a new campaign from a completed node.",
          );
        const parents = valid.slice(0, options.beamWidth);
        campaign.selectionReason = `Ranked completed nodes by measured score, then recent evidence; proposer chooses one of ${parents.length} beam parents for ${branchCount} sibling experiments.`;
        const digest = evidenceDigest(
          benchmark,
          nodes,
          parents,
          branchCount,
          campaign.round,
          options.continuous,
        );
        const run: EvolutionCampaign["proposerRuns"][number] = {
          round: campaign.round,
          digest,
          digestHash: createHash("sha256").update(digest).digest("hex"),
          output: null,
          error: null,
        };
        campaign.proposerRuns.push(run);
        await publish();
        const adapter =
          options.proposerAdapterId === "codex-proposer"
            ? proposerManifest
            : availableAdapters.find(
                (item) => item.id === options.proposerAdapterId,
              );
        if (!adapter)
          throw new Error(
            `Unknown proposer adapter: ${options.proposerAdapterId}`,
          );
        const configuration: RunConfig = {
          ...root.config,
          benchmarkId: benchmark.id,
          benchmarkHash: benchmark.hash,
          benchmarkPath: benchmark.sourcePath,
          adapterId: adapter.id,
          model: options.proposerModel || options.model,
          settings: {
            ...options.settings,
            instructions: "Return only experiment proposal JSON.",
            responseFormat: "json",
          },
        };
        const cwd = await mkdtemp(path.join(tmpdir(), "loopbench-proposer-"));
        const callId = await reserve(
          "proposal",
          `round-${campaign.round}`,
          null,
        );
        try {
          const response = await callAdapter(
            adapter,
            {
              id: `propose-round-${campaign.round}`,
              prompt: proposalPrompt(digest, branchCount),
            },
            configuration,
            cwd,
          );
          await finish(callId, response, null);
          run.output = response.output;
          const source = response.output
            .trim()
            .replace(/^```(?:json)?\s*\n/, "")
            .replace(/\n```\s*$/, "");
          const proposals = z
            .object({ branches: z.array(proposalSchema).length(branchCount) })
            .strict()
            .parse(JSON.parse(source)).branches;
          const visible = z
            .object({ evidence: z.array(z.object({ id: z.string() })) })
            .parse(JSON.parse(digest));
          const knownIds = new Set(visible.evidence.map((node) => node.id));
          const mistakeIds = new Set(
            nodes
              .filter(
                (node) =>
                  knownIds.has(node.id) &&
                  (node.status === "rejected" ||
                    node.status === "failed" ||
                    (options.continuous &&
                      node.tasks.some((task) => !task.passed))),
              )
              .map((node) => node.id),
          );
          const parentIds = new Set(parents.map((node) => node.id));
          if (
            new Set(proposals.map((proposal) => proposal.parentId)).size !== 1
          )
            throw new Error(
              "Proposer must choose one shared parent for sibling experiments",
            );
          if (
            new Set(proposals.map((proposal) => proposal.instructions.trim()))
              .size !== branchCount
          )
            throw new Error("Sibling instructions must be distinct");
          for (const proposal of proposals) {
            if (!parentIds.has(proposal.parentId))
              throw new Error("Proposer selected an ineligible parent");
            if (
              !proposal.learnedFrom.includes(proposal.parentId) ||
              proposal.learnedFrom.some((id) => !knownIds.has(id))
            )
              throw new Error(
                "Proposal learning references must identify actual evidence and include its parent",
              );
            if (
              mistakeIds.size &&
              !proposal.learnedFrom.some((id) => mistakeIds.has(id))
            )
              throw new Error(
                "Proposal must reference a lesson from an actual rejected or failed node",
              );
            if (
              nodes.some(
                (node) =>
                  node.parentId === proposal.parentId &&
                  node.config.settings.instructions === proposal.instructions,
              )
            )
              throw new Error(
                "Proposer repeated an already measured instruction change",
              );
          }
          campaign.proposals.push(
            ...proposals.map((proposal) => ({
              ...proposal,
              round: campaign.round,
              nodeId: null,
            })),
          );
          await publish();
        } catch (error) {
          run.error = safeError(error);
          const call = campaign.calls.find((item) => item.id === callId);
          if (call?.status === "reserved")
            await finish(callId, null, run.error);
          throw error;
        } finally {
          await rm(cwd, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 100,
          });
        }
      }
      for (const proposal of campaign.proposals.filter(
        (item) => item.round === campaign.round,
      )) {
        if (proposal.nodeId) continue;
        if (await checkpointControl()) break search;
        const parent = await getNode(proposal.parentId);
        if (!parent || !eligible(parent))
          throw new Error("Proposed parent is no longer available");
        const candidate = await runBenchmark(
          {
            adapterId: options.adapterId,
            domain: options.domain,
            model: options.model,
            harness: options.harness,
            benchmark: benchmark.sourcePath,
            hypothesis: proposal.hypothesis,
            parentId: parent.id,
            settings: {
              ...parent.config.settings,
              ...options.settings,
              instructions: proposal.instructions,
            },
            learning: {
              learnedFrom: proposal.learnedFrom,
              diagnosis: proposal.diagnosis,
              change: proposal.change,
              prediction: proposal.prediction,
              proposer: `${options.proposerAdapterId}:${options.proposerModel || options.model}`,
              round: campaign.round,
            },
          },
          async (node) => {
            proposal.nodeId = node.id;
            if (!campaign.candidateIds.includes(node.id))
              campaign.candidateIds.push(node.id);
            campaign.activeNodeId = node.status === "running" ? node.id : null;
            await publish();
          },
          controls,
        );
        if (options.continuous && providerLimit(candidate.error)) {
          campaign.status = "paused";
          campaign.error = candidate.error;
          campaign.selectionReason =
            "Provider usage limit reached. Remaining sibling proposals and spent attempts are saved. Restore inference access, then explicitly resume; no provider retry runs automatically.";
          break search;
        }
      }
      campaign.completedRounds = campaign.round;
      await publish();
    }
    if (campaign.status === "running") {
      campaign.status = "completed";
      campaign.selectionReason =
        "Requested sibling rounds completed. Acceptance reflects measured paired task scores only.";
    }
  } catch (error) {
    campaign.error = safeError(error);
    campaign.status =
      options.continuous && providerLimit(campaign.error) ? "paused" : "failed";
    if (campaign.status === "paused")
      campaign.selectionReason =
        "Provider usage limit reached. Evidence and failed proposal attempts are retained. Restore inference access, then explicitly resume; no retry runs automatically.";
  }
  campaign.activeNodeId = null;
  await publish();
  return campaign;
}
export async function evolve(
  raw: EvolutionOptions,
  progress: EvolutionProgress = () => {},
): Promise<EvolutionCampaign> {
  const options = evolutionOptionsSchema.parse({
    ...raw,
    adaptiveBranches:
      raw.adaptiveBranches ??
      (raw.continuous === true && raw.branches === undefined),
  });
  const benchmark = await loadBenchmark(options.benchmark);
  options.benchmark = benchmark.sourcePath;
  if (benchmark.domain !== options.domain)
    throw new Error("Benchmark domain does not match evolution domain");
  if (
    Object.keys(options.settings).some(
      (key) =>
        /key|token$|secret|password|authorization/i.test(key) &&
        key !== "maxTokens",
    )
  )
    throw new Error("Credentials must be passed through the environment");
  const now = new Date().toISOString();
  const id = randomUUID();
  const parent = options.parentId ? await getNode(options.parentId) : null;
  const metadata = options.continuous
    ? z
        .object({
          curriculum: z
            .object({
              baseBenchmarkPath: z.string(),
              baseBenchmarkHash: z.string(),
              level: z.number().int().positive(),
            })
            .optional(),
        })
        .parse(JSON.parse(await readFile(benchmark.sourcePath, "utf8")))
        .curriculum
    : undefined;
  const originalBasePath = metadata?.baseBenchmarkPath || benchmark.sourcePath;
  if (
    metadata &&
    (await loadBenchmark(originalBasePath)).hash !== metadata.baseBenchmarkHash
  )
    throw new Error("Original curriculum benchmark changed; adoption refused");
  const campaign: EvolutionCampaign = {
    id,
    status: "running",
    createdAt: now,
    updatedAt: now,
    rootId: options.parentId || null,
    candidateIds: [],
    round: 0,
    completedRounds: 0,
    totalRounds: options.rounds,
    branches: options.branches,
    beamWidth: options.beamWidth,
    maxCandidates: options.maxCandidates,
    maxCalls: options.maxCalls,
    callsUsed: 0,
    benchmarkId: benchmark.id,
    benchmarkHash: benchmark.hash,
    domain: options.domain,
    model: options.model,
    adapterId: options.adapterId,
    harness: options.harness,
    error: null,
    selectionReason: options.continuous
      ? "Preparing persistent frontier search and independently checked curriculum challenges."
      : "Preparing measured baseline and bounded autonomous sibling experiments.",
    activeNodeId: null,
    options,
    proposals: [],
    calls: [],
    proposerRuns: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, unknownCostCalls: 0 },
    ...(options.continuous
      ? {
          lineageId: parent?.config.lineageId || parent?.treeId || id,
          curriculum: {
            level: parent?.curriculum?.level ?? metadata?.level ?? 0,
            benchmarkPath: benchmark.sourcePath,
            benchmarkHash: benchmark.hash,
            benchmarkId: benchmark.id,
            baseBenchmarkPath: originalBasePath,
            baselineNodeId: parent?.id || null,
            transitionParentId: null,
          },
        }
      : {}),
  };
  await saveCampaign(campaign);
  return withCampaignLock(campaign.id, () => execute(campaign, progress));
}
export async function resumeEvolution(
  id: string,
  progress: EvolutionProgress = () => {},
  additionalCalls = 0,
): Promise<EvolutionCampaign> {
  z.number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .parse(additionalCalls);
  return withCampaignLock(id, async () => {
    const campaign = await getCampaign(id);
    if (!campaign) throw new Error("Campaign not found");
    if (!campaign.options.continuous && campaign.status !== "running")
      return campaign;
    if (campaign.options.continuous) {
      if (additionalCalls > 0) {
        z.number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER)
          .parse(campaign.maxCalls + additionalCalls);
        campaign.maxCalls += additionalCalls;
        campaign.options.maxCalls = campaign.maxCalls;
        campaign.budgetGrants = [
          ...(campaign.budgetGrants || []),
          {
            additionalCalls,
            maxCalls: campaign.maxCalls,
            grantedAt: new Date().toISOString(),
          },
        ];
      }
      await clearCampaignControl(id);
      campaign.status = "running";
      campaign.error = null;
      await saveCampaign(campaign);
    }
    return execute(campaign, progress);
  });
}
export async function controlEvolution(
  id: string,
  action: "pause" | "stop",
): Promise<EvolutionCampaign> {
  await requestCampaignControl(id, action);
  const campaign = await getCampaign(id);
  if (!campaign) throw new Error("Campaign not found");
  if (campaign.status === "running") return campaign;
  return withCampaignLock(id, async () => {
    const latest = await getCampaign(id);
    if (!latest) throw new Error("Campaign not found");
    latest.status = action === "pause" ? "paused" : "stopped";
    latest.updatedAt = new Date().toISOString();
    latest.selectionReason = `Explicit ${action} requested; persistent history and remaining budget retained.`;
    await saveCampaign(latest);
    return latest;
  });
}
