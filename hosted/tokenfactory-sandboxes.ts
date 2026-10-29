import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  TokenSandboxClient,
  tokenTerminal,
  type TokenOperation,
  type TokenExec,
} from "./tokenfactory-client";
import type { SandboxContext, SandboxIntent } from "./sandboxes";
import type { RemoteSandbox, SandboxRecord } from "./e2b";
import { HostedError, now, type HostedContext, type Lease } from "./schema";
import { assertLease } from "./jobs";
import { withHostedTransaction } from "./database";
import { handleChatCompletion } from "./gateway";
import { validateHarnessArtifact } from "./harnesses";
import { revokeCampaignGatewayGrants } from "./gateway-tokens";
import { appendCampaignEvent } from "./events";

export const tokenHarnessId = "pi-1.4.0-tokenfactory";
const manifestSchema = z.object({
  provider: z.literal("tokenfactory"),
  imageId: z.uuid(),
  nodeVersion: z.string().regex(/^v24\.\d+\.\d+$/),
  piVersion: z.literal("1.4.0"),
  supervisorSha256: z.string(),
  toolDefinitionsSha256: z.string(),
  relaySha256: z.string(),
});
export async function loadTokenHarness(
  manifestPath = process.env.LOOPBENCH_TOKEN_RUNNER_MANIFEST ??
    ".loopbench/hosted/token-runner-manifest.json",
) {
  const manifest = manifestSchema.parse(
    JSON.parse(
      await readFile(/* turbopackIgnore: true */ manifestPath, "utf8"),
    ),
  );
  const hash = async (path: string) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  if (
    (await hash("sandbox/pi/supervisor.mjs")) !== manifest.supervisorSha256 ||
    (await hash("sandbox/pi/request-identity.mjs")) !==
      manifest.toolDefinitionsSha256 ||
    (await hash("sandbox/pi/token-relay.mjs")) !== manifest.relaySha256
  )
    throw Error("Token Factory runtime approval is stale");
  return validateHarnessArtifact({
    schemaVersion: 1,
    systemPrompt:
      "Solve the function contract in README.md. Inspect the workspace, write the canonical submission, and run the public smoke check. Check boundary conditions and preserve inputs where required.",
    skills: [],
    tools: "read-write-edit-bash",
    verificationPolicy: "public-smoke-and-review",
    compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 8192 },
    runtime: {
      piVersion: manifest.piVersion,
      nodeVersion: manifest.nodeVersion,
      templateId: manifest.imageId,
      verifierTemplateId: manifest.imageId,
      supervisorSha256: manifest.supervisorSha256,
      toolDefinitionsSha256: manifest.toolDefinitionsSha256,
    },
  });
}
type Ownership = {
  intentId: string;
  ownerScope: string;
  campaignId: string;
  attemptId: string;
  role: string;
  imageId: string;
};
export function tokenOperationOwned(expected: Ownership, op: TokenOperation) {
  const env = op.metadata?.env;
  return (
    op.image_uuid === expected.imageId &&
    op.metadata?.networking?.enabled === false &&
    env?.LOOPBENCH_INTENT === expected.intentId &&
    env.LOOPBENCH_OWNER === expected.ownerScope &&
    env.LOOPBENCH_CAMPAIGN === expected.campaignId &&
    env.LOOPBENCH_ATTEMPT === expected.attemptId &&
    env.LOOPBENCH_ROLE === expected.role
  );
}
export function initializeTokenSandboxes(context: HostedContext) {
  context.db.exec(
    "CREATE TABLE IF NOT EXISTS token_sandbox_intents(id TEXT PRIMARY KEY,owner_scope TEXT NOT NULL,campaign_id TEXT NOT NULL,attempt_id TEXT NOT NULL,role TEXT NOT NULL,image_id TEXT NOT NULL,status TEXT NOT NULL,operation_id TEXT UNIQUE,project_digest TEXT NOT NULL,resources_json TEXT,actual_cost_usd_micros INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;",
  );
}
const rowSchema = z.object({
  id: z.string(),
  owner_scope: z.string(),
  campaign_id: z.string(),
  attempt_id: z.string(),
  role: z.enum(["agent", "verifier"]),
  image_id: z.string(),
  status: z.enum(["prepared", "creating", "unknown", "running", "terminated"]),
  operation_id: z.string().nullable(),
  project_digest: z.string(),
});
type Row = z.infer<typeof rowSchema>;
const requestSchema = z
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

