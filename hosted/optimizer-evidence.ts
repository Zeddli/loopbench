import { z } from "zod";
import { createHash } from "node:crypto";
import type { HostedContext } from "./schema";
import { replayPiLog } from "./pi-events";
import { trustedResourceReceiptSchema } from "./verifier";

export function optimizerSubmissionEvidence(
  input: {
    ownerScope: string;
    campaignId: string;
    nodeIds: string[];
    parentId: string;
  },
  context: HostedContext,
): unknown[] {
  const ids = z
    .array(z.string())
    .max(32)
    .parse([...new Set(input.nodeIds)]);
  if (!ids.length) return [];
  const rows = context.db
    .prepare(
      `SELECT node_id,task_id,role,status,result_json FROM hosted_attempts WHERE owner_scope=? AND campaign_id=? AND node_id IN (${ids.map(() => "?").join(",")}) AND role!='parent' AND result_json IS NOT NULL ORDER BY CASE WHEN node_id=? THEN 0 ELSE 1 END,created_at DESC LIMIT 48`,
    )
    .all(input.ownerScope, input.campaignId, ...ids, input.parentId);
  const protectedValues = [
    context.config.sessionSigningKey,
    context.config.credentialFingerprintKey,
    ...Object.values(context.config.vaultKeys),
    process.env.NEBIUS_API_KEY,
    process.env.E2B_API_KEY,
  ].filter(
    (value): value is string => typeof value === "string" && value.length >= 12,
  );
  const modelReceipt = z.object({
    submissionHash: z.string().regex(/^[a-f0-9]{64}$/),
    artifacts: z.array(z.uuid()).max(16),
  });
  const results: unknown[] = [],
    seen = new Set<string>();
  for (const row of rows) {
    if (results.length >= 12) break;
    const key = `${row.node_id}/${row.task_id}`;
    if (seen.has(key)) continue;
    const receipt = modelReceipt.safeParse(
      (() => {
        try {
          return JSON.parse(String(row.result_json));
        } catch {
          return null;
        }
      })(),
    );
    if (!receipt.success) continue;
    for (const id of receipt.data.artifacts) {
      const artifact = context.db
        .prepare(
          "SELECT contents,sha256 FROM hosted_artifacts WHERE id=? AND owner_scope=? AND campaign_id=? AND kind='submission' AND visibility='owner' AND state='ready'",
        )
        .get(id, input.ownerScope, input.campaignId);
      if (
        !(artifact?.contents instanceof Uint8Array) ||
        artifact.sha256 !== receipt.data.submissionHash
      )
        continue;
      const bytes = Buffer.from(artifact.contents);
      if (
        createHash("sha256").update(bytes).digest("hex") !==
        receipt.data.submissionHash
      )
        continue;
      const code = bytes.toString("utf8");
      if (
        protectedValues.some((value) => code.includes(value)) ||
        /Bearer\s+\S+|(?:api[_-]?key|gateway[_-]?token)\s*[:=]|[A-Za-z0-9_-]{48,}/i.test(
          code,
        )
      )
        continue;
      results.push({
        nodeId: row.node_id,
        taskId: row.task_id,
        status: row.status,
        submissionSha256: receipt.data.submissionHash,
        source: code.slice(0, 8000),
        sourceTruncated: code.length > 8000,
      });
      seen.add(key);
      break;
    }
  }
  return results;
}

