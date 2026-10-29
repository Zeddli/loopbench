import { Template } from "e2b";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import {
  createAttemptSandbox,
  terminateOwnedSandbox,
  type SandboxHandle,
  type SandboxContext,
} from "../hosted/sandboxes";

const templateInputSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{2,60}$/),
    nodeVersion: z.string().regex(/^24\.\d+\.\d+$/),
    cpuCount: z.number().int().min(1).max(8),
    memoryMiB: z.number().int().min(512).max(8192),
  })
  .strict();
export type HostedTemplateInput = z.infer<typeof templateInputSchema>;
/** Deterministic SDK build recipe, with no local/global Pi mutation and no provider request. */
export function hostedTemplateRecipe(raw: HostedTemplateInput) {
  const input = templateInputSchema.parse(raw);
  return Template()
    .fromImage(`node:${input.nodeVersion}-bookworm`)
    .setUser("root")
    .runCmd(
      "apt-get update && apt-get install -y --no-install-recommends bash ca-certificates git procps util-linux sudo && apt-get clean && rm -rf /var/lib/apt/lists/*",
      { user: "root" },
    )
    .runCmd(
      "id user >/dev/null 2>&1 || useradd --create-home --shell /bin/bash user",
      { user: "root" },
    )
    .runCmd(
      "npm install --global --no-audit --no-fund @earendil-works/pi-coding-agent@1.4.0",
      { user: "root" },
    )
    .runCmd(
      `test "$(node --version)" = "v${input.nodeVersion}" && test "$(pi --version)" = "1.4.0" && test -x /usr/bin/setpriv && install -d -m 755 /opt/loopbench`,
      { user: "root" },
    )
    .setUser("user")
    .setWorkdir("/home/user");
}
export interface TemplateBuildContext {
  apiKey: string;
  /** Persist a separately admitted durable build intent BEFORE the SDK sends a request.
   * The operator must account for builds separately; no SDK/API server-side build TTL is documented.
   */
  admit(input: HostedTemplateInput): Promise<{ id: string }>;
  recordAccepted(
    intentId: string,
    result: { templateId: string; buildId: string; name: string },
  ): Promise<void>;
  markUncertain(intentId: string): Promise<void>;
}
/** Actual official SDK build launch. Never retries; caller retains its obligation until reconciled. */
export async function launchHostedTemplateBuild(
  raw: HostedTemplateInput,
  context: TemplateBuildContext,
) {
  const input = templateInputSchema.parse(raw);
  const template = hostedTemplateRecipe(input);
  const intent = await context.admit(input);
  try {
    const result = await Template.buildInBackground(template, input.name, {
      apiKey: context.apiKey,
      retries: 0,
      requestTimeoutMs: 60_000,
      cpuCount: input.cpuCount,
      memoryMB: input.memoryMiB,
      minFreeDiskMb: 0,
    });
    await context.recordAccepted(intent.id, {
      templateId: result.templateId,
      buildId: result.buildId,
      name: result.name,
    });
    return { intentId: intent.id, ...result };
  } catch (error) {
    await context.markUncertain(intent.id);
    throw error;
  }
}
const runtimeProbeSchema = z
  .object({
    nodeVersion: z.string(),
    piVersion: z.string().nullable(),
    hasSetpriv: z.boolean(),
    hasUser: z.boolean(),
    hasSha256sum: z.boolean(),
    hasPkill: z.boolean(),
  })
  .strict();