export function makeTokenSandboxContext(
  input: { lease: Lease },
  context: HostedContext,
): SandboxContext {
  initializeTokenSandboxes(context);
  const projectId = process.env.NEBIUS_PROJECT_ID ?? "";
  const projectDigest = createHash("sha256").update(projectId).digest("hex");
  const api = new TokenSandboxClient({
    apiKey: process.env.NEBIUS_API_KEY ?? "",
    projectId,
  });
  const relayStops = new Map<string, () => void>();
  function row(id: string) {
    const value = context.db
      .prepare(
        "SELECT * FROM token_sandbox_intents WHERE id=? AND owner_scope=? AND campaign_id=?",
      )
      .get(id, input.lease.ownerScope, input.lease.campaignId);
    if (!value) throw new HostedError("NOT_FOUND", "Not found.", 404);
    const parsed = rowSchema.parse(value);
    if (parsed.project_digest !== projectDigest)
      throw Error("Sandbox project changed; reconciliation required");
    return parsed;
  }
  function intent(r: Row): SandboxIntent {
    return {
      id: r.id,
      ownerScope: r.owner_scope,
      campaignId: r.campaign_id,
      attemptId: r.attempt_id,
      role: r.role,
      templateId: r.image_id,
      status: r.status,
      sandboxId: r.operation_id,
    };
  }
  function ownership(r: Row): Ownership {
    return {
      intentId: r.id,
      ownerScope: r.owner_scope,
      campaignId: r.campaign_id,
      attemptId: r.attempt_id,
      role: r.role,
      imageId: r.image_id,
    };
  }
  function record(r: Row, op: TokenOperation): SandboxRecord {
    if (!tokenOperationOwned(ownership(r), op))
      throw Error("Token Factory ownership or network-policy mismatch");
    return {
      id: op.uuid,
      templateId: r.image_id,
      state: "running",
      endAt: "",
      metadata: {
        application: "loopbench-hosted",
        intentId: r.id,
        ownerScope: r.owner_scope,
        campaignId: r.campaign_id,
        attemptId: r.attempt_id,
        role: r.role,
      },
    };
  }
  function byOperation(id: string) {
    const value = context.db
      .prepare(
        "SELECT id FROM token_sandbox_intents WHERE operation_id=? AND owner_scope=? AND campaign_id=?",
      )
      .get(id, input.lease.ownerScope, input.lease.campaignId);
    if (!value) throw Error("Unknown owned operation");
    return row(String(value.id));
  }
  async function connect(r: Row): Promise<RemoteSandbox> {
    const id = z.uuid().parse(r.operation_id);
    const op = await api.get(id);
    record(r, op);
    if (tokenTerminal(op)) throw Error("Operation already ended");
    const exec = (command: string, user = "root"): TokenExec => ({
      command: user === "root" ? "/bin/sh" : "/usr/bin/setpriv",
      args:
        user === "root"
          ? ["-lc", command]
          : [
              "--no-new-privs",
              "--reuid=user",
              "--regid=user",
              "--clear-groups",
              "--bounding-set=-all",
              "--inh-caps=-all",
              "--ambient-caps=-all",
              "/bin/sh",
              "-lc",
              command,
            ],
      env: { PATH: "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
      uid: 0,
      gid: 0,
    });
    const remote: RemoteSandbox = {
      id,
      async writeFile(path, contents) {
        const result = await api.runChild(id, {
          command: "/usr/local/bin/node",
          args: [
            "-e",
            `const fs=require('node:fs'),p=require('node:path');fs.mkdirSync(p.dirname(process.argv[1]),{recursive:true});fs.writeFileSync(process.argv[1],fs.readFileSync(0),{mode:0o644});`,
            path,
          ],
          stdin: {
            value: Buffer.from(contents).toString("base64"),
            encoding: "base64",
            close: true,
          },
        });
        if (result.exitCode !== 0)
          throw Error(
            `Token Factory file write failed (${path}, exit ${result.exitCode}): ${result.stderr.slice(0, 1500)}`,
          );
      },
      async readFile(path) {
        const result = await api.runChild(id, {
          command: "/usr/local/bin/node",
          args: [
            "-e",
            "process.stdout.write(require('node:fs').readFileSync(process.argv[1]));",
            path,
          ],
        });
        if (result.exitCode !== 0)
          throw Error("Token Factory file read failed");
        return result.stdout;
      },
      run: (command, options) =>
        api.runChild(
          id,
          exec(command, options?.user),
          options?.timeoutMs ?? 20000,
        ),
      start: (command, options) =>
        api.startChild(id, exec(command, options?.user)),
      async killProcess(spid) {
        const response = await api.call(
          `/operations/${id}/subprocesses/${spid}?signal=SIGTERM`,
          "DELETE",
        );
        if (!response.ok) throw Error("Subprocess termination not confirmed");
      },
    };
    const network = await remote.run(
      'node -e \'const fs=require("node:fs");if(fs.readdirSync("/sys/class/net").some(x=>x!=="lo"))process.exit(1);process.stdout.write("no-guest-network");\'',
    );
    if (network.exitCode !== 0 || network.stdout !== "no-guest-network")
      throw Error("Guest network isolation not verified");
    if (r.role === "agent") {
      await remote.writeFile(
        "/opt/loopbench/token-relay.mjs",
        await readFile("sandbox/pi/token-relay.mjs", "utf8"),
      );
      await remote.start("node /opt/loopbench/token-relay.mjs >/dev/null 2>&1");
      const deadline = Date.now() + 10000;
      let ready = false;
      while (Date.now() < deadline) {
        const result = await remote.run(
          "test -f /opt/loopbench/relay/ready && cat /opt/loopbench/relay/ready || true",
        );
        if (result.stdout === "42661") {
          ready = true;
          break;
        }
        await delay(100);
      }
      if (!ready) throw Error("Inference relay did not become ready");
      remote.inferenceOrigin = "http://127.0.0.1:42661/api/inference/v1";
      let stopped = false;
      const seen = new Set<string>();
      relayStops.set(id, () => {
        stopped = true;
      });
      const pump = async () => {
        while (!stopped) {
          try {
            const result = await remote.run(
              'node -e \'const fs=require("node:fs"),d="/opt/loopbench/relay";process.stdout.write(JSON.stringify(fs.readdirSync(d).filter(x=>/^[0-9a-f-]+\\.request\\.json$/.test(x)).slice(0,2).map(x=>JSON.parse(fs.readFileSync(d+"/"+x,"utf8")))));\'',
            );
            if (result.exitCode !== 0) throw Error("Relay polling failed");
            const requests = z
              .array(requestSchema)
              .max(2)
              .parse(JSON.parse(result.stdout));
            for (const request of requests) {
              if (seen.has(request.id)) continue;
              seen.add(request.id);
              assertLease(input.lease, context);
              const response = await handleChatCompletion(
                new Request(
                  `${context.config.gatewayOrigin.replace(/\/$/, "")}/api/inference/v1/chat/completions`,
                  {
                    method: "POST",
                    headers: request.headers,
                    body: request.body,
                  },
                ),
                context,
              );
              const bytes = Buffer.from(await response.arrayBuffer());
              if (bytes.length > 4194304)
                throw Error("Relay response exceeded limit");
              const body = JSON.stringify({
                status: response.status,
                contentType: response.headers.get("content-type"),
                body: bytes.toString("base64"),
              });
              await remote.writeFile(
                `/opt/loopbench/relay/${request.id}.response.tmp`,
                body,
              );
              const delivery = await remote.run(
                `mv /opt/loopbench/relay/${request.id}.response.tmp /opt/loopbench/relay/${request.id}.response.json`,
              );
              if (delivery.exitCode !== 0) throw Error("Relay delivery failed");
            }
          } catch {
            stopped = true; /* Pi times out; no provider POST is replayed. */
          }
          if (!stopped) await delay(750);
        }
      };
      void pump();
    }
    return remote;
  }
  const transport: SandboxContext["transport"] = {
    async create(request) {
      const r = row(request.metadata.intentId);
      const operationId = await api.spawn({
        image: r.image_id,
        command: "/usr/local/bin/node",
        args: [
          "-e",
          "process.stdout.write('loopbench-ready');setTimeout(()=>process.exit(0),570000);",
        ],
        env: {
          LOOPBENCH_INTENT: r.id,
          LOOPBENCH_OWNER: r.owner_scope,
          LOOPBENCH_CAMPAIGN: r.campaign_id,
          LOOPBENCH_ATTEMPT: r.attempt_id,
          LOOPBENCH_ROLE: r.role,
        },
        disposable: true,
        timeout: 600,
        networking: { enabled: false },
        resources_limits: { max_layer_bytes: 2147483648 },
        truncate_output_at: 1048576,
      });
      context.db
        .prepare(
          "UPDATE token_sandbox_intents SET operation_id=?,updated_at=? WHERE id=? AND operation_id IS NULL",
        )
        .run(operationId, now(context), r.id);
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const op = await api.get(operationId);
        if (["ASSIGNED", "EXECUTING"].includes(op.status))
          return record(row(r.id), op);
        if (tokenTerminal(op)) throw Error("Sandbox ended during startup");
        await delay(300);
      }
      throw Error("Sandbox startup wait expired; identity retained");
    },
    async inspect(id) {
      const r = byOperation(id),
        op = await api.get(id);
      record(r, op);
      return tokenTerminal(op) ? null : record(r, op);
    },
    async list(metadata) {
      const r = row(metadata.intentId);
      if (!r.operation_id) return [];
      const op = await api.get(r.operation_id);
      return tokenTerminal(op) ? [] : [record(r, op)];
    },
    connect: (record) => connect(row(record.metadata.intentId)),
    async terminate(id) {
      const r = byOperation(id),
        op = await api.get(id);
      record(r, op);
      relayStops.get(id)?.();
      if (!tokenTerminal(op)) await api.cancel(id);
      const final = await api.wait(id, 30000);
      if (!tokenTerminal(final)) throw Error("Cancellation uncertain");
      context.db
        .prepare(
          "UPDATE token_sandbox_intents SET resources_json=?,updated_at=? WHERE id=?",
        )
        .run(
          JSON.stringify({
            duration: final.duration,
            resources: final.metadata?.result ?? null,
            monetaryCostUsd: null,
          }),
          now(context),
          r.id,
        );
    },
  };
  return {
    transport,
    async assertFence() {
      assertLease(input.lease, context);
    },
    async prepare(value) {
      return withHostedTransaction(context.db, () => {
        assertLease(input.lease, context);
        const existing = context.db
          .prepare("SELECT id FROM token_sandbox_intents WHERE id=?")
          .get(value.id);
        if (existing) return intent(row(value.id));
        const campaign = context.db
          .prepare(
            "SELECT desired_control FROM campaigns WHERE owner_scope=? AND id=?",
          )
          .get(value.ownerScope, value.campaignId);
        if (
          campaign?.desired_control !== "run" ||
          value.ownerScope !== input.lease.ownerScope ||
          value.campaignId !== input.lease.campaignId
        )
          throw Error("Campaign is not admitting work");
        const active =
          Number(
            context.db
              .prepare(
                "SELECT COUNT(*) AS n FROM token_sandbox_intents WHERE status!='terminated'",
              )
              .get()?.n ?? 0,
          ) +
          Number(
            context.db
              .prepare(
                "SELECT COUNT(*) AS n FROM budget_reservations WHERE sandbox_slot=1 AND state IN ('held','uncertain')",
              )
              .get()?.n ?? 0,
          );
        if (active >= 2)
          throw new HostedError(
            "GLOBAL_CAPACITY",
            "Two execution slots are already held.",
            429,
          );
        context.db
          .prepare(
            "INSERT INTO token_sandbox_intents VALUES(?,?,?,?,?,?,'prepared',NULL,?,NULL,NULL,?,?)",
          )
          .run(
            value.id,
            value.ownerScope,
            value.campaignId,
            value.attemptId,
            value.role,
            value.templateId,
            projectDigest,
            now(context),
            now(context),
          );
        return intent(row(value.id));
      });
    },
    async get(id) {
      return intent(row(id));
    },
    async claim(id) {
      assertLease(input.lease, context);
      return (
        context.db
          .prepare(
            "UPDATE token_sandbox_intents SET status='creating',updated_at=? WHERE id=? AND status='prepared'",
          )
          .run(now(context), id).changes === 1
      );
    },
    async update(id, status, operationId) {
      context.db
        .prepare(
          "UPDATE token_sandbox_intents SET status=?,operation_id=COALESCE(?,operation_id),updated_at=? WHERE id=?",
        )
        .run(status, operationId ?? null, now(context), row(id).id);
    },
    async confirmTerminated(id) {
      const r = row(id);
      if (!r.operation_id || !tokenTerminal(await api.get(r.operation_id)))
        throw Error("Provider termination not confirmed");
      context.db
        .prepare(
          "UPDATE token_sandbox_intents SET status='terminated',updated_at=? WHERE id=?",
        )
        .run(now(context), r.id);
    },
  };
}

