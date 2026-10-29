import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

test("loopback relay accepts only inference, transports exact scoped request, and has no guest upstream connection", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "loopbench-token-relay-"),
  );
  const child = spawn(
    process.execPath,
    ["sandbox/pi/token-relay.mjs", directory, "0"],
    { windowsHide: true, stdio: "ignore" },
  );
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    // Tests choose a free port via the kernel. The ready marker records the actual port.
    const deadline = Date.now() + 5000;
    let port = 0;
    while (Date.now() < deadline) {
      try {
        port = Number(await readFile(path.join(directory, "ready"), "utf8"));
        break;
      } catch {
        await delay(50);
      }
    }
    assert(port > 0);
    const origin = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(origin + "/arbitrary-url")).status, 404);
    const pending = fetch(origin + "/api/inference/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer isolated-scope",
        "X-LoopBench-Request-Key": "isolated-request-key",
      },
      body: JSON.stringify({
        model: "fixture",
        messages: [{ role: "user", content: "✓" }],
      }),
    });
    let requestFile = "";
    while (Date.now() < deadline) {
      requestFile =
        (await readdir(directory)).find((n) => n.endsWith(".request.json")) ??
        "";
      if (requestFile) break;
      await delay(20);
    }
    assert(requestFile);
    const request = JSON.parse(
      await readFile(path.join(directory, requestFile), "utf8"),
    );
    assert.equal(request.headers.authorization, "Bearer isolated-scope");
    assert.equal(
      request.headers["x-loopbench-request-key"],
      "isolated-request-key",
    );
    assert.match(request.body, /✓/);
    await writeFile(
      path.join(directory, `${request.id}.response.json`),
      JSON.stringify({
        status: 200,
        contentType: "text/event-stream",
        body: Buffer.from("data: [DONE]\n\n").toString("base64"),
      }),
    );
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "data: [DONE]\n\n");
  } finally {
    child.kill();
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
});
