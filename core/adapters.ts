import { spawn } from "node:child_process";
import { z } from "zod";
import type { AdapterManifest, RunConfig } from "./types";

const responseSchema = z
  .object({
    output: z.string().max(256000),
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
  })
  .strict();
export type AdapterResponse = z.infer<typeof responseSchema>;
export interface ProcessResult {
  stdout: string;
  stderr: string;
}
export async function runProcess(
  command: string,
  args: string[],
  input: string,
  cwd: string,
  timeoutMs: number,
  maxBytes = 1_000_000,
  env?: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const stop = (error: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (process.platform === "win32" && child.pid) {
        const killer = spawn(
          "taskkill",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, shell: false, stdio: "ignore" },
        );
        killer.on("error", () => {
          /* Direct process termination below is the fallback. */
        });
        killer.unref();
      }
      if (child.pid) {
        child.once("close", () => reject(error));
        child.kill("SIGKILL");
        setTimeout(() => reject(error), 1000).unref();
      } else reject(error);
    };
    const timer = setTimeout(
      () => stop(new Error(`Process timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxBytes)
        stop(new Error("Process exceeded output limit"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxBytes)
        stop(new Error("Process exceeded output limit"));
    });
    child.on("error", stop);
    child.stdin.on("error", () => {
      /* Exit/error below carries the process failure. */
    });
    child.on("close", (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0)
        reject(
          new Error(`Process exited ${code ?? signal}: ${stderr.slice(-4000)}`),
        );
      else resolve({ stdout, stderr });
    });
    child.stdin.end(input);
  });
}
export async function callAdapter(
  manifest: AdapterManifest,
  task: { id: string; prompt: string },
  config: RunConfig,
  cwd: string,
): Promise<AdapterResponse> {
  const request = {
    protocol: "loopbench.task.v1",
    task,
    config: {
      model: config.model,
      harness: config.harness,
      settings: config.settings,
    },
    instructions: config.settings.instructions || "",
  };
  const result = await runProcess(
    manifest.command,
    manifest.args,
    JSON.stringify(request),
    cwd,
    manifest.timeoutMs,
  );
  try {
    return responseSchema.parse(JSON.parse(result.stdout.trim()));
  } catch {
    throw new Error(
      "Adapter must emit one valid loopbench.task.v1 JSON response with an output string",
    );
  }
}
