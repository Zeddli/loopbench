import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { nodeRecordSchema, type NodeRecord } from "../core/types";
import { getHostedContext } from "../hosted/database";
import { getCampaign } from "../hosted/store";
import { harnessArtifactSchema } from "../hosted/harnesses";
import { HostedError, type HostedContext } from "../hosted/schema";

const resultSchema = z.object({
  attemptId: z.string(),
  taskId: z.string(),
  status: z.enum(["passed", "benchmark_failed"]),
  submissionHash: z.string().regex(/^[a-f0-9]{64}$/),
  artifacts: z.array(z.uuid()).min(1),
  cleanupPending: z.literal(false),
});
const verdictSchema = z.object({
  status: z.enum(["passed", "benchmark_failed"]),
  passed: z.boolean(),
  graderSha256: z.string().regex(/^[a-f0-9]{64}$/),
  benchmarkHash: z.string(),
});
function safeLessonText(value: string): string {
  return value
    .slice(0, 8000)
    .replace(/Bearer\s+\S+/gi, "[redacted credential]")
    .replace(
      /\b(?:sk-[a-z0-9_-]{8,}|[a-z0-9_-]*(?:api[_-]?key|access[_-]?token|secret)[a-z0-9_-]*\s*[:=]\s*["']?[^\s"',;]{8,})/gi,
      "[redacted credential]",
    );
}
interface VerifiedTask {
  taskId: string;
  attemptId: string;
  passed: boolean;
  verifierArtifactId: string;
  verifierSha256: string;
  graderSha256: string;
}
function verifiedTask(
  input: {
    ownerScope: string;
    campaignId: string;
    nodeId: string;
    role: "parent" | "candidate";
    taskId: string;
    benchmarkHash: string;
  },
  context: HostedContext,
): VerifiedTask | null {
  const row = context.db
    .prepare(
      "SELECT id,status,result_json FROM hosted_attempts WHERE owner_scope=? AND campaign_id=? AND node_id=? AND role=? AND task_id=? ORDER BY created_at DESC LIMIT 1",
    )
    .get(
      input.ownerScope,
      input.campaignId,
      input.nodeId,
      input.role,
      input.taskId,
    );
  if (!row || typeof row.result_json !== "string") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(row.result_json);
  } catch {
    return null;
  }
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) return null;
  const result = parsed.data;
  if (
    result.taskId !== input.taskId ||
    result.attemptId !== row.id ||
    result.status !== row.status
  )
    return null;
  for (const artifactId of result.artifacts) {
    const artifact = context.db
      .prepare(
        "SELECT contents,sha256 FROM hosted_artifacts WHERE owner_scope=? AND campaign_id=? AND id=? AND kind='verifier-result' AND state='ready'",
      )
      .get(input.ownerScope, input.campaignId, artifactId);
    if (!(artifact?.contents instanceof Uint8Array)) continue;
    const bytes = Buffer.from(artifact.contents);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== artifact.sha256) continue;
    let verdictRaw: unknown;
    try {
      verdictRaw = JSON.parse(bytes.toString("utf8"));
    } catch {
      continue;
    }
    const parsedVerdict = verdictSchema.safeParse(verdictRaw);
    if (!parsedVerdict.success) continue;
    const verdict = parsedVerdict.data;
    if (
      verdict.benchmarkHash !== input.benchmarkHash ||
      verdict.status !== result.status ||
      verdict.passed !== (result.status === "passed")
    )
      continue;
    return {
      taskId: input.taskId,
      attemptId: result.attemptId,
      passed: verdict.passed,
      verifierArtifactId: artifactId,
      verifierSha256: digest,
      graderSha256: verdict.graderSha256,
    };
  }
  return null;
}
function completeTasks(node: NodeRecord): boolean {
  return (
    node.tasks.length === node.totalTasks &&
    new Set(node.tasks.map((task) => task.taskId)).size === node.totalTasks
  );
}
/** Only independently verified complete paired outcomes can label an exported lesson. */
export function buildLessonDataset(
  input: { ownerScope: string; campaignId: string },
  context: HostedContext,
) {
  const campaign = getCampaign(input, context);
  if (!campaign)
    throw new HostedError(
      "NOT_FOUND",
      "The requested resource was not found.",
      404,
    );
  const tables = context.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('hosted_versions','hosted_attempts','hosted_artifacts')",
    )
    .all();
  if (tables.length !== 3)
    return {
      schemaVersion: 1,
      campaignId: campaign.id,
      rows: [],
      jsonl: "",
      sha256: createHash("sha256").update("").digest("hex"),
      skipped: 0,
    };
  const rows: Record<string, unknown>[] = [];
  let skipped = 0;
  const versions = context.db
    .prepare(
      "SELECT id,parent_id,node_json,harness_json FROM hosted_versions WHERE owner_scope=? AND campaign_id=? ORDER BY id",
    )
    .all(input.ownerScope, input.campaignId);
  for (const stored of versions) {
    const node = nodeRecordSchema.parse(JSON.parse(String(stored.node_json)));
    if (!node.learning || !["accepted", "rejected"].includes(node.status))
      continue;
    const parentStored = versions.find((item) => item.id === node.parentId);
    const parent = parentStored
      ? nodeRecordSchema.parse(JSON.parse(String(parentStored.node_json)))
      : null;
    if (
      !parentStored ||
      !parent ||
      stored.parent_id !== node.parentId ||
      node.config.model !== campaign.modelId ||
      parent.config.model !== node.config.model ||
      parent.config.benchmarkHash !== node.config.benchmarkHash ||
      !completeTasks(node) ||
      !node.comparison ||
      node.comparison.method !== "paired" ||
      node.comparison.parentTasks.length !== node.totalTasks ||
      new Set(node.comparison.parentTasks.map((task) => task.taskId)).size !==
        node.totalTasks
    ) {
      skipped++;
      continue;
    }
    const runtime = harnessArtifactSchema.parse(
      JSON.parse(String(stored.harness_json)),
    ).runtime;
    if (
      JSON.stringify(runtime) !==
      JSON.stringify(
        harnessArtifactSchema.parse(
          JSON.parse(String(parentStored.harness_json)),
        ).runtime,
      )
    ) {
      skipped++;
      continue;
    }
    const verified: { parent: VerifiedTask; candidate: VerifiedTask }[] = [];
    for (const task of [...node.tasks].sort((left, right) =>
      left.taskId.localeCompare(right.taskId),
    )) {
      const parentTask = node.comparison.parentTasks.find(
        (item) => item.taskId === task.taskId,
      );
      const common = {
        ...input,
        nodeId: node.id,
        taskId: task.taskId,
        benchmarkHash: node.config.benchmarkHash,
      };
      const candidate = verifiedTask({ ...common, role: "candidate" }, context);
      const pairedParent = verifiedTask({ ...common, role: "parent" }, context);
      if (
        !candidate ||
        !pairedParent ||
        !parentTask ||
        candidate.passed !== task.passed ||
        pairedParent.passed !== parentTask.passed ||
        candidate.graderSha256 !== pairedParent.graderSha256
      )
        break;
      verified.push({ parent: pairedParent, candidate });
    }
    if (verified.length !== node.totalTasks) {
      skipped++;
      continue;
    }
    const candidatePassed = verified.filter(
      (item) => item.candidate.passed,
    ).length;
    const parentPassed = verified.filter((item) => item.parent.passed).length;
    if (
      (node.status === "accepted") !== candidatePassed > parentPassed ||
      node.comparison.candidateScore !== candidatePassed / node.totalTasks ||
      node.comparison.parentScore !== parentPassed / node.totalTasks
    ) {
      skipped++;
      continue;
    }
    rows.push({
      schemaVersion: 1,
      source: "loopbench-hosted-paired-verifier",
      campaignId: campaign.id,
      versionId: node.id,
      parentVersionId: node.parentId,
      taskFamily: "coding-function-contracts",
      modelId: campaign.modelId,
      benchmarkHash: node.config.benchmarkHash,
      harnessHash: node.harnessHash,
      runtime,
      lesson: {
        diagnosis: safeLessonText(node.learning.diagnosis),
        change: safeLessonText(node.learning.change),
        prediction: safeLessonText(node.learning.prediction),
      },
      measuredOutcome: {
        verdict: node.status,
        candidatePassed,
        freshParentPassed: parentPassed,
        requiredTasks: node.totalTasks,
        deltaNumerator: candidatePassed - parentPassed,
        deltaDenominator: node.totalTasks,
      },
      evidence: verified,
    });
  }
  const jsonl =
    rows.map((row) => JSON.stringify(row)).join("\n") +
    (rows.length ? "\n" : "");
  return {
    schemaVersion: 1,
    campaignId: campaign.id,
    rows,
    jsonl,
    sha256: createHash("sha256").update(jsonl).digest("hex"),
    skipped,
  };
}
function option(name: string): string {
  const index = process.argv.indexOf(name);
  if (
    index < 0 ||
    !process.argv[index + 1] ||
    process.argv[index + 1].startsWith("--")
  )
    throw new Error("Missing argument");
  return process.argv[index + 1];
}
async function main() {
  if (!process.argv.includes("--consent"))
    throw new Error("Explicit local export consent required");
  const campaignId = z.uuid().parse(option("--campaign"));
  const output = option("--output");
  if (!isAbsolute(output))
    throw new Error("An explicit absolute private output path is required");
  const context = getHostedContext();
  try {
    const scope = context.db
      .prepare("SELECT owner_scope FROM campaigns WHERE id=?")
      .get(campaignId);
    if (!scope) throw new Error("Campaign not found");
    const dataset = buildLessonDataset(
      { ownerScope: String(scope.owner_scope), campaignId },
      context,
    );
    if (!dataset.rows.length)
      throw new Error(
        "No complete independently verified paired lessons available",
      );
    await writeFile(output, dataset.jsonl, { flag: "wx", mode: 0o600 });
    await writeFile(
      `${output}.manifest.json`,
      JSON.stringify(
        {
          schemaVersion: 1,
          campaignId,
          sha256: dataset.sha256,
          rows: dataset.rows.length,
          skipped: dataset.skipped,
          exportedAt: new Date().toISOString(),
          source: "loopbench-hosted-paired-verifier",
          redactionPolicy: "reusable-learning-and-verifier-identities-v1",
          rawLogsIncluded: false,
          hiddenCasesIncluded: false,
          submissionsIncluded: false,
          cloudUploadPerformed: false,
          providerDataRetentionChanged: false,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, campaignId, rows: dataset.rows.length, skipped: dataset.skipped, sha256: dataset.sha256, cloudUploadPerformed: false })}\n`,
    );
  } finally {
    context.db.close();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void main().catch(() => {
    process.stderr.write(
      "Lesson export was not completed. Supply --consent, a campaign UUID and a new absolute private --output path. Only complete independently verified paired lessons are eligible.\n",
    );
    process.exitCode = 1;
  });
