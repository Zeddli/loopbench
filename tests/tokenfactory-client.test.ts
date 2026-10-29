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
