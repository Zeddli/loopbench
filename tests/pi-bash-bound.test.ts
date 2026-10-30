import assert from "node:assert/strict";
import test from "node:test";
import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function platformHandlers() {
  const handlers = new Map<
    string,
    (event: {
      toolName?: string;
      input?: Record<string, unknown>;
      headers?: Record<string, string>;
    }) => unknown
  >();
  const extension = await import(
    pathToFileURL(path.resolve("sandbox/pi/request-identity.mjs")).href
  );
  extension.default({
    on(
      name: string,
      handler: (event: {
        toolName?: string;
        input?: Record<string, unknown>;
        headers?: Record<string, string>;
      }) => unknown,
    ) {
      handlers.set(name, handler);
    },
  });
  return handlers;
}

test("platform bash bound supplies omitted timeout, caps oversized requests and preserves shorter limits", async () => {
  const handlers = await platformHandlers(),
    hook = handlers.get("tool_call");
  assert.ok(hook);
  for (const [requested, expected] of [
    [undefined, 15],
    [1000, 15],
    [2, 2],
    [0, 15],
    [-1, 15],
  ] as const) {
    const input: Record<string, unknown> = {
      command: "public check",
      ...(requested === undefined ? {} : { timeout: requested }),
    };
    hook({ toolName: "bash", input });
    assert.equal(input.timeout, expected);
  }
  const read = { path: "README.md" };
  hook({ toolName: "read", input: read });
  assert.deepEqual(read, { path: "README.md" });
  const headers: Record<string, string> = {};
  handlers.get("before_provider_headers")?.({ headers });
  assert.match(headers["X-LoopBench-Request-Key"], /^[a-f0-9-]{36}$/);
});

test("supported Pi bash timeout kills a real nonterminating process and allows a following repair command", async (t) => {
  const piPath =
    "C:/nvm4w/nodejs/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js";
  const shellPath = "C:/Program Files/Git/bin/bash.exe";
  try {
    await access(piPath);
    await access(shellPath);
  } catch {
    t.skip("Local pinned Pi/Git Bash integration unavailable on this host");
    return;
  }
  const pi = await import(pathToFileURL(piPath).href),
    hook = (await platformHandlers()).get("tool_call");
  assert.ok(hook);
  const bash = pi.createBashTool(process.cwd(), { shellPath });
  const input: Record<string, unknown> = {
    command: "while true; do sleep 1; done",
    timeout: 0.1,
  };
  hook({ toolName: "bash", input });
  await assert.rejects(bash.execute("bounded-process", input), /timed out/);
  const repair: Record<string, unknown> = { command: "printf repaired" };
  hook({ toolName: "bash", input: repair });
  const result = await bash.execute("following-repair", repair);
  assert.equal(result.content[0].text, "repaired");
});
