import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

// Real running HTTP service, real provider model-list access. Never starts paid inference or E2B.
const origin = process.env.LOOPBENCH_PUBLIC_ORIGIN ?? "http://127.0.0.1:3000";
async function session() {
  const response = await fetch(`${origin}/api/hosted/session`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1 }),
  });
  assert.equal(response.status, 201, "Session bootstrap failed");
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "Session cookie missing");
  return cookie;
}
async function inspect(response: Response) {
  const text = await response.text();
  if (response.status >= 400)
    throw new Error(
      `HTTP verification failed (${response.status}); provider details suppressed.`,
    );
  return z.object({ data: z.unknown() }).parse(JSON.parse(text)).data;
}
const cookie = await session();
const denied = await fetch(`${origin}/api/hosted/credentials`, {
  method: "POST",
  headers: {
    Origin: "https://untrusted.example",
    Cookie: cookie,
    "Content-Type": "application/json",
    "Idempotency-Key": randomUUID(),
  },
  body: JSON.stringify({ schemaVersion: 1 }),
});
assert.equal(denied.status, 403, "Cross-origin mutation was not rejected");
const empty = await inspect(
  await fetch(`${origin}/api/hosted/campaigns`, {
    headers: { Cookie: cookie },
  }),
);
assert.deepEqual(empty, []);
let selectedModelId: string | null = null,
  credentialId: string | null = null;
if (process.env.NEBIUS_API_KEY) {
  const connection = await inspect(
    await fetch(`${origin}/api/hosted/credentials`, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({
        schemaVersion: 1,
        provider: "nebius-token-factory",
        label: "Local connection verification",
        apiKey: process.env.NEBIUS_API_KEY,
      }),
    }),
  );
  credentialId = z
    .object({ id: z.string(), status: z.literal("verified") })
    .parse(connection).id;
  const response = await fetch(
    `${origin}/api/hosted/models?credentialId=${encodeURIComponent(credentialId)}`,
    { headers: { Cookie: cookie } },
  );
  const catalog = z
    .object({
      selectedModelId: z.string().nullable(),
      balanceStatus: z.literal("unknown"),
      models: z.array(z.object({ id: z.string(), enabled: z.boolean() })),
    })
    .parse(await inspect(response));
  selectedModelId = catalog.selectedModelId;
  assert.ok(
    selectedModelId,
    "No compatible priced Nemotron candidate is available",
  );
  const other = await session();
  assert.equal(
    (
      await fetch(
        `${origin}/api/hosted/models?credentialId=${encodeURIComponent(credentialId)}`,
        { headers: { Cookie: other } },
      )
    ).status,
    404,
    "Foreign credentials leaked",
  );
}
const directory = path.resolve(".loopbench/hosted");
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(
  path.join(directory, "verification-session.json"),
  JSON.stringify({ origin, cookie, credentialId }),
  { mode: 0o600 },
);
process.stdout.write(
  JSON.stringify({
    http: "verified",
    sameOriginMutations: "verified",
    foreignOwnerIsolation: "verified",
    catalog: selectedModelId
      ? "real-provider-verified"
      : "not-tested-no-inference-key",
    selectedModelId,
    balanceStatus: "unknown",
    paidInferenceCalls: 0,
    paidSandboxes: 0,
  }) + "\n",
);
