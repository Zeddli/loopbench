import { z } from "zod";
import type { HostedContext } from "./schema";
import { replayPiLog } from "./pi-events";

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
    for (const artifactId of receipt?.artifacts ?? []) {
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
    };
  });
}