function executionSummary(log: string) {
  const parsed = replayPiLog(log);
  if (parsed.partial) throw Error("Partial execution evidence");
  const toolCalls = { read: 0, write: 0, edit: 0, bash: 0, other: 0 };
  const failedToolsByName = { read: 0, write: 0, edit: 0, bash: 0, other: 0 };
  const workspaceReads = {
    contract: 0,
    canonicalSubmission: 0,
    packageManifest: 0,
    directory: 0,
  };
  let failedTools = 0,
    canonicalWriteToolSuccesses = 0,
    assistantMessages = 0,
    firstCanonicalWriteAfterAssistantMessages: number | null = null,
    firstSuccessfulCanonicalWriteAfterAssistantMessages: number | null = null,
    publicSmokeCommands = 0,
    publicSmokeSuccesses = 0,
    publicSmokeFailures = 0,
    inventoryCommands = 0,
    dependencyInstallCommands = 0;
  const writes = new Map<string, number>();
  const smokes = new Set<string>();
  for (const event of parsed.events) {
    if (
      event.type === "message_end" &&
      z.object({ role: z.literal("assistant") }).safeParse(event.message)
        .success
    )
      assistantMessages++;
    if (event.type === "tool_execution_start") {
      const name = event.toolName;
      if (
        name === "read" ||
        name === "write" ||
        name === "edit" ||
        name === "bash"
      )
        toolCalls[name]++;
      else toolCalls.other++;
      const args = z
        .object({ path: z.string().optional(), command: z.string().optional() })
        .safeParse(event.args);
      const path = args.success
        ? (args.data.path ?? "")
            .replace(/^\/home\/user\/task\//, "")
            .replace(/^\.\//, "")
        : "";
      if (name === "read") {
        if (path === "README.md") workspaceReads.contract++;
        else if (path === "src/solution.cjs")
          workspaceReads.canonicalSubmission++;
        else if (path === "package.json") workspaceReads.packageManifest++;
        else if (
          [".", "src", "src/", "test", "test/", "/home/user/task"].includes(
            path,
          )
        )
          workspaceReads.directory++;
      }
      if (name === "bash" && args.success) {
        const command = args.data.command ?? "";
        if (/(?:^|[;&|]\s*)\s*(?:ls|find|tree|pwd)\b/.test(command))
          inventoryCommands++;
        if (
          /\b(?:npm\s+(?:install|i|ci)|pnpm\s+(?:install|add)|yarn\s+(?:install|add))\b/.test(
            command,
          )
        )
          dependencyInstallCommands++;
      }
      if (
        args.success &&
        (name === "write" || name === "edit") &&
        path === "src/solution.cjs"
      ) {
        if (typeof event.toolCallId === "string")
          writes.set(event.toolCallId, assistantMessages);
        firstCanonicalWriteAfterAssistantMessages ??= assistantMessages;
      }
      if (
        name === "bash" &&
        args.success &&
        /\bnode\s+(?:\/home\/user\/task\/)?test\/public-smoke\.cjs\b/.test(
          args.data.command ?? "",
        )
      ) {
        publicSmokeCommands++;
        if (typeof event.toolCallId === "string") smokes.add(event.toolCallId);
      }
    }
    if (event.type === "tool_execution_end") {
      if (event.isError === true) {
        failedTools++;
        const name = event.toolName;
        if (
          name === "read" ||
          name === "write" ||
          name === "edit" ||
          name === "bash"
        )
          failedToolsByName[name]++;
        else failedToolsByName.other++;
      }
      const writtenAfter =
        typeof event.toolCallId === "string"
          ? writes.get(event.toolCallId)
          : undefined;
      if (
        typeof event.toolCallId === "string" &&
        writtenAfter !== undefined &&
        event.isError === false
      ) {
        canonicalWriteToolSuccesses++;
        firstSuccessfulCanonicalWriteAfterAssistantMessages ??= writtenAfter;
      }
      if (typeof event.toolCallId === "string") {
        writes.delete(event.toolCallId);
        if (smokes.delete(event.toolCallId)) {
          if (event.isError === false) publicSmokeSuccesses++;
          else if (event.isError === true) publicSmokeFailures++;
        }
      }
    }
  }
  return {
    toolCalls,
    failedTools,
    failedToolsByName,
    workspaceReads,
    inventoryCommands,
    dependencyInstallCommands,
    canonicalWriteToolSuccesses,
    firstCanonicalWriteAfterAssistantMessages,
    firstSuccessfulCanonicalWriteAfterAssistantMessages,
    publicSmokeCommands,
    publicSmokeSuccesses,
    publicSmokeFailures,
    settled: parsed.state.settled,
  };
}

const attemptSchema = z.object({
  id: z.string(),
  node_id: z.string(),
  task_id: z.string(),
  role: z.enum(["baseline", "parent", "candidate", "challenge"]),
  status: z.string(),
  result_json: z.string().nullable(),
});
const receiptSchema = z.object({
  artifacts: z.array(z.uuid()).max(16).default([]),
  terminationReason: z
    .enum(["agent_completed", "attempt_call_limit", "output_token_limit"])
    .optional(),
});

export function optimizerExecutionEvidence(
  input: { ownerScope: string; campaignId: string; nodeIds: string[] },
  context: HostedContext,
) {
  const nodeIds = z.array(z.string()).max(32).parse(input.nodeIds);
  if (!nodeIds.length) return [];
  const rows = context.db
    .prepare(
      `SELECT id,node_id,task_id,role,status,result_json FROM hosted_attempts WHERE owner_scope=? AND campaign_id=? AND node_id IN (${nodeIds.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT 48`,
    )
    .all(input.ownerScope, input.campaignId, ...nodeIds);
  return rows.map((raw) => {
    const row = attemptSchema.parse(raw);
    let receipt: z.infer<typeof receiptSchema> | null = null;
    try {
      const parsed = receiptSchema.safeParse(
        JSON.parse(row.result_json ?? "null"),
      );
      if (parsed.success) receipt = parsed.data;
    } catch {
      /* Missing/corrupt evidence is unknown, never invented as zero work. */
    }
    let execution: ReturnType<typeof executionSummary> | null = null;
    let resourceOutcome:
      { resourceCategory: "heap_exhausted"; unscored: true } | undefined;
    for (const artifactId of receipt?.artifacts ?? []) {
      const resource = context.db
        .prepare(
          "SELECT contents FROM hosted_artifacts WHERE id=? AND owner_scope=? AND campaign_id=? AND kind='trusted-resource-result' AND visibility='internal_only' AND state='ready'",
        )
        .get(artifactId, input.ownerScope, input.campaignId);
      if (resource?.contents instanceof Uint8Array) {
        try {
          if (
            trustedResourceReceiptSchema.safeParse(
              JSON.parse(Buffer.from(resource.contents).toString("utf8")),
            ).success
          )
            resourceOutcome = {
              resourceCategory: "heap_exhausted",
              unscored: true,
            };
        } catch {
          /* No raw outcome text crosses this boundary. */
        }
      }
      const artifact = context.db
        .prepare(
          "SELECT contents FROM hosted_artifacts WHERE id=? AND owner_scope=? AND campaign_id=? AND kind='pi-events' AND visibility='internal_only' AND state='ready'",
        )
        .get(artifactId, input.ownerScope, input.campaignId);
      if (!(artifact?.contents instanceof Uint8Array)) continue;
      try {
        execution = executionSummary(
          Buffer.from(artifact.contents).toString("utf8"),
        );
      } catch {
        /* Raw logs are never sent to the optimizer, even when parsing fails. */
      }
    }
    const calls = context.db
      .prepare(
        "SELECT SUM(calls_used) AS used,MAX(max_calls) AS bound FROM gateway_grants WHERE owner_scope=? AND campaign_id=? AND attempt_id=? AND role='pi_attempt'",
      )
      .get(input.ownerScope, input.campaignId, row.id);
    return {
      nodeId: row.node_id,
      taskId: row.task_id,
      role: row.role,
      status: row.status,
      terminationReason: receipt?.terminationReason ?? null,
      modelCallsUsed: typeof calls?.used === "number" ? calls.used : null,
      modelCallLimit: typeof calls?.bound === "number" ? calls.bound : null,
      execution,
      ...(resourceOutcome ? { resourceOutcome } : {}),
    };
  });
}

export function optimizerQuarantinedOutcomes(
  input: { ownerScope: string; campaignId: string },
  context: HostedContext,
) {
  return context.db
    .prepare(
      "SELECT p.parent_id,p.proposal_json,p.round,p.ordinal,o.outcome_json FROM hosted_proposal_outcomes o JOIN hosted_proposals p ON p.owner_scope=o.owner_scope AND p.campaign_id=o.campaign_id AND p.round=o.round AND p.ordinal=o.ordinal WHERE o.owner_scope=? AND o.campaign_id=? ORDER BY p.round DESC,p.ordinal DESC LIMIT 24",
    )
    .all(input.ownerScope, input.campaignId)
    .flatMap((row) => {
      try {
        const outcome = z
          .object({
            outcome: z.literal("quarantined"),
            failurePhase: z.enum(["parent", "candidate"]),
            resourceCategory: z.literal("heap_exhausted"),
            unscored: z.literal(true),
          })
          .parse(JSON.parse(String(row.outcome_json)));
        const proposal = z
          .object({ hypothesis: z.string().max(500) })
          .parse(JSON.parse(String(row.proposal_json)));
        return [
          {
            parentId: String(row.parent_id),
            hypothesis: proposal.hypothesis,
            round: Number(row.round),
            ordinal: Number(row.ordinal),
            ...outcome,
          },
        ];
      } catch {
        return [];
      }
    });
}
