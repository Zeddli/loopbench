import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  adaptiveBranchCount,
  controlEvolution,
  evolve,
  resumeEvolution,
} from "../core/evolution";
import { getCampaign } from "../core/campaigns";
import { loadBenchmark } from "../core/benchmarks";
import { runBenchmark } from "../core/runner";
import {
  addAdapter,
  getNode,
  getTree,
  listTrees,
  projectRoot,
  treeIdentity,
} from "../core/store";

// These programs are isolated process fixtures. Every result still goes through
// the production adapter protocol and independent JavaScript evaluator.
const processFixture = String.raw`
let input = ''; for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if ((request.config.settings.quotaCandidate === 'true' && request.config.settings.instructions?.startsWith('process-fixture-trial-')) || (request.config.settings.quotaProposer === 'true' && request.task.id.startsWith('propose-round-'))) {
  process.stderr.write("Provider: You've hit your usage limit."); process.exit(1);
}
let output;
if (request.task.id.startsWith('propose-round-')) {
  const digest = JSON.parse(request.task.prompt.split('EVIDENCE_JSON:\n')[1]);
  const parent = digest.evidence.find(node => node.id === digest.eligibleParentIds[0]);
  const failures = digest.evidence.filter(node => ['failed','rejected'].includes(node.status) || node.tasks.some(task => !task.passed)).map(node => node.id);
  const learnedFrom = [...new Set([parent.id, ...failures])];
  output = JSON.stringify({ branches: Array.from({length:digest.branches}, (_,index)=>({
    parentId: parent.id, hypothesis: 'Isolated measured trial '+digest.round+'/'+index,
    instructions: 'process-fixture-trial-'+digest.round+'-'+index,
    learnedFrom: request.config.settings.invalidSecond === 'true' && index === 1 ? ['invented-id'] : learnedFrom,
    diagnosis: 'Review every recorded failure: '+failures.join(','),
    change: 'Distinct fixture trial '+index, prediction: 'Measure the next paired result'
  }))});
} else {
  output = request.config.settings.mode === 'base-only' && request.task.id === 'weighted-lru'
    ? 'module.exports = () => ({reads:[],entries:[]});'
    : 'module.exports = () => null;';
}
process.stdout.write(JSON.stringify({output,inputTokens:1,outputTokens:2,costUsd:0}));
`;

test("adaptive width uses distinct failed tasks, includes paired evidence and stays between two and six", () => {
  const failure = (taskId: string) => ({
    taskId,
    passed: false,
    durationMs: 1,
    output: "",
    error: "Measured mismatch",
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  });
  assert.equal(adaptiveBranchCount([{ tasks: [], comparison: null }]), 2);
  assert.equal(
    adaptiveBranchCount([
      { tasks: [failure("a"), failure("a")], comparison: null },
    ]),
    3,
  );
  assert.equal(
    adaptiveBranchCount([
      {
        tasks: [failure("a")],
        comparison: {
          parentScore: 0,
          candidateScore: 0,
          delta: 0,
          method: "paired",
          parentTasks: [failure("b")],
          reason: "Measured",
        },
      },
    ]),
    4,
  );
  assert.equal(
    adaptiveBranchCount([
      {
        tasks: Array.from({ length: 10 }, (_, index) =>
          failure(`task-${index}`),
        ),
        comparison: null,
      },
    ]),
    6,
  );
});

