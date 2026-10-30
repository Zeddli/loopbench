import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { writeAtomicJson } from "../core/atomic-json";
import { evolve } from "../core/evolution";
import { addAdapter } from "../core/store";

async function holdWindowsReader(directory: string, destination: string) {
  const script = path.join(directory, "hold-reader.ps1");
  await writeFile(
    script,
    `param([string]$TargetPath)
$ErrorActionPreference = 'Stop'
$stream = [System.IO.File]::Open($TargetPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
try { [Console]::WriteLine('LOCKED'); [Console]::In.ReadLine() | Out-Null } finally { $stream.Dispose() }
`,
  );
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      destination,
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = once(child, "close");
  let output = "",
    diagnostics = "";
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("LOCKED")) resolve();
    });
    child.on("close", () =>
      reject(new Error(`Reader exited before locking: ${diagnostics}`)),
    );
  });
  let released = false;
  return async () => {
    if (!released) {
      released = true;
      child.stdin.end("\n");
    }
    const [code] = await closed;
    assert.equal(code, 0, diagnostics);
  };
}

test(
  "atomic JSON replacement survives a Windows sharing lock without losing either payload",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "loopbench-atomic-"));
    const destination = path.join(directory, "record.json");
    await writeFile(destination, '{"version":"original"}');
    const release = await holdWindowsReader(directory, destination);
    try {
      let completed = false;
      const replacement = writeAtomicJson(destination, {
        version: "replacement",
      });
      void replacement.then(
        () => {
          completed = true;
        },
        () => {},
      );
      await delay(60);
      assert.equal(completed, false);
      assert.equal(
        await readFile(destination, "utf8"),
        '{"version":"original"}',
      );
      const temporary = (await readdir(directory)).find((file) =>
        file.endsWith(".tmp"),
      );
      assert(temporary);
      assert.deepEqual(
        JSON.parse(await readFile(path.join(directory, temporary), "utf8")),
        { version: "replacement" },
      );
      await release();
      await replacement;
      assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), {
        version: "replacement",
      });
      assert(!(await readdir(directory)).some((file) => file.endsWith(".tmp")));
    } finally {
      await release();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a recovered campaign-file conflict preserves known adapter usage without rerunning inference",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "loopbench-campaign-write-"),
    );
    const previous = process.env.LOOPBENCH_HOME;
    process.env.LOOPBENCH_HOME = directory;
    let release: (() => Promise<void>) | undefined;
    let releasing: Promise<void> | undefined;
    let cancelled = false;
    try {
      const adapter = path.join(directory, "adapter.mjs"),
        marker = path.join(directory, "invocations.txt"),
        benchmark = path.join(directory, "benchmark.json");
      await writeFile(
        adapter,
        `import { appendFileSync } from 'node:fs';
let input='';for await(const chunk of process.stdin)input+=chunk;
appendFileSync(process.argv[2], 'call\\n');
process.stdout.write(JSON.stringify({output:'module.exports = value => value + 1;',inputTokens:17,outputTokens:3,costUsd:0.001}));`,
      );
      await writeFile(
        benchmark,
        JSON.stringify({
          id: "atomic-write-fixture",
          name: "One real task",
          domain: "coding",
          tasks: [
            {
              id: "increment",
              prompt: "Return value plus one.",
              cases: [{ args: [2], expected: 3 }],
            },
          ],
        }),
      );
      await addAdapter({
        id: "atomic-write-fixture",
        name: "Local process fixture",
        command: process.execPath,
        args: [adapter, marker],
        protocol: "loopbench.task.v1",
        timeoutMs: 15000,
      });
      const campaign = await evolve(
        {
          adapterId: "atomic-write-fixture",
          proposerAdapterId: "atomic-write-fixture",
          domain: "coding",
          model: "local-process",
          harness: "fixture",
          benchmark,
          rounds: 1,
          maxCalls: 1,
        },
        async (current) => {
          if (!release && current.calls.at(-1)?.status === "reserved") {
            release = await holdWindowsReader(
              directory,
              path.join(directory, "campaigns", `${current.id}.json`),
            );
            const unlock = release;
            releasing = (async () => {
              while (!cancelled) {
                try {
                  await readFile(marker);
                  break;
                } catch (error) {
                  if (!(
                    error instanceof Error &&
                    "code" in error &&
                    error.code === "ENOENT"
                  ))
                    throw error;
                  await delay(5);
                }
              }
              await delay(60);
              await unlock();
            })();
          }
        },
      );
      await releasing;
      assert.equal(campaign.callsUsed, 1);
      assert.equal(
        campaign.calls[0]?.status,
        "completed",
        campaign.calls[0]?.error ?? undefined,
      );
      assert.equal(campaign.calls[0]?.inputTokens, 17);
      assert.equal(campaign.calls[0]?.outputTokens, 3);
      assert.equal(campaign.calls[0]?.costUsd, 0.001);
      assert.equal(await readFile(marker, "utf8"), "call\n");
    } finally {
      cancelled = true;
      await release?.();
      await releasing;
      if (previous === undefined) delete process.env.LOOPBENCH_HOME;
      else process.env.LOOPBENCH_HOME = previous;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