/** Bounded real inspection: uses the SAME durable sandbox admission/compute/slot ledger as task attempts. */
export async function inspectHostedTemplate(
  input: {
    intentId: string;
    ownerScope: string;
    campaignId: string;
    attemptId: string;
    templateId: string;
    gatewayOrigin: string;
  },
  context: SandboxContext,
  options?: {
    onTemplateResolved(intentId: string, templateId: string): Promise<void>;
  },
) {
  let handle: SandboxHandle;
  if (options) {
    // Explicit bootstrap-only alias resolution. The root callback durably pins the actual ID
    // before any controller operation, so reaper ownership checks retain that exact identity.
    await context.assertFence();
    const intent = await context.prepare({
      id: input.intentId,
      ownerScope: input.ownerScope,
      campaignId: input.campaignId,
      attemptId: input.attemptId,
      templateId: input.templateId,
      role: "verifier",
    });
    if (intent.status !== "prepared" || !(await context.claim(intent.id)))
      throw new Error(
        "Template probe already attempted; reconcile before another operation",
      );
    try {
      const expected = {
        application: "loopbench-hosted",
        intentId: intent.id,
        ownerScope: intent.ownerScope,
        campaignId: intent.campaignId,
        attemptId: intent.attemptId,
        role: intent.role,
      };
      const record = await context.transport.create({
        templateId: input.templateId,
        role: "verifier",
        ttlSeconds: 60,
        gatewayOrigin: input.gatewayOrigin,
        metadata: expected,
      });
      if (
        !Object.entries(expected).every(
          ([key, value]) => record.metadata[key] === value,
        ) ||
        record.state !== "running"
      )
        throw new Error("Template probe ownership mismatch");
      await options.onTemplateResolved(intent.id, record.templateId);
      await context.update(intent.id, "running", record.id);
      handle = {
        intent: {
          ...intent,
          templateId: record.templateId,
          sandboxId: record.id,
          status: "running",
        },
        record,
        remote: await context.transport.connect(record),
      };
    } catch (error) {
      await context.update(intent.id, "unknown");
      throw error;
    }
  } else {
    handle = await createAttemptSandbox(
      { ...input, id: input.intentId, role: "verifier", ttlSeconds: 60 },
      context,
    );
  }
  let cleanupConfirmed = false;
  try {
    const probe = `const fs=require('node:fs'),cp=require('node:child_process');const command=(file,args)=>{try{return cp.execFileSync(file,args,{encoding:'utf8',timeout:5000,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp'}}).trim()}catch{return null}};process.stdout.write(JSON.stringify({nodeVersion:process.version,piVersion:command('pi',['--version']),hasSetpriv:fs.existsSync('/usr/bin/setpriv'),hasUser:command('id',['-u','user'])!==null,hasSha256sum:command('sh',['-c','command -v sha256sum'])!==null,hasPkill:command('sh',['-c','command -v pkill'])!==null}));`;
    await handle.remote.writeFile("/tmp/loopbench-runtime-probe.cjs", probe);
    const result = await handle.remote.run(
      "node /tmp/loopbench-runtime-probe.cjs",
      { user: "root", timeoutMs: 20_000 },
    );
    if (result.exitCode !== 0) throw new Error("Template runtime probe failed");
    const runtime = runtimeProbeSchema.parse(JSON.parse(result.stdout));
    cleanupConfirmed = await terminateOwnedSandbox(handle, context);
    return {
      ...runtime,
      templateId: handle.record.templateId,
      cpuCount: handle.record.cpuCount,
      memoryMiB: handle.record.memoryMiB,
      cleanupConfirmed,
      compatible:
        runtime.piVersion === "1.4.0" &&
        /^v24\.\d+\.\d+$/.test(runtime.nodeVersion) &&
        runtime.hasSetpriv &&
        runtime.hasUser &&
        runtime.hasSha256sum &&
        runtime.hasPkill,
    };
  } finally {
    if (!cleanupConfirmed) await terminateOwnedSandbox(handle, context);
  }
}
async function main() {
  const { values } = parseArgs({
    options: {
      name: { type: "string", default: "loopbench-pi-1-4-0" },
      "node-version": { type: "string", default: "24.15.0" },
      "cpu-count": { type: "string", default: "2" },
      "memory-mib": { type: "string", default: "4096" },
    },
    strict: true,
  });
  const input = templateInputSchema.parse({
    name: values.name,
    nodeVersion: values["node-version"],
    cpuCount: Number(values["cpu-count"]),
    memoryMiB: Number(values["memory-mib"]),
  });
  const recipe = JSON.parse(await Template.toJSON(hostedTemplateRecipe(input)));
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, operation: "offline-template-plan", input, recipe, paidOperationsPerformed: false, execute: "Call launchHostedTemplateBuild only with a durable admitted build context, or inspectHostedTemplate with the normal sandbox ledger." }, null, 2)}\n`,
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void main().catch(() => {
    process.stderr.write(
      "Template planning failed before any paid operation.\n",
    );
    process.exitCode = 1;
  });
