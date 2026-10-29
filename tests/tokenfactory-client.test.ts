import assert from "node:assert/strict";
import test from "node:test";
import {
  TokenSandboxClient,
  decodeProcessResult,
} from "../hosted/tokenfactory-client";

test("Token Factory client pins origin/project, rejects redirects and never retries uncertain creation", async () => {
  let calls = 0;
  const client = new TokenSandboxClient({
    apiKey: "isolated-key",
    projectId: "isolated-project",
    fetch: async (url, init) => {
      calls++;
      assert.equal(
        new URL(String(url)).origin,
        "https://api.tokenfactory.nebius.com",
      );
      assert.equal(
        new Headers(init?.headers).get("Project"),
        "isolated-project",
      );
      assert.equal(init?.redirect, "error");
      throw new TypeError("network failure");
    },
  });
  await assert.rejects(
    client.spawn({
      image: "00000000-0000-4000-8000-000000000001",
      command: "/bin/true",
      disposable: true,
      timeout: 30,
      networking: { enabled: false },
    }),
  );
  assert.equal(calls, 1);
});

test("process decoding preserves binary encoding and rejects truncated or interrupted evidence", () => {
  assert.equal(
    decodeProcessResult({
      state: { exit_code: 0 },
      stdout: {
        value: Buffer.from("✓").toString("base64"),
        encoding: "base64",
      },
      stderr: { value: "", encoding: "ascii" },
    }).stdout,
    "✓",
  );
  assert.throws(() =>
    decodeProcessResult({
      state: { exit_code: 0 },
      stdout: { value: "partial", encoding: "ascii", truncated: true },
    }),
  );
  assert.throws(() =>
    decodeProcessResult({ state: { exit_code: 0, timed_out: true } }),
  );
  assert.equal(
    decodeProcessResult({
      state: { exit_code: 0, signal: -1, timed_out: false },
    }).exitCode,
    0,
  );
});

test("OCI imports use the documented import route, not the catalog route", async () => {
  const client = new TokenSandboxClient({
    apiKey: "test",
    projectId: "test",
    fetch: async (url, init) => {
      assert.equal(
        new URL(String(url)).pathname,
        "/sandboxes/v1/images/import",
      );
      assert.equal(init?.method, "POST");
      return Response.json(
        { uuid: "00000000-0000-4000-8000-000000000001" },
        { status: 201 },
      );
    },
  });
  await client.importImage("docker://docker.io/library/node:24.15.0-bookworm");
});

test("operation status waits through documented 425 readiness without replaying creation", async () => {
  let calls = 0;
  const id = "00000000-0000-4000-8000-000000000001";
  const client = new TokenSandboxClient({
    apiKey: "test",
    projectId: "test",
    fetch: async (url, init) => {
      assert.equal(init?.method, "GET");
      calls++;
      return calls === 1
        ? new Response("not ready", {
            status: 425,
            headers: { "Retry-After": "0" },
          })
        : Response.json({ uuid: id, status: "EXECUTING", metadata: {} });
    },
  });
  assert.equal((await client.get(id)).status, "EXECUTING");
  assert.equal(calls, 2);
});

test("subprocess creation retries only an explicitly rejected 425 and never an ambiguous 504", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  for (const status of [425, 504]) {
    let calls = 0;
    const client = new TokenSandboxClient({
      apiKey: "test",
      projectId: "test",
      fetch: async (url, init) => {
        assert.equal(
          new URL(String(url)).pathname,
          `/sandboxes/v1/operations/${id}/subprocesses`,
        );
        assert.equal(init?.method, "POST");
        calls++;
        return calls === 1
          ? new Response("not ready or uncertain", {
              status,
              headers: { "Retry-After": "0" },
            })
          : Response.json({ spid: 2 }, { status: 201 });
      },
    });
    if (status === 425) {
      assert.equal(await client.startChild(id, { command: "/bin/true" }), 2);
      assert.equal(calls, 2);
    } else {
      await assert.rejects(
        client.startChild(id, { command: "/bin/true" }),
        /504/,
      );
      assert.equal(calls, 1);
    }
  }
});

test("subprocess HTTP failure exposes only fixed numeric status and never response text", async () => {
  const client = new TokenSandboxClient({
    apiKey: "test",
    projectId: "test",
    fetch: async () => new Response("PRIVATE-UPSTREAM-BODY", { status: 504 }),
  });
  await assert.rejects(
    client.startChild("00000000-0000-4000-8000-000000000001", {
      command: "/bin/true",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal("httpStatus" in error ? error.httpStatus : undefined, 504);
      assert.equal(JSON.stringify(error).includes("PRIVATE-"), false);
      assert.equal(error.message.includes("PRIVATE-"), false);
      return true;
    },
  );
});

test("interrupted process exposes safe state fields without subprocess output", () => {
  assert.throws(
    () =>
      decodeProcessResult({
        state: { exit_code: 137, signal: 9, timed_out: false },
        stdout: { value: "PRIVATE-STDOUT" },
        stderr: { value: "PRIVATE-STDERR" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        "processExitCode" in error ? error.processExitCode : undefined,
        137,
      );
      assert.equal(
        "processFailure" in error ? error.processFailure : undefined,
        "signaled",
      );
      assert.equal(JSON.stringify(error).includes("PRIVATE-"), false);
      return true;
    },
  );
});

test("a signaled Node heap failure retains its fixed category but no stderr", () => {
  assert.throws(
    () =>
      decodeProcessResult({
        state: { exit_code: -1, signal: 6 },
        stderr: {
          value:
            "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory PRIVATE-INPUT",
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        "processFailure" in error ? error.processFailure : undefined,
        "heap_exhausted",
      );
      assert.equal(JSON.stringify(error).includes("PRIVATE-INPUT"), false);
      return true;
    },
  );
});

test("HTTP 200 running subprocess snapshots require bounded GET polling without another POST", async () => {
  let posts = 0,
    gets = 0;
  const client = new TokenSandboxClient({
    apiKey: "test",
    projectId: "test",
    fetch: async (_url, init) => {
      if (init?.method === "POST") {
        posts++;
        return Response.json({ spid: 2 }, { status: 201 });
      }
      gets++;
      return Response.json(
        gets < 3
          ? {
              state: { exit_code: -1, signal: -1, timed_out: false },
              stdout: { value: "incomplete" },
            }
          : {
              state: { exit_code: 0, signal: -1, timed_out: false },
              stdout: { value: "complete" },
            },
      );
    },
  });
  const result = await client.runChild(
    "00000000-0000-4000-8000-000000000001",
    { command: "/bin/true" },
    2000,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "complete");
  assert.equal(posts, 1);
  assert.equal(gets, 3);
});

test("a running subprocess snapshot cannot be decoded as a completed command", () => {
  assert.throws(
    () =>
      decodeProcessResult({
        state: { exit_code: -1, signal: -1, timed_out: false },
      }),
    /not settled/,
  );
});

test("running subprocess polling stops at its deadline and terminal signals are never retried", async () => {
  for (const signal of [-1, 6]) {
    let gets = 0;
    const client = new TokenSandboxClient({
      apiKey: "test",
      projectId: "test",
      fetch: async (_url, init) => {
        assert.equal(init?.method, "GET");
        gets++;
        return Response.json({
          state: { exit_code: -1, signal, timed_out: false },
        });
      },
    });
    await assert.rejects(
      client.waitChild("00000000-0000-4000-8000-000000000001", 2, 30),
      signal === -1 ? /wait expired/ : /interrupted/,
    );
    assert.equal(gets, 1);
  }
});