test("continuous process campaigns preserve lineage, checkpoints, budgets and stage comparisons", async (context) => {
  const temporary = await mkdtemp(
    path.join(projectRoot, ".loopbench-test-continuous-"),
  );
  const previous = process.env.LOOPBENCH_HOME;
  process.env.LOOPBENCH_HOME = temporary;
  try {
    const adapterPath = path.join(temporary, "continuous-fixture.mjs");
    await writeFile(adapterPath, processFixture);
    await addAdapter({
      id: "continuous-fixture",
      name: "Isolated continuous process fixture",
      command: process.execPath,
      args: [adapterPath],
      protocol: "loopbench.task.v1",
      timeoutMs: 15000,
    });
    const simplePath = path.join(temporary, "simple.json");
    await writeFile(
      simplePath,
      JSON.stringify({
        id: "continuous-small-fixture",
        name: "Isolated one-task fixture",
        domain: "coding",
        tasks: [
          {
            id: "increment",
            prompt: "Export a function returning value + 1.",
            cases: [{ label: "increment", args: [2], expected: 3 }],
          },
        ],
      }),
    );
    const options = {
      adapterId: "continuous-fixture",
      proposerAdapterId: "continuous-fixture",
      domain: "coding",
      model: "isolated-process-fixture-only",
      harness: "continuous-process-fixture",
      benchmark: simplePath,
      branches: 3,
      beamWidth: 2,
    };

    await context.test(
      "adaptive sibling counts follow current failures and cannot exceed six",
      async () => {
        const campaign = await evolve({
          ...options,
          continuous: true,
          branches: undefined,
          maxCalls: 8,
        });
        assert.equal(
          campaign.status,
          "waiting_budget",
          campaign.error || undefined,
        );
        assert.equal(campaign.options.adaptiveBranches, true);
        assert.equal(
          campaign.branches,
          3,
          "One failing task creates three competing explanations",
        );
        assert.equal(campaign.completedRounds, 1);
        assert.equal(campaign.candidateIds.length, 3);
        assert.equal(
          new Set(campaign.proposals.map((proposal) => proposal.parentId)).size,
          1,
        );
        await assert.rejects(evolve({ ...options, branches: 7 }), /6/);
      },
    );

    await context.test(
      "adopts a finite real tree and grows beyond twelve rounds with three siblings at each depth",
      async () => {
        const finite = await evolve({
          ...options,
          rounds: 1,
          maxCandidates: 3,
          maxCalls: 8,
        });
        assert.equal(finite.status, "completed", finite.error || undefined);
        const seed = await getNode(finite.candidateIds.at(-1) || "");
        assert.ok(seed);
        const originalTree = await getTree(seed.treeId);
        assert.ok(originalTree);
        const originalTreeCount = (await listTrees()).length;
        const oldFiles = await Promise.all(
          originalTree.nodes.map((node) =>
            readFile(path.join(temporary, "nodes", `${node.id}.json`), "utf8"),
          ),
        );
        const campaign = await evolve({
          ...options,
          continuous: true,
          parentId: seed.id,
          rounds: 1,
          maxCandidates: 2,
          maxCalls: 84,
        });
        assert.equal(
          campaign.status,
          "waiting_budget",
          campaign.error || undefined,
        );
        assert.equal(campaign.completedRounds, 12);
        assert.equal(campaign.candidateIds.length, 36);
        assert.equal(campaign.callsUsed, 84);
        assert.equal(campaign.maxCalls, 84);
        assert.equal(campaign.lineageId, seed.treeId);
        assert.equal(campaign.rootId, seed.id);
        const tree = await getTree(seed.treeId);
        assert.ok(tree);
        const byId = new Map(tree.nodes.map((node) => [node.id, node]));
        let deepest = 0;
        for (const node of tree.nodes) {
          let depth = 0;
          let cursor = node;
          while (cursor.parentId) {
            const parent = byId.get(cursor.parentId);
            assert.ok(parent);
            depth++;
            cursor = parent;
          }
          deepest = Math.max(deepest, depth);
        }
        assert.ok(deepest >= 13, `Measured depth was ${deepest}`);
        for (let round = 1; round <= 12; round++) {
          const siblings = campaign.proposals.filter(
            (proposal) => proposal.round === round,
          );
          assert.equal(siblings.length, 3);
          assert.equal(
            new Set(siblings.map((proposal) => proposal.parentId)).size,
            1,
          );
        }
        for (const [index, node] of originalTree.nodes.entries())
          assert.equal(
            await readFile(
              path.join(temporary, "nodes", `${node.id}.json`),
              "utf8",
            ),
            oldFiles[index],
          );
        const checkpoint = await resumeEvolution(campaign.id);
        assert.equal(checkpoint.callsUsed, 84);
        assert.equal(checkpoint.maxCalls, 84);
        assert.equal(checkpoint.status, "waiting_budget");
        const resumed = await resumeEvolution(campaign.id, () => {}, 7);
        assert.equal(resumed.id, campaign.id);
        assert.equal(resumed.lineageId, campaign.lineageId);
        assert.equal(
          resumed.completedRounds,
          13,
          JSON.stringify({
            status: resumed.status,
            error: resumed.error,
            callsUsed: resumed.callsUsed,
            maxCalls: resumed.maxCalls,
            lastCall: resumed.calls.at(-1),
          }),
        );
        assert.equal(resumed.callsUsed, 91);
        assert.equal(resumed.maxCalls, 91);
        assert.deepEqual(
          resumed.candidateIds.slice(0, 36),
          campaign.candidateIds,
        );
        assert.equal(resumed.budgetGrants?.[0]?.additionalCalls, 7);
        assert.equal(resumed.status, "waiting_budget");
        const latest = await getNode(resumed.candidateIds.at(-1) || "");
        assert.ok(latest);
        assert.ok(latest.learning?.learnedFrom.includes(latest.parentId || ""));
        assert.ok((latest.learning?.learnedFrom.length || 0) >= 2);
        const lastDigest = JSON.parse(
          resumed.proposerRuns.at(-1)?.digest || "{}",
        );
        assert.equal(
          lastDigest.archive.totalNodes,
          originalTree.nodes.length + campaign.candidateIds.length,
        );
        assert.ok(lastDigest.archive.omittedNodes > 0);
        assert.ok(lastDigest.evidence.length <= 40);
        assert.ok(lastDigest.archive.failedObservations > 0);
        assert.ok((resumed.proposerRuns.at(-1)?.digest.length || 0) <= 120000);
        assert.ok(
          resumed.calls.every((call) => call.status === "completed"),
          JSON.stringify(
            resumed.calls.filter((call) => call.status !== "completed"),
          ),
        );
        assert.equal((await listTrees()).length, originalTreeCount);
        const wrongDomain = await evolve({
          ...options,
          continuous: true,
          parentId: seed.id,
          model: "wrong-model",
          maxCalls: 100,
        });
        assert.equal(wrongDomain.status, "failed");
        assert.equal(wrongDomain.callsUsed, 0);
        assert.match(
          wrongDomain.error || "",
          /configured domain\/model\/harness\/benchmark tree/,
        );
        const paused = await controlEvolution(resumed.id, "pause");
        assert.equal(paused.status, "paused");
        const stopped = await controlEvolution(resumed.id, "stop");
        assert.equal(stopped.status, "stopped");
        assert.equal((await getCampaign(resumed.id))?.callsUsed, 91);
        const afterStop = await resumeEvolution(resumed.id);
        assert.equal(afterStop.status, "waiting_budget");
        assert.equal(afterStop.callsUsed, 91);
      },
    );

    await context.test(
      "a full score first evaluates sibling alternatives before a challenge and resumes branching on that suite",
      async () => {
        const canonical = await loadBenchmark("coding-adversarial-v1");
        const examples: Record<string, { args: unknown[]; expected: unknown }> =
          {
            "strict-csv": { args: ['"unclosed'], expected: null },
            "exact-money-sum": { args: [["1e2"]], expected: null },
            "json-pointer-patch": {
              args: [{}, [{ op: "remove", path: "/missing" }]],
              expected: null,
            },
            "weighted-lru": {
              args: [{ capacity: 0, operations: [] }],
              expected: { reads: [], entries: [] },
            },
            "timezone-interval-union": {
              args: [[["invalid", "invalid"]]],
              expected: null,
            },
            "dependency-layers": {
              args: [[{ id: "cycle", deps: ["cycle"] }]],
              expected: null,
            },
          };
        const basePath = path.join(
          temporary,
          "canonical-contract-small-base.json",
        );
        await writeFile(
          basePath,
          JSON.stringify({
            id: "trusted-contract-small-base",
            name: "Isolated canonical-contract fixture",
            domain: "coding",
            tasks: canonical.tasks.map((task) => ({
              ...task,
              cases: [{ label: "base contract case", ...examples[task.id] }],
            })),
          }),
        );
        const campaign = await evolve({
          ...options,
          continuous: true,
          benchmark: basePath,
          settings: { mode: "base-only" },
          maxCalls: 49,
        });
        assert.equal(
          campaign.status,
          "waiting_budget",
          campaign.error || undefined,
        );
        assert.equal(campaign.curriculum?.level, 1);
        assert.equal(campaign.callsUsed, 49);
        assert.equal(campaign.completedRounds, 1);
        assert.equal(campaign.candidateIds.length, 3);
        const baseHash = (await loadBenchmark(basePath)).hash;
        for (const id of campaign.candidateIds) {
          const alternative = await getNode(id);
          assert.ok(alternative);
          assert.equal(alternative.config.benchmarkHash, baseHash);
          assert.equal(alternative.parentId, campaign.rootId);
          assert.equal(
            alternative.status,
            "rejected",
            "Ties on a solved suite remain real evaluated branches",
          );
        }
        assert.equal(
          campaign.calls.filter((call) => call.kind === "challenge").length,
          6,
        );
        const root = await getNode(campaign.rootId || "");
        assert.ok(root);
        const challenge = await getNode(
          campaign.curriculum?.baselineNodeId || "",
        );
        assert.ok(challenge);
        assert.equal(root.score, 1);
        assert.equal(challenge.score, 0);
        assert.equal(challenge.event, "challenge");
        assert.equal(challenge.status, "baseline");
        assert.equal(challenge.comparison, null);
        assert.ok(campaign.candidateIds.includes(challenge.parentId || ""));
        assert.equal(challenge.treeId, root.treeId);
        assert.equal(treeIdentity(challenge.config), root.treeId);
        assert.notEqual(
          root.config.benchmarkHash,
          challenge.config.benchmarkHash,
        );
        assert.deepEqual(
          challenge.config.settings,
          (await getNode(challenge.parentId || ""))?.config.settings,
        );
        const resumed = await resumeEvolution(campaign.id, () => {}, 37);
        assert.equal(
          resumed.status,
          "waiting_budget",
          resumed.error || undefined,
        );
        assert.equal(resumed.completedRounds, 2);
        assert.equal(resumed.callsUsed, 86);
        for (const id of resumed.candidateIds.slice(3)) {
          const candidate = await getNode(id);
          assert.ok(candidate);
          const parent = await getNode(candidate.parentId || "");
          assert.ok(parent);
          assert.equal(
            candidate.config.benchmarkHash,
            parent.config.benchmarkHash,
          );
          assert.equal(candidate.curriculum?.level, 1);
          assert.equal(candidate.comparison?.parentTasks.length, 6);
          assert.ok(candidate.learning?.learnedFrom.includes(challenge.id));
        }
        await assert.rejects(
          runBenchmark({
            ...options,
            benchmark: challenge.config.benchmarkPath || "",
            parentId: root.id,
            hypothesis: "Untrusted cross-suite comparison",
          }),
          /same.*tree/,
        );
        const adopted = await evolve({
          ...options,
          continuous: true,
          benchmark: challenge.config.benchmarkPath || "",
          parentId: challenge.id,
          settings: { mode: "base-only" },
          maxCalls: 1,
        });
        assert.equal(adopted.curriculum?.baseBenchmarkPath, basePath);
        assert.equal(adopted.curriculum?.level, 1);
        assert.equal(adopted.lineageId, campaign.lineageId);
        assert.equal(adopted.callsUsed, 0);
        const manual = await runBenchmark({
          ...options,
          benchmark: challenge.config.benchmarkPath || "",
          parentId: challenge.id,
          settings: { mode: "base-only" },
          hypothesis: "Manual same-suite continuation",
        });
        assert.equal(manual.treeId, challenge.treeId);
        assert.equal(manual.config.lineageId, challenge.config.lineageId);
        assert.deepEqual(manual.curriculum, challenge.curriculum);
        assert.equal(manual.event, "evaluation");
        assert.equal(
          manual.config.benchmarkHash,
          challenge.config.benchmarkHash,
        );
        assert.equal(manual.comparison?.parentTasks.length, 6);
        assert.equal(manual.status, "rejected");
      },
    );

    await context.test(
      "pause preserves unstarted siblings and invalid later branches never commit a partial round",
      async () => {
        let requested = false;
        const paused = await evolve(
          { ...options, continuous: true, maxCalls: 8 },
          async (current) => {
            if (
              !requested &&
              current.proposals.length === 3 &&
              current.candidateIds.length === 0
            ) {
              requested = true;
              await controlEvolution(current.id, "pause");
            }
          },
        );
        assert.equal(paused.status, "paused");
        assert.equal(paused.callsUsed, 2);
        assert.equal(paused.candidateIds.length, 0);
        assert.equal(paused.proposals.length, 3);
        assert.equal(paused.completedRounds, 0);
        const resumed = await resumeEvolution(paused.id);
        assert.equal(resumed.status, "waiting_budget");
        assert.equal(resumed.callsUsed, 8);
        assert.equal(resumed.candidateIds.length, 3);
        assert.equal(resumed.completedRounds, 1);
        assert.equal(resumed.proposerRuns.length, 1);
        const invalid = await evolve({
          ...options,
          continuous: true,
          maxCalls: 8,
          settings: { invalidSecond: "true" },
        });
        assert.equal(invalid.status, "failed");
        assert.equal(invalid.callsUsed, 2);
        assert.equal(invalid.proposals.length, 0);
        assert.equal(invalid.candidateIds.length, 0);
        const retry = await resumeEvolution(invalid.id);
        assert.equal(retry.status, "waiting_budget");
        assert.equal(retry.callsUsed, 2);
        assert.equal(retry.proposals.length, 0);
        const granted = await resumeEvolution(invalid.id, () => {}, 1);
        assert.equal(granted.status, "failed");
        assert.equal(granted.callsUsed, 2);
        assert.equal(granted.proposals.length, 0);
      },
    );

    await context.test(
      "provider limits checkpoint pending siblings and only explicit resume spends another attempt",
      async () => {
        const limited = await evolve({
          ...options,
          continuous: true,
          maxCalls: 20,
          settings: { quotaCandidate: "true" },
        });
        assert.equal(limited.status, "paused");
        assert.match(limited.error || "", /usage limit/);
        assert.equal(limited.callsUsed, 4);
        assert.equal(limited.completedRounds, 0);
        assert.equal(limited.candidateIds.length, 1);
        assert.equal(
          limited.proposals.filter((proposal) => !proposal.nodeId).length,
          2,
        );
        const continued = await resumeEvolution(limited.id);
        assert.equal(continued.status, "paused");
        assert.equal(continued.callsUsed, 6);
        assert.equal(continued.candidateIds.length, 2);
        const proposerLimited = await evolve({
          ...options,
          continuous: true,
          maxCalls: 20,
          settings: { quotaProposer: "true" },
        });
        assert.equal(proposerLimited.status, "paused");
        assert.equal(proposerLimited.callsUsed, 2);
        assert.equal(proposerLimited.proposerRuns.length, 1);
        const retried = await resumeEvolution(proposerLimited.id);
        assert.equal(retried.status, "paused");
        assert.equal(retried.callsUsed, 3);
        assert.equal(retried.proposerRuns.length, 2);
        assert.equal(
          retried.proposerRuns[0]?.error,
          proposerLimited.proposerRuns[0]?.error,
        );
      },
    );

    await context.test(
      "solved unsupported contracts checkpoint while unknown adapters fail before charging",
      async () => {
        const solvedPath = path.join(temporary, "solved-unsupported.json");
        await writeFile(
          solvedPath,
          JSON.stringify({
            id: "solved-unsupported",
            name: "Solved fixture",
            domain: "coding",
            tasks: [
              {
                id: "unsupported",
                prompt: "Export a function returning null.",
                cases: [{ args: [], expected: null }],
              },
            ],
          }),
        );
        const solved = await evolve({
          ...options,
          benchmark: solvedPath,
          continuous: true,
          maxCalls: 10,
        });
        assert.equal(solved.status, "waiting_challenge");
        assert.equal(solved.callsUsed, 8);
        assert.equal(solved.proposerRuns.length, 1);
        assert.equal(solved.candidateIds.length, 3);
        assert.equal((await resumeEvolution(solved.id)).callsUsed, 8);
        for (const invalid of [
          { adapterId: "missing-task" },
          { proposerAdapterId: "missing-proposer" },
        ]) {
          const failed = await evolve({
            ...options,
            ...invalid,
            continuous: true,
            maxCalls: 100,
          });
          assert.equal(failed.status, "failed");
          assert.equal(failed.callsUsed, 0);
          assert.equal(failed.rootId, null);
          assert.match(failed.error || "", /Unknown.*adapter/);
        }
      },
    );
  } finally {
    if (previous === undefined) delete process.env.LOOPBENCH_HOME;
    else process.env.LOOPBENCH_HOME = previous;
    await rm(temporary, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});
