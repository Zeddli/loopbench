import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { projectRoot } from "../core/store";
import type { RemoteSandbox } from "./e2b";
import type { HarnessArtifact } from "./harnesses";
import { hashHarnessArtifact } from "./harnesses";
import type { WorkspaceManifest } from "./task-workspaces";
import {
  piExecutionSucceeded,
  replayPiLog,
  type PiRunState,
} from "./pi-events";

export interface PiExecutionHandle {
  pid: number;
  remote: RemoteSandbox;
  harnessHash: string;
}
export interface PiExecutionResult {
  state: PiRunState;
  success: boolean;
  log: string;
  complete: boolean;
}
export interface PiModel {
  id: string;
  contextWindow: number;
  maxTokens: number;
}
export async function startPi(input: {
  remote: RemoteSandbox;
  workspace: WorkspaceManifest;
  harness: HarnessArtifact;
  gatewayOrigin: string;
  gatewayToken: string;
  model: PiModel;
}): Promise<PiExecutionHandle> {
  const supervisor = await readFile(
    path.join(projectRoot, "sandbox", "pi", "supervisor.mjs"),
    "utf8",
  );
  const extension = await readFile(
    path.join(projectRoot, "sandbox", "pi", "request-identity.mjs"),
    "utf8",
  );
  const hash = (contents: string) =>
    createHash("sha256").update(contents).digest("hex");
  if (
    hash(supervisor) !== input.harness.runtime.supervisorSha256 ||
    hash(extension) !== input.harness.runtime.toolDefinitionsSha256
  )
    throw new Error("Runtime artifact integrity mismatch");
  const gateway = new URL(input.gatewayOrigin);
  if (
    (!input.remote.inferenceOrigin && gateway.protocol !== "https:") ||
    gateway.username ||
    gateway.password
  )
    throw new Error("HTTPS gateway required");
  const base = input.remote.inferenceOrigin ?? gateway.href.replace(/\/$/, "");
  if (
    input.remote.inferenceOrigin &&
    base !== "http://127.0.0.1:42661/api/inference/v1"
  )
    throw new Error("Unapproved controller inference relay");
  // mkdir is the remote once-only launch fence. A disconnected start is never blindly replayed.
  const prepared = await input.remote.run(
    "test -x /usr/bin/setpriv && install -d -m 700 /opt/loopbench/run && mkdir -m 700 /opt/loopbench/run/launch-claimed && install -d -m 755 /opt/loopbench/pi-agent /opt/loopbench/skills && install -d -o user -g user /home/user/task/src /home/user/task/test /home/user/.pi/agent /home/user/harness-skills",
    { user: "root" },
  );
  if (prepared.exitCode !== 0)
    throw new Error(
      `Sandbox workspace preparation failed: ${prepared.stderr.slice(0, 1000)}`,
    );
  for (const [name, contents] of Object.entries(input.workspace.files))
    await input.remote.writeFile(`/home/user/task/${name}`, contents);
  const harnessHash = hashHarnessArtifact(input.harness);
  await input.remote.writeFile(
    "/opt/loopbench/HARNESS.md",
    `${input.harness.systemPrompt}\n\nVerification policy: ${input.harness.verificationPolicy}.\n`,
  );
  for (const skill of input.harness.skills)
    await input.remote.writeFile(
      `/opt/loopbench/skills/${skill.name}/SKILL.md`,
      `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n${skill.instructions}\n`,
    );
  await input.remote.writeFile(
    "/opt/loopbench/pi-agent/models.json",
    JSON.stringify({
      providers: {
        loopbench: {
          baseUrl: base,
          api: "openai-completions",
          apiKey: "${LOOPBENCH_GATEWAY_TOKEN}",
          models: [
            {
              id: input.model.id,
              name: input.model.id,
              reasoning: false,
              input: ["text"],
              contextWindow: input.model.contextWindow,
              maxTokens: input.model.maxTokens,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              compat: { supportsStore: false },
            },
          ],
        },
      },
    }),
  );
  await input.remote.writeFile(
    "/opt/loopbench/pi-agent/settings.json",
    JSON.stringify({
      compaction: input.harness.compaction,
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
      cacheWarming: "off",
      quietStartup: true,
    }),
  );
  // Pi opens its credential store read/write even when the selected provider uses
  // an environment key. Only this empty ephemeral store is agent-writable.
  await input.remote.writeFile("/opt/loopbench/pi-agent/auth.json", "{}\n");
  await input.remote.writeFile("/opt/loopbench/supervisor.mjs", supervisor);
  await input.remote.writeFile(
    "/opt/loopbench/request-identity.mjs",
    extension,
  );
  await input.remote.writeFile(
    "/opt/loopbench/run/config.json",
    JSON.stringify({
      supervisorSha256: hash(supervisor),
      extensionSha256: hash(extension),
      piVersion: input.harness.runtime.piVersion,
      nodeVersion: input.harness.runtime.nodeVersion,
      gatewayToken: input.gatewayToken,
      modelId: input.model.id,
      tools:
        input.harness.tools === "read-write-edit-bash"
          ? "read,write,edit,bash"
          : "read,write,edit",
      skillNames: input.harness.skills.map((skill) => skill.name),
      timeoutMs: 480_000,
      prompt:
        "Read README.md, implement src/solution.cjs, and verify your solution using the public checks. Complete the task by saving the file.",
    }),
  );
  await input.remote.writeFile(
    "/etc/sudoers.d/99-loopbench",
    "user ALL=(ALL:ALL) !ALL\n",
  );
  const permissions = await input.remote.run(
    "chmod 440 /etc/sudoers.d/99-loopbench && chown root:root /etc/sudoers.d/99-loopbench && chown -R user:user /home/user/task && chown -R root:root /opt/loopbench && chmod 1777 /opt/loopbench/pi-agent && chmod 644 /opt/loopbench/pi-agent/models.json /opt/loopbench/pi-agent/settings.json && chown user:user /opt/loopbench/pi-agent/auth.json && chmod 600 /opt/loopbench/pi-agent/auth.json && chmod 700 /opt/loopbench/run && chmod 600 /opt/loopbench/run/config.json && chmod 755 /opt/loopbench && chmod 644 /opt/loopbench/supervisor.mjs /opt/loopbench/request-identity.mjs /opt/loopbench/HARNESS.md",
    { user: "root" },
  );
  if (permissions.exitCode !== 0)
    throw new Error(
      `Workspace isolation failed: ${permissions.stderr.slice(0, 1000)}`,
    );
  const privilegeProbe = await input.remote.run(
    'setpriv --no-new-privs --reuid=user --regid=user --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all node -e \'const fs=require("node:fs"),cp=require("node:child_process");const s=fs.readFileSync("/proc/self/status","utf8");if(process.getuid()===0||!/^NoNewPrivs:\\s+1$/m.test(s)||!/^CapEff:\\s+0+$/m.test(s)||!/^CapBnd:\\s+0+$/m.test(s))process.exit(1);if(cp.spawnSync("sudo",["-n","true"],{stdio:"ignore"}).status===0)process.exit(1);process.stdout.write("agent-confined");\'',
    { user: "root", timeoutMs: 5000 },
  );
  if (
    privilegeProbe.exitCode !== 0 ||
    privilegeProbe.stdout !== "agent-confined"
  )
    throw new Error(
      "Agent effective privilege boundary could not be verified; refusing execution",
    );
  const pid = await input.remote.start(
    "node /opt/loopbench/supervisor.mjs > /opt/loopbench/run/supervisor.stdout 2> /opt/loopbench/run/supervisor.stderr",
    { user: "root" },
  );
  return { pid, remote: input.remote, harnessHash };
}
export async function collectPiExecution(
  handle: PiExecutionHandle,
): Promise<PiExecutionResult> {
  // The supervisor appends its terminal log event before writing result.json.
  // Read the result marker first so a just-finished process cannot make a stale
  // log snapshot look corrupt between two controller requests.
  const result = await handle.remote.run(
    "if test -f /opt/loopbench/run/result.json; then cat /opt/loopbench/run/result.json; fi",
    { user: "root", timeoutMs: 5000 },
  );
  const read = await handle.remote.run(
    "test ! -f /opt/loopbench/run/events.jsonl || head -c 4194305 /opt/loopbench/run/events.jsonl",
    { user: "root", timeoutMs: 5000 },
  );
  if (read.exitCode !== 0) throw new Error("Pi durable log read failed");
  const parsed = replayPiLog(read.stdout);
  if (result.stdout) {
    z.object({
      type: z.literal("supervisor_end"),
      exitCode: z.number(),
      error: z.string().optional(),
    })
      .strict()
      .parse(JSON.parse(result.stdout));
    if (!parsed.state.processEnded || parsed.partial)
      throw new Error("Pi completion log incomplete");
  }
  return {
    state: parsed.state,
    log: read.stdout,
    success: piExecutionSucceeded(parsed.state),
    complete: Boolean(result.stdout),
  };
}
export async function stopPi(handle: PiExecutionHandle): Promise<void> {
  await handle.remote.killProcess(handle.pid);
}
