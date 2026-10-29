import { spawn, execFileSync } from "node:child_process";
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

// The root-owned supervisor and logs stay outside the agent's editable workspace.
const root = "/opt/loopbench/run";
const config = JSON.parse(readFileSync(`${root}/config.json`, "utf8"));
const logPath = `${root}/events.jsonl`;
let bytes = 0;
function log(event) {
  const line = `${JSON.stringify(event).replaceAll(config.gatewayToken, "[REDACTED]")}\n`;
  bytes += Buffer.byteLength(line);
  if (bytes > 4_000_000) throw new Error("Pi output bound exceeded");
  appendFileSync(logPath, line, { mode: 0o600 });
}
function terminal(exitCode, error) {
  const result = {
    type: "supervisor_end",
    exitCode,
    ...(error ? { error } : {}),
  };
  try {
    log(result);
  } finally {
    writeFileSync(`${root}/result.json`, JSON.stringify(result), {
      mode: 0o600,
    });
  }
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let child;
try {
  if (hash(readFileSync(import.meta.filename)) !== config.supervisorSha256)
    throw new Error("Supervisor manifest mismatch");
  if (
    hash(readFileSync("/opt/loopbench/request-identity.mjs")) !==
    config.extensionSha256
  )
    throw new Error("Platform extension manifest mismatch");
  const env = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/home/user",
    PI_CODING_AGENT_DIR: "/opt/loopbench/pi-agent",
    PI_OFFLINE: "1",
    LOOPBENCH_GATEWAY_TOKEN: config.gatewayToken,
  };
  if (
    execFileSync("pi", ["--version"], { env, encoding: "utf8" }).trim() !==
      config.piVersion ||
    process.version !== config.nodeVersion
  )
    throw new Error("Pinned Pi/Node runtime mismatch");
  const uid = Number(
    execFileSync("id", ["-u", "user"], { encoding: "utf8" }).trim(),
  );
  const gid = Number(
    execFileSync("id", ["-g", "user"], { encoding: "utf8" }).trim(),
  );
  const args = [
    "--mode",
    "rpc",
    "--no-session",
    "--offline",
    "--no-approve",
    "--no-context-files",
    "--no-extensions",
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--extension",
    "/opt/loopbench/request-identity.mjs",
    "--provider",
    "loopbench",
    "--model",
    config.modelId,
    "--tools",
    config.tools,
    "--append-system-prompt",
    "/opt/loopbench/HARNESS.md",
  ];
  for (const name of config.skillNames)
    args.push("--skill", `/opt/loopbench/skills/${name}/SKILL.md`);
  // no_new_privs survives exec and all descendants, blocking sudo/setuid escalation.
  child = spawn(
    "/usr/bin/setpriv",
    [
      "--no-new-privs",
      `--reuid=${uid}`,
      `--regid=${gid}`,
      "--clear-groups",
      "--bounding-set=-all",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "pi",
      ...args,
    ],
    { cwd: "/home/user/task", env, stdio: ["pipe", "pipe", "pipe"] },
  );
  let buffer = "";
  let diagnostics = 0;
  let settled = false;
  let error = null;
  const timer = setTimeout(() => {
    error = "Pi deadline exceeded";
    child.kill("SIGKILL");
  }, config.timeoutMs);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    try {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 524_288)
        throw new Error("Pi frame exceeds bound");
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        log(event);
        if (event.type === "agent_settled") {
          settled = true;
          child.stdin.end();
        }
        if (
          event.type === "response" &&
          event.command === "prompt" &&
          !event.success
        ) {
          error = "Pi prompt rejected";
          child.stdin.end();
        }
      }
    } catch {
      error = "Pi protocol/output failure";
      child.kill("SIGKILL");
    }
  });
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk.length;
    if (diagnostics < 262_144)
      appendFileSync(`${root}/diagnostics.log`, chunk, { mode: 0o600 });
    else {
      error = "Pi diagnostic bound exceeded";
      child.kill("SIGKILL");
    }
  });
  child.on("error", () => {
    error = "Pi launch failed";
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    terminal(
      code ?? -1,
      error ??
        (!settled || buffer.trim()
          ? "Pi exited before valid settlement"
          : null),
    );
  });
  child.stdin.on("error", () => {});
  child.stdin.write(
    `${JSON.stringify({ id: "task-prompt", type: "prompt", message: config.prompt })}\n`,
  );
  process.on("SIGTERM", () => {
    error = "Pi cancelled";
    child.kill("SIGTERM");
  });
} catch {
  child?.kill("SIGKILL");
  terminal(-1, "Pi runtime/configuration validation failed");
  process.exitCode = 1;
}
