import type {
  E2BTransport,
  RemoteSandbox,
  SandboxRecord,
  E2BCreateInput,
} from "./e2b";
import { setTimeout as delay } from "node:timers/promises";

export interface SandboxIntent {
  id: string;
  ownerScope: string;
  campaignId: string;
  attemptId: string;
  role: "agent" | "verifier";
  status: "prepared" | "creating" | "unknown" | "running" | "terminated";
  sandboxId: string | null;
  templateId: string;
}
export interface SandboxContext {
  transport: E2BTransport;
  /** Durable atomic admission must reserve full lifetime compute and one of TWO global slots before returning. */
  prepare(
    input: Omit<SandboxIntent, "status" | "sandboxId">,
  ): Promise<SandboxIntent>;
  get(intentId: string): Promise<SandboxIntent>;
  /** Atomic compare-and-swap prepared -> creating; also checks the job fence. */
  claim(intentId: string): Promise<boolean>;
  update(
    intentId: string,
    status: SandboxIntent["status"],
    sandboxId?: string,
  ): Promise<void>;
  /** Called only after provider absence is confirmed. */
  confirmTerminated(intentId: string): Promise<void>;
  assertFence(): Promise<void>;
}
export interface SandboxHandle {
  intent: SandboxIntent;
  record: SandboxRecord;
  remote: RemoteSandbox;
}
function metadata(intent: SandboxIntent) {
  return {
    application: "loopbench-hosted",
    intentId: intent.id,
    ownerScope: intent.ownerScope,
    campaignId: intent.campaignId,
    attemptId: intent.attemptId,
    role: intent.role,
  };
}
function owned(intent: SandboxIntent, record: SandboxRecord) {
  return Object.entries(metadata(intent)).every(
    ([key, value]) => record.metadata[key] === value,
  );
}
async function attach(
  intent: SandboxIntent,
  record: SandboxRecord,
  context: SandboxContext,
): Promise<SandboxHandle> {
  if (!record.connection) {
    const detail = await context.transport.inspect(record.id);
    if (!detail) throw new Error("Sandbox disappeared during reconciliation");
    record = detail;
  }
  if (
    !owned(intent, record) ||
    record.templateId !== intent.templateId ||
    record.state !== "running"
  )
    throw new Error("Sandbox ownership/runtime mismatch");
  await context.update(intent.id, "running", record.id);
  return {
    intent: { ...intent, sandboxId: record.id, status: "running" },
    record,
    remote: await context.transport.connect(record),
  };
}
export async function reconcileSandboxIntent(
  intentId: string,
  context: SandboxContext,
): Promise<SandboxHandle | null> {
  const intent = await context.get(intentId);
  const matches = (await context.transport.list(metadata(intent))).filter(
    (row) => owned(intent, row),
  );
  if (matches.length > 1)
    throw new Error(
      "Multiple sandboxes match an intent; manual reconciliation required",
    );
  if (matches[0]) return attach(intent, matches[0], context);
  // Empty discovery does not prove a delayed create failed. Never automatically replace it.
  return null;
}
export async function createAttemptSandbox(
  input: Omit<SandboxIntent, "status" | "sandboxId"> &
    Pick<E2BCreateInput, "gatewayOrigin" | "ttlSeconds">,
  context: SandboxContext,
): Promise<SandboxHandle> {
  await context.assertFence();
  const intent = await context.prepare(input);
  if (intent.status !== "prepared") {
    const existing = await reconcileSandboxIntent(intent.id, context);
    if (existing) return existing;
    throw new Error(
      "Sandbox intent already attempted; awaiting reconciliation",
    );
  }
  if (!(await context.claim(intent.id)))
    throw new Error("Sandbox intent is already claimed");
  await context.assertFence();
  try {
    const row = await context.transport.create({
      templateId: input.templateId,
      role: input.role,
      metadata: metadata(intent),
      gatewayOrigin: input.gatewayOrigin,
      ttlSeconds: input.ttlSeconds,
    });
    return await attach(intent, row, context);
  } catch (error) {
    await context.update(intent.id, "unknown");
    throw error;
  }
}
export async function terminateOwnedSandbox(
  handle: SandboxHandle,
  context: SandboxContext,
): Promise<boolean> {
  // Only this idempotent cleanup path retries. Every attempt inspects ownership
  // again, including after a DELETE whose response may have been lost.
  for (let attempt = 0; ; attempt++) {
    let outcome: "absent" | "present" | "unowned";
    try {
      const row = await context.transport.inspect(handle.record.id);
      if (row && !owned(handle.intent, row)) outcome = "unowned";
      else if (!row) outcome = "absent";
      else {
        await context.transport.terminate(row.id);
        outcome = (await context.transport.inspect(handle.record.id))
          ? "present"
          : "absent";
      }
    } catch (error) {
      if (attempt === 2) throw error;
      await delay(250 * (attempt + 1));
      continue;
    }
    if (outcome === "unowned")
      throw new Error("Refusing to terminate an unowned sandbox");
    if (outcome === "absent") {
      // Accounting/fencing failures are not transport failures and must not retry.
      await context.confirmTerminated(handle.intent.id);
      return true;
    }
    if (attempt === 2) return false;
    await delay(250 * (attempt + 1));
  }
}
