import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { addAdapter, getNode, listAdapters, listTrees } from "../core/store";
import { listBenchmarks } from "../core/benchmarks";
import { runBenchmark } from "../core/runner";
import { controlEvolution, evolve, resumeEvolution } from "../core/evolution";
import { listCampaigns, getCampaign } from "../core/campaigns";

const help = `LoopBench: persistent, real local evaluations

Commands:
  evolve --continuous --adapter ID --domain coding --model MODEL --harness NAME --benchmark ID_OR_PATH [--parent NODE_ID] [--branches 3] [--beam-width 2] [--max-calls 100] [--proposer-adapter ID] [--proposer-model MODEL] [--instructions TEXT] [--setting KEY=VALUE ...]
  evolve --resume CAMPAIGN_ID [--grant-calls ADDITIONAL_CALLS]
  resume CAMPAIGN_ID [--grant-calls ADDITIONAL_CALLS]
  pause CAMPAIGN_ID
  stop CAMPAIGN_ID
  evolve --finite --adapter ID --domain coding --model MODEL --harness NAME --benchmark ID_OR_PATH [--rounds 2] [--branches 2] [--max-candidates 4] [--max-calls 100]
  run --adapter ID --domain coding --model MODEL --harness NAME --benchmark ID_OR_PATH --hypothesis TEXT [--parent NODE_ID] [--instructions TEXT] [--setting KEY=VALUE ...]
  campaigns
  campaign CAMPAIGN_ID
  adapter add MANIFEST.json
  adapters
  benchmark list
  list
  digest
  inspect NODE_ID

Continuous evolution retains one campaign and tree across depth, sibling rounds and challenge levels. Each round evaluates 2–6 distinct sibling changes from one shared parent. By default, width is two plus the number of distinct failed tasks in the current frontier and recent round, capped at six. --branches N fixes width to an integer from 2 to 6. A full score must finish a sibling round on that suite before requesting an independently checked fresh challenge with permanent base cases and observed failure pins. Other old generated cases rotate in a bounded window. Unsupported contracts wait for a verified extension. Continuous mode ignores rounds/max-candidates limits and checkpoints at its explicit adapter-call allowance. Resume does not increase that allowance unless --grant-calls is supplied. Pause, stop and signals checkpoint after the current node finishes; unstarted sibling proposals survive resumption.
The evolve CLI defaults to continuous mode. Use --finite for bounded rounds and candidate limits. Built-in suites are coding-functions-v1 and coding-adversarial-v1, which has six task contracts and 64 checks. Every reported candidate improvement is a paired same-suite measurement; challenge baselines never imply improvement. No model calls are retried implicitly after a crash.
Credentials come from the environment. Runs write to LOOPBENCH_HOME or .loopbench.
`;
const print = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
async function main(): Promise<void> {
  let [command, ...args] = process.argv.slice(2);
  if (command === "resume" || command === "pause" || command === "stop") {
    if (!args[0]) throw new Error(`Missing campaign ID for ${command}`);
    args = [`--${command}`, args[0], ...args.slice(1)];
    command = "evolve";
  }
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(help);
    return;
  }
  if (command === "adapters") {
    print(await listAdapters());
    return;
  }
  if (command === "campaigns") {
    print(await listCampaigns());
    return;
  }
  if (command === "campaign" && args[0]) {
    const campaign = await getCampaign(args[0]);
    if (!campaign) throw new Error("Campaign not found");
    print(campaign);
    return;
  }
  if (command === "benchmark" && args[0] === "list") {
    print(await listBenchmarks());
    return;
  }
  if (command === "adapter" && args[0] === "add" && args[1]) {
    const filename = path.resolve(args[1]);
    print(
      await addAdapter(
        JSON.parse(await readFile(filename, "utf8")),
        path.dirname(filename),
      ),
    );
    return;
  }
  if (command === "inspect" && args[0]) {
    const node = await getNode(args[0]);
    if (!node) throw new Error("Node not found");
    print(node);
    return;
  }
  if (command === "list" || command === "digest") {
    const trees = await listTrees();
    print(
      trees.map((tree) => ({
        id: tree.id,
        domain: tree.domain,
        model: tree.model,
        harness: tree.harness,
        benchmarkId: tree.benchmarkId,
        nodes: tree.nodes.map((node) => ({
          id: node.id,
          parentId: node.parentId,
          status: node.status,
          score: node.score,
          hypothesis: node.hypothesis,
          completedTasks: node.tasks.length,
          totalTasks: node.totalTasks,
        })),
        updatedAt: tree.updatedAt,
      })),
    );
    return;
  }
  if (command !== "run" && command !== "evolve")
    throw new Error(`Unknown command: ${command}\n${help}`);
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      adapter: { type: "string" },
      domain: { type: "string" },
      model: { type: "string" },
      harness: { type: "string" },
      benchmark: { type: "string" },
      hypothesis: { type: "string" },
      parent: { type: "string" },
      instructions: { type: "string" },
      setting: { type: "string", multiple: true },
      rounds: { type: "string" },
      branches: { type: "string" },
      "beam-width": { type: "string" },
      "max-candidates": { type: "string" },
      "max-calls": { type: "string" },
      "proposer-adapter": { type: "string" },
      "proposer-model": { type: "string" },
      resume: { type: "string" },
      continuous: { type: "boolean" },
      finite: { type: "boolean" },
      "grant-calls": { type: "string" },
      pause: { type: "string" },
      stop: { type: "string" },
    },
  });
  const required = (
    key:
      "adapter" | "domain" | "model" | "harness" | "benchmark" | "hypothesis",
  ) => {
    const value = values[key];
    if (!value) throw new Error(`Missing --${key}`);
    return value;
  };
  const settings: Record<string, string> = {};
  for (const setting of values.setting || []) {
    const separator = setting.indexOf("=");
    if (separator < 1) throw new Error("--setting must be KEY=VALUE");
    settings[setting.slice(0, separator)] = setting.slice(separator + 1);
  }
  if (values.instructions) settings.instructions = values.instructions;
  if (command === "evolve") {
    if (values.pause || values.stop) {
      print(
        await controlEvolution(
          values.pause || values.stop || "",
          values.stop ? "stop" : "pause",
        ),
      );
      return;
    }
    if (values.finite && values.continuous)
      throw new Error("Choose either --finite or --continuous");
    if (
      !values.resume &&
      !values.finite &&
      (values.rounds !== undefined || values["max-candidates"] !== undefined)
    )
      throw new Error(
        "--rounds and --max-candidates require --finite. Continuous campaigns checkpoint on --max-calls.",
      );
    if (values["grant-calls"] && !values.resume)
      throw new Error("--grant-calls requires --resume CAMPAIGN_ID");
    const report = (campaign: import("../core/types").EvolutionCampaign) => {
      process.stderr.write(
        `${JSON.stringify({ event: "campaign.progress", id: campaign.id, status: campaign.status, round: campaign.round, completedRounds: campaign.completedRounds, candidates: campaign.candidateIds.length, callsUsed: campaign.callsUsed, maxCalls: campaign.maxCalls, activeNodeId: campaign.activeNodeId })}\n`,
      );
    };
    const numberOption = (
      key:
        "rounds" | "branches" | "beam-width" | "max-candidates" | "max-calls",
    ) => (values[key] === undefined ? undefined : Number(values[key]));
    let activeCampaignId = values.resume;
    const previousReport = report;
    const signalPause = () => {
      if (activeCampaignId)
        void controlEvolution(activeCampaignId, "pause").catch((error) =>
          process.stderr.write(
            `${error instanceof Error ? error.message : String(error)}\n`,
          ),
        );
    };
    process.on("SIGINT", signalPause);
    process.on("SIGTERM", signalPause);
    let campaign: import("../core/types").EvolutionCampaign;
    try {
      const progress = (current: import("../core/types").EvolutionCampaign) => {
        activeCampaignId = current.id;
        previousReport(current);
      };
      campaign = values.resume
        ? await resumeEvolution(
            values.resume,
            progress,
            values["grant-calls"] === undefined
              ? 0
              : Number(values["grant-calls"]),
          )
        : await evolve(
            {
              adapterId: required("adapter"),
              domain: required("domain"),
              model: required("model"),
              harness: required("harness"),
              benchmark: required("benchmark"),
              parentId: values.parent,
              settings,
              continuous: values.finite ? false : (values.continuous ?? true),
              rounds: numberOption("rounds"),
              branches: numberOption("branches"),
              beamWidth: numberOption("beam-width"),
              maxCandidates: numberOption("max-candidates"),
              maxCalls: numberOption("max-calls"),
              proposerAdapterId: values["proposer-adapter"],
              proposerModel: values["proposer-model"],
            },
            progress,
          );
    } finally {
      process.off("SIGINT", signalPause);
      process.off("SIGTERM", signalPause);
    }
    print(campaign);
    if (campaign.status === "failed" || campaign.status === "budget_exhausted")
      process.exitCode = 1;
    return;
  }
  const node = await runBenchmark(
    {
      adapterId: required("adapter"),
      domain: required("domain"),
      model: required("model"),
      harness: required("harness"),
      benchmark: required("benchmark"),
      hypothesis: required("hypothesis"),
      parentId: values.parent,
      settings,
    },
    (current) =>
      process.stderr.write(
        `${JSON.stringify({ event: "node.progress", id: current.id, status: current.status, completedTasks: current.tasks.length, totalTasks: current.totalTasks })}\n`,
      ),
  );
  print(node);
  if (node.status === "failed") process.exitCode = 1;
}
main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
