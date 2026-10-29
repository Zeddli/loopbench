import { z } from "zod";
import { Sandbox, CommandExitError } from "e2b";

export type SandboxRole = "agent" | "verifier";
export interface RemoteCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
export interface RemoteSandbox {
  id: string;
  /** Trusted controller override for the no-NIC Token Factory relay only. */
  inferenceOrigin?: string;
  writeFile(path: string, contents: string): Promise<void>;
  readFile(path: string): Promise<string>;
  run(
    command: string,
    options?: { timeoutMs?: number; user?: string },
  ): Promise<RemoteCommandResult>;
  start(command: string, options?: { user?: string }): Promise<number>;
  killProcess(pid: number): Promise<void>;
}
export interface SandboxRecord {
  id: string;
  templateId: string;
  metadata: Record<string, string>;
  state: "running" | "paused";
  endAt: string;
  cpuCount?: number;
  memoryMiB?: number;
  connection?: {
    envdVersion: string;
    envdAccessToken: string;
    domain?: string;
  };
}
export interface E2BCreateInput {
  templateId: string;
  ttlSeconds: number;
  metadata: Record<string, string>;
  role: SandboxRole;
  gatewayOrigin: string;
}
export interface E2BTransport {
  create(input: E2BCreateInput): Promise<SandboxRecord>;
  list(metadata: Record<string, string>): Promise<SandboxRecord[]>;
  inspect(id: string): Promise<SandboxRecord | null>;
  connect(record: SandboxRecord): Promise<RemoteSandbox>;
  terminate(id: string): Promise<void>;
}
const sandboxSchema = z.object({
  sandboxID: z.string().min(1),
  templateID: z.string(),
  metadata: z.record(z.string(), z.string()).default({}),
  state: z.enum(["running", "paused"]).default("running"),
  endAt: z.string().default(""),
  cpuCount: z.number().int().positive().optional(),
  memoryMB: z.number().int().positive().optional(),
});
function record(raw: unknown): SandboxRecord {
  const value = sandboxSchema.parse(raw);
  const connection = z
    .object({
      envdVersion: z.string(),
      envdAccessToken: z.string(),
      domain: z.string().nullish(),
    })
    .safeParse(raw);
  return {
    id: value.sandboxID,
    templateId: value.templateID,
    metadata: value.metadata,
    state: value.state,
    endAt: value.endAt,
    cpuCount: value.cpuCount,
    memoryMiB: value.memoryMB,
    connection: connection.success
      ? {
          envdVersion: connection.data.envdVersion,
          envdAccessToken: connection.data.envdAccessToken,
          domain: connection.data.domain ?? undefined,
        }
      : undefined,
  };
}
/** Pinned e2b 2.61.0 controller. Construct directly from inspect data: connect() can resume/extend lifetime. */
export function sdkController(config: {
  apiKey: string;
  apiUrl?: string;
}): (record: SandboxRecord) => Promise<RemoteSandbox> {
  return async (row) => {
    if (!row.connection || row.state !== "running")
      throw new Error(
        "E2B controller requires running sandbox connection metadata",
      );
    const sandbox = new Sandbox({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      retries: 0,
      sandboxId: row.id,
      sandboxDomain: row.connection.domain,
      envdVersion: row.connection.envdVersion,
      envdAccessToken: row.connection.envdAccessToken,
    });
    // E2B's documented allTraffic rule is IPv4; its API rejects ::/0.
    // Preserve the no-IPv6 boundary inside the VM BEFORE exposing a controller
    // to agent setup, credentials or untrusted code. The agent drops all caps.
    const program =
      'const fs=require("node:fs");const root="/proc/sys/net/ipv6/conf";if(fs.existsSync(root)){for(const name of ["default","all",...fs.readdirSync(root)])fs.writeFileSync(root+"/"+name+"/disable_ipv6","1");for(const name of fs.readdirSync(root))if(fs.readFileSync(root+"/"+name+"/disable_ipv6","utf8").trim()!=="1")throw Error("IPv6 interface still enabled");}if(fs.existsSync("/proc/net/if_inet6")&&fs.readFileSync("/proc/net/if_inet6","utf8").trim())throw Error("IPv6 address remains");process.stdout.write("ipv6-disabled");';
    const secured = await sandbox.commands.run("node -e '" + program + "'", {
      user: "root",
      timeoutMs: 10000,
    });
    if (secured.exitCode !== 0 || secured.stdout !== "ipv6-disabled")
      throw new Error("Sandbox IPv6 isolation could not be verified");
    return {
      id: row.id,
      async writeFile(path, contents) {
        await sandbox.files.write(path, contents, { user: "root" });
      },
      readFile: (path) => sandbox.files.read(path, { user: "root" }),
      async run(command, options) {
        try {
          return await sandbox.commands.run(command, {
            user: options?.user ?? "root",
            timeoutMs: options?.timeoutMs ?? 20_000,
          });
        } catch (error) {
          if (error instanceof CommandExitError)
            return {
              stdout: error.stdout,
              stderr: error.stderr,
              exitCode: error.exitCode,
            };
          throw error;
        }
      },
      async start(command, options) {
        const handle = await sandbox.commands.run(command, {
          user: options?.user ?? "root",
          background: true,
          timeoutMs: 0,
        });
        return handle.pid;
      },
      async killProcess(pid) {
        await sandbox.commands.kill(pid);
      },
    };
  };
}
export class AmbiguousSandboxCreateError extends Error {
  constructor() {
    super(
      "Sandbox creation outcome is unknown; reconcile the persisted intent before continuing",
    );
  }
}
/** A single POST. Neither fetch nor this transport replays an uncertain create. */
export function createE2BTransport(config: {
  apiKey: string;
  apiOrigin?: string;
  requestTimeoutMs?: number;
  controller: (record: SandboxRecord) => Promise<RemoteSandbox>;
  fetch?: typeof fetch;
}): E2BTransport {
  const origin = config.apiOrigin ?? "https://api.e2b.app";
  const request = config.fetch ?? fetch;
  async function call(route: string, init: RequestInit = {}) {
    return request(new URL(route, origin), {
      ...init,
      headers: {
        "X-API-Key": config.apiKey,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(config.requestTimeoutMs ?? 20_000),
      redirect: "error",
    });
  }
  return {
    async create(input) {
      if (
        !Number.isInteger(input.ttlSeconds) ||
        input.ttlSeconds < 1 ||
        input.ttlSeconds > 600
      )
        throw new Error("Sandbox TTL must be 1–600 seconds");
      const gateway = new URL(input.gatewayOrigin);
      if (gateway.protocol !== "https:" || gateway.username || gateway.password)
        throw new Error("Sandbox gateway must use public HTTPS");
      let response: Response;
      try {
        response = await call("/v2/sandboxes", {
          method: "POST",
          body: JSON.stringify({
            templateID: input.templateId,
            timeout: input.ttlSeconds,
            autoPause: false,
            autoResume: { enabled: false },
            metadata: input.metadata,
            network: {
              denyOut: ["0.0.0.0/0"],
              allowOut: input.role === "agent" ? [gateway.hostname] : [],
              allowPublicTraffic: false,
            },
          }),
        });
      } catch {
        throw new AmbiguousSandboxCreateError();
      }
      if (!response.ok) {
        if (response.status >= 500 || response.status === 408)
          throw new AmbiguousSandboxCreateError();
        const diagnostic = await response.text();
        throw new Error(
          `E2B creation refused (${response.status}): ${diagnostic.split(config.apiKey).join("[redacted]").slice(0, 500)}`,
        );
      }
      try {
        const created = record(await response.json());
        const inspected = await call(
          `/sandboxes/${encodeURIComponent(created.id)}`,
        );
        if (!inspected.ok) throw new Error("Inspect failed");
        return record(await inspected.json());
      } catch {
        throw new AmbiguousSandboxCreateError();
      }
    },
    async list(metadata) {
      const query = new URLSearchParams({
        metadata: new URLSearchParams(metadata).toString(),
        state: "running,paused",
        limit: "100",
      });
      const results: SandboxRecord[] = [];
      for (let page = 0; page < 100; page++) {
        const response = await call(`/v2/sandboxes?${query}`);
        if (!response.ok)
          throw new Error(`E2B list failed (${response.status})`);
        results.push(
          ...z
            .array(z.unknown())
            .parse(await response.json())
            .map(record),
        );
        const next = response.headers.get("x-next-token");
        if (!next) return results;
        query.set("nextToken", next);
      }
      throw new Error("E2B list pagination exceeded safe bound");
    },
    async inspect(id) {
      const response = await call(`/sandboxes/${encodeURIComponent(id)}`);
      if (response.status === 404) return null;
      if (!response.ok)
        throw new Error(`E2B inspect failed (${response.status})`);
      return record(await response.json());
    },
    connect: config.controller,
    async terminate(id) {
      const response = await call(`/sandboxes/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!response.ok && response.status !== 404)
        throw new Error(`E2B termination uncertain (${response.status})`);
    },
  };
}
