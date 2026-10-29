import { spawn } from "node:child_process";
let input = "";
for await (const chunk of process.stdin) input += chunk;
try {
  const request = JSON.parse(input);
  if (request.protocol !== "loopbench.task.v1" || typeof request.task?.prompt !== "string" || typeof request.config?.model !== "string") throw new Error("Invalid loopbench.task.v1 input");
  const prompt = ["Solve this coding task. Return only the requested JavaScript function. Do not inspect files or run commands; use the task specification below.", request.instructions || "", request.task.prompt].filter(Boolean).join("\n\n");
  const child = spawn("codex", ["exec", "--json", "--ignore-user-config", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--model", request.config.model, "-"], { cwd: process.cwd(), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; if (stdout.length > 800000) child.kill(); });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-12000); });
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  if (code !== 0) throw new Error(`codex exec exited ${code}: ${stderr.slice(-3000)}`);
  let output = null; let inputTokens; let outputTokens;
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.type === "item.completed" && event.item?.type === "agent_message") output = event.item.text;
    if (event.type === "turn.completed" && event.usage) { inputTokens = event.usage.input_tokens; outputTokens = event.usage.output_tokens; }
    if (event.type === "turn.failed") throw new Error(event.error?.message || "Codex turn failed");
  }
  if (typeof output !== "string") throw new Error("Codex emitted no final agent message");
  process.stdout.write(JSON.stringify({ output, inputTokens, outputTokens }));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
