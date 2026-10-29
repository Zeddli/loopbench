import { z } from "zod";

const wireSchema = z.object({ type: z.string().min(1) }).passthrough();
export type PiEvent = z.infer<typeof wireSchema>;
export interface PiRunState {
  accepted: boolean;
  started: boolean;
  settled: boolean;
  aborted: boolean;
  processEnded: boolean;
  exitCode: number | null;
  lastStopReason: string | null;
  toolCalls: number;
  events: number;
  protocolError: string | null;
}
export function initialPiRunState(): PiRunState {
  return {
    accepted: false,
    started: false,
    settled: false,
    aborted: false,
    processEnded: false,
    exitCode: null,
    lastStopReason: null,
    toolCalls: 0,
    events: 0,
    protocolError: null,
  };
}
export function parsePiEvent(raw: unknown): PiEvent {
  return wireSchema.parse(raw);
}
export function reducePiEvent(
  previous: PiRunState,
  event: PiEvent,
): PiRunState {
  const state = { ...previous, events: previous.events + 1 };
  switch (event.type) {
    case "response":
      if (event.command === "prompt") {
        state.accepted = event.success === true;
        if (event.success === false) state.protocolError = "Pi rejected prompt";
      }
      break;
    case "agent_start":
      state.started = true;
      state.settled = false;
      break;
    case "agent_settled":
      state.settled = true;
      state.aborted = event.aborted === true;
      break;
    case "tool_execution_start":
      state.toolCalls++;
      break;
    case "message_end": {
      const message = z
        .object({ role: z.string(), stopReason: z.string().optional() })
        .safeParse(event.message);
      if (message.success && message.data.role === "assistant")
        state.lastStopReason = message.data.stopReason ?? null;
      break;
    }
    case "supervisor_end":
      state.processEnded = true;
      state.exitCode =
        typeof event.exitCode === "number" ? event.exitCode : null;
      if (typeof event.error === "string") state.protocolError = event.error;
      break;
  }
  return state;
}
export function piExecutionSucceeded(state: PiRunState): boolean {
  return (
    state.started &&
    state.settled &&
    !state.aborted &&
    state.processEnded &&
    state.exitCode === 0 &&
    !state.protocolError &&
    state.lastStopReason === "stop"
  );
}
/** A locally enforced attempt bound is an evaluation condition, not provider downtime.
 * Only an authenticated gateway record can establish the reason; a Pi error string cannot. */
export function canGradeSettledCallLimit(
  state: PiRunState,
  scopedLimitConfirmed: boolean,
): boolean {
  return (
    scopedLimitConfirmed &&
    state.accepted &&
    state.started &&
    state.settled &&
    !state.aborted &&
    state.processEnded &&
    state.exitCode === 0 &&
    !state.protocolError &&
    state.lastStopReason === "error"
  );
}
export function canGradeSettledOutputLimit(
  state: PiRunState,
  completedCallsConfirmed: boolean,
): boolean {
  return (
    completedCallsConfirmed &&
    state.accepted &&
    state.started &&
    state.settled &&
    !state.aborted &&
    state.processEnded &&
    state.exitCode === 0 &&
    !state.protocolError &&
    state.lastStopReason === "length"
  );
}
/** Replay a bounded whole durable log; usage is never charged from this replay. */
export function replayPiLog(log: string): {
  state: PiRunState;
  events: PiEvent[];
  partial: string;
} {
  if (Buffer.byteLength(log) > 4_194_304)
    throw new Error("Pi log exceeds bound");
  const lines = log.split("\n");
  const partial = lines.pop() ?? "";
  let state = initialPiRunState();
  const events: PiEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > 524_288)
      throw new Error("Pi event exceeds bound");
    const event = parsePiEvent(JSON.parse(line));
    events.push(event);
    state = reducePiEvent(state, event);
  }
  return { state, events, partial };
}
