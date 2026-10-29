import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import type { RemoteCommandResult } from "./e2b";

function readinessDelay(response: Response, deadline: number) {
  const seconds = Number(response.headers.get("Retry-After") ?? 0);
  const requested =
    Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 250;
  return Math.min(Math.max(0, deadline - Date.now()), Math.max(250, requested));
}

const streamSchema = z.object({
  value: z.string().default(""),
  encoding: z.enum(["ascii", "base64"]).default("ascii"),
  truncated: z.boolean().optional(),
});
const resultSchema = z.object({
  state: z.object({
    exit_code: z.number().int(),
    signal: z.number().optional(),
    timed_out: z.boolean().optional(),
  }),
  stdout: streamSchema.optional(),
  stderr: streamSchema.optional(),
});
export class TokenSandboxHttpError extends Error {
  constructor(readonly httpStatus: number) {
    super(`Token Factory sandbox request failed (${httpStatus})`);
    this.name = "TokenSandboxHttpError";
  }
}
export class TokenSandboxProcessError extends Error {
  constructor(
    readonly processExitCode: number,
    readonly processFailure:
      | "timed_out"
      | "signaled"
      | "output_truncated"
      | "not_settled"
      | "heap_exhausted",
    readonly processSignal?: number,
  ) {
    super(
      processFailure === "not_settled"
        ? "Token Factory subprocess is not settled"
        : "Token Factory process interrupted or output truncated",
    );
    this.name = "TokenSandboxProcessError";
  }
}
function subprocessRunning(result: z.infer<typeof resultSchema>): boolean {
  // HTTP 200 is a current event-log snapshot, not a completion guarantee.
  // https://docs.tokenfactory.nebius.com/api-reference/sandboxes/operation/result-of-one-subprocess-reconstructed-from-its-events
  return (
    result.state.exit_code === -1 &&
    (result.state.signal ?? -1) === -1 &&
    !result.state.timed_out
  );
}
export function decodeProcessResult(raw: unknown): RemoteCommandResult {
  const result = resultSchema.parse(raw);
  const decode = (s: z.infer<typeof streamSchema> | undefined) =>
    !s
      ? ""
      : s.encoding === "base64"
        ? Buffer.from(s.value, "base64").toString("utf8")
        : s.value;
  if (subprocessRunning(result))
    throw new TokenSandboxProcessError(
      result.state.exit_code,
      "not_settled",
      result.state.signal,
    );
  if (
    result.state.timed_out ||
    (result.state.signal ?? -1) > 0 ||
    result.stdout?.truncated ||
    result.stderr?.truncated
  )
    throw new TokenSandboxProcessError(
      result.state.exit_code,
      result.state.timed_out
        ? "timed_out"
        : (result.state.signal ?? -1) > 0
          ? /FATAL ERROR:.*(?:heap|allocation).*memory|Reached heap limit|JavaScript heap out of memory/i.test(
              decode(result.stderr),
            )
            ? "heap_exhausted"
            : "signaled"
          : "output_truncated",
      result.state.signal,
    );
  return {
    exitCode: result.state.exit_code,
    stdout: decode(result.stdout),
    stderr: decode(result.stderr),
  };
}
export const tokenOperationSchema = z
  .object({
    uuid: z.uuid(),
    status: z.enum([
      "PENDING",
      "ASSIGNED",
      "EXECUTING",
      "SUCCESS",
      "FAILED",
      "CANCELLED",
    ]),
    kind: z.string().optional(),
    error: z.string().nullish(),
    duration: z.number().nullish(),
    image_uuid: z.string().nullish(),
    result_image_uuid: z.string().nullish(),
    metadata: z
      .object({
        env: z.record(z.string(), z.string()).nullish(),
        networking: z.object({ enabled: z.boolean() }).optional(),
        result: z.unknown().optional(),
      })
      .passthrough()
      .nullish(),
    result: z.object({ image: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough();
export type TokenOperation = z.infer<typeof tokenOperationSchema>;
export type TokenExec = {
  command: string;
  args?: string[];
  shell?: boolean;
  env?: Record<string, string>;
  cwd?: string;
  uid?: number;
  gid?: number;
  stdin?: { value: string; encoding: "ascii" | "base64"; close: boolean };
};
export type TokenSpawn = TokenExec & {
  image: string;
  disposable: boolean;
  timeout: number;
  networking: { enabled: boolean };
  resources_limits?: { max_layer_bytes: number };
  truncate_output_at?: number;
};
export function tokenTerminal(op: TokenOperation) {
  return ["SUCCESS", "FAILED", "CANCELLED"].includes(op.status);
}
export class TokenSandboxClient {
  private readonly request: typeof fetch;
  constructor(
    private readonly config: {
      apiKey: string;
      projectId: string;
      fetch?: typeof fetch;
    },
  ) {
    if (!config.apiKey || !config.projectId)
      throw new Error(
        "Configure Token Factory sandbox credentials and project",
      );
    this.request = config.fetch ?? fetch;
  }
  async call(route: string, method = "GET", body?: unknown): Promise<Response> {
    if (!route.startsWith("/") || route.includes(".."))
      throw new Error("Invalid sandbox API route");
    return this.request(
      `https://api.tokenfactory.nebius.com/sandboxes/v1${route}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          Project: this.config.projectId,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      },
    );
  }
  async json(route: string, method = "GET", body?: unknown): Promise<unknown> {
    const r = await this.call(route, method, body);
    if (!r.ok) throw new TokenSandboxHttpError(r.status);
    return r.json();
  }
  async spawn(input: TokenSpawn): Promise<string> {
    z.uuid().parse(input.image);
    z.number().int().min(1).max(600).parse(input.timeout);
    // A failed POST is deliberately not replayed. Callers persist intent before invoking this.
    return z
      .object({ uuid: z.uuid() })
      .parse(await this.json("/instances", "POST", input)).uuid;
  }
  async importImage(reference: string): Promise<string> {
    if (
      !/^docker:\/\/docker\.io\/library\/node:24\.15\.0-bookworm$/.test(
        reference,
      )
    )
      throw new Error("Runtime import must use the pinned official Node image");
    return z.object({ uuid: z.uuid() }).parse(
      await this.json("/images/import", "POST", {
        registry: { url: reference },
        timeout: 300,
      }),
    ).uuid;
  }
  async get(id: string): Promise<TokenOperation> {
    const route = `/operations/${z.uuid().parse(id)}`,
      deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const response = await this.call(route);
      if (response.status === 425) {
        await delay(readinessDelay(response, deadline));
        continue;
      }
      if (!response.ok) throw new TokenSandboxHttpError(response.status);
      return tokenOperationSchema.parse(await response.json());
    }
    throw new Error(
      "Token Factory operation readiness wait expired; identity retained",
    );
  }
  async wait(id: string, timeoutMs = 610000): Promise<TokenOperation> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const op = await this.get(id);
      if (tokenTerminal(op)) return op;
      await delay(750);
    }
    throw new Error(
      "Sandbox wait expired; operation identity retained for reconciliation",
    );
  }
  async cancel(id: string): Promise<void> {
    const r = await this.call(`/operations/${z.uuid().parse(id)}`, "DELETE");
    if (!r.ok && r.status !== 404) throw new TokenSandboxHttpError(r.status);
  }
  async startChild(id: string, command: TokenExec): Promise<number> {
    const route = `/operations/${z.uuid().parse(id)}/subprocesses`;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const response = await this.call(route, "POST", command);
      // This endpoint documents 425 as rejection BEFORE exec is accepted.
      // A 504 or transport failure may already have started the child and must not be replayed.
      if (response.status === 425) {
        await delay(readinessDelay(response, deadline));
        continue;
      }
      if (!response.ok) throw new TokenSandboxHttpError(response.status);
      return z
        .object({ spid: z.number().int().min(2) })
        .parse(await response.json()).spid;
    }
    throw new Error(
      "Token Factory subprocess readiness wait expired; no accepted child observed",
    );
  }
  async waitChild(
    id: string,
    spid: number,
    timeoutMs = 20000,
  ): Promise<RemoteCommandResult> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await this.call(
        `/operations/${z.uuid().parse(id)}/subprocesses/${spid}`,
      );
      if (r.status === 425) {
        await delay(readinessDelay(r, deadline));
        continue;
      }
      if (!r.ok) throw new TokenSandboxHttpError(r.status);
      const raw: unknown = await r.json();
      const parsed = resultSchema.safeParse(raw);
      const wrapper = z.object({ result: resultSchema }).safeParse(raw);
      const result = parsed.success
        ? parsed.data
        : wrapper.success
          ? wrapper.data.result
          : null;
      if (!result) throw new Error("Malformed sandbox subprocess result");
      if (subprocessRunning(result)) {
        await delay(readinessDelay(r, deadline));
        continue;
      }
      return decodeProcessResult(result);
    }
    throw new Error("Sandbox subprocess wait expired; not replayed");
  }
  async runChild(id: string, command: TokenExec, timeoutMs = 20000) {
    const spid = await this.startChild(id, command);
    return this.waitChild(id, spid, timeoutMs);
  }
}