export async function reapTokenSandboxes(context: HostedContext) {
  initializeTokenSandboxes(context);
  const result = { checked: 0, terminated: 0, uncertain: 0 };
  const projectId = process.env.NEBIUS_PROJECT_ID,
    apiKey = process.env.NEBIUS_API_KEY;
  if (!projectId || !apiKey) return result;
  const digest = createHash("sha256").update(projectId).digest("hex"),
    api = new TokenSandboxClient({ apiKey, projectId });
  const rows = context.db
    .prepare(
      "SELECT t.* FROM token_sandbox_intents t JOIN campaigns c ON c.id=t.campaign_id WHERE t.status!='terminated' AND (c.desired_control!='run' OR NOT EXISTS(SELECT 1 FROM jobs j WHERE j.campaign_id=t.campaign_id AND j.state IN ('leased','running') AND j.lease_expires_at>?)) LIMIT 100",
    )
    .all(now(context))
    .map((value) => rowSchema.parse(value));
  for (const r of rows) {
    result.checked++;
    try {
      if (r.project_digest !== digest) throw Error("Project changed");
      if (!r.operation_id) {
        if (r.status === "prepared") {
          const changed = context.db
            .prepare(
              "UPDATE token_sandbox_intents SET status='terminated',updated_at=? WHERE id=? AND status='prepared' AND operation_id IS NULL",
            )
            .run(now(context), r.id).changes;
          if (changed) {
            result.terminated++;
            continue;
          }
          throw Error("Intent advanced during reconciliation");
        }
        // Discovery proves a matching accepted operation; an empty list never proves no charge.
        const list = z
          .object({ operations: z.array(z.object({ uuid: z.uuid() })) })
          .parse(await api.json("/operations"));
        const matches: TokenOperation[] = [];
        for (const item of list.operations.slice(0, 100)) {
          const op = await api.get(item.uuid);
          if (op.metadata?.env?.LOOPBENCH_INTENT === r.id) matches.push(op);
        }
        if (matches.length !== 1)
          throw Error("Ambiguous creation needs operator reconciliation");
        r.operation_id = matches[0].uuid;
        context.db
          .prepare(
            "UPDATE token_sandbox_intents SET operation_id=?,updated_at=? WHERE id=? AND operation_id IS NULL",
          )
          .run(r.operation_id, now(context), r.id);
      }
      let op = await api.get(r.operation_id);
      if (
        !tokenOperationOwned(
          {
            intentId: r.id,
            ownerScope: r.owner_scope,
            campaignId: r.campaign_id,
            attemptId: r.attempt_id,
            role: r.role,
            imageId: r.image_id,
          },
          op,
        )
      )
        throw Error("Ownership not proven");
      if (!tokenTerminal(op)) {
        await api.cancel(op.uuid);
        op = await api.wait(op.uuid, 30000);
      }
      if (!tokenTerminal(op)) throw Error("Operation still active");
      withHostedTransaction(context.db, () => {
        context.db
          .prepare(
            "UPDATE token_sandbox_intents SET status='terminated',resources_json=?,updated_at=? WHERE id=?",
          )
          .run(
            JSON.stringify({
              duration: op.duration,
              resources: op.metadata?.result ?? null,
              monetaryCostUsd: null,
            }),
            now(context),
            r.id,
          );
        context.db
          .prepare(
            "UPDATE hosted_attempts SET status='infrastructure_failed',updated_at=? WHERE id=? AND status='running'",
          )
          .run(now(context), r.attempt_id);
        revokeCampaignGatewayGrants(r.campaign_id, context);
        appendCampaignEvent(
          {
            ownerScope: r.owner_scope,
            campaignId: r.campaign_id,
            type: "token_sandbox.reaped",
            payload: {
              intentId: r.id,
              operationId: op.uuid,
              cleanup: "confirmed",
              computeCostStatus: "not_reported",
            },
          },
          context,
        );
      });
      result.terminated++;
    } catch {
      result.uncertain++;
    }
  }
  return result;
}
