import { z } from "zod";

export const relayRequestSchema = z
  .object({
    id: z.uuid(),
    body: z.string().max(393216),
    headers: z
      .object({
        authorization: z.string(),
        "content-type": z.literal("application/json"),
        "x-loopbench-request-key": z.string(),
      })
      .strict(),
  })
  .strict();
export type RelayRequest = z.infer<typeof relayRequestSchema>;

/** Retry only reads and delivery of already obtained bytes. Never retry inference. */
export function createTokenRelayCycle(io: {
  poll(): Promise<unknown>;
  infer(request: RelayRequest): Promise<string>;
  deliver(id: string, response: string): Promise<void>;
  assertFence(): void;
  delay(ms: number): Promise<void>;
  onRetry(stage: "poll" | "deliver", attempt: number): void;
}) {
  const seen = new Set<string>();
  async function retry<T>(
    stage: "poll" | "deliver",
    operation: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      io.assertFence();
      try {
        return await operation();
      } catch (error) {
        if (attempt >= 3) throw error;
        io.onRetry(stage, attempt);
        await io.delay(250 * attempt);
      }
    }
  }
  return async () => {
    const requests = z
      .array(relayRequestSchema)
      .max(2)
      .parse(await retry("poll", io.poll));
    for (const request of requests) {
      if (seen.has(request.id)) continue;
      io.assertFence();
      // Mark before sending: an ambiguous inference failure must never replay.
      seen.add(request.id);
      const response = await io.infer(request);
      await retry("deliver", () => io.deliver(request.id, response));
    }
  };
}
