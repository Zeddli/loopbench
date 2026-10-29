import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { z } from "zod";
import {
  TokenSandboxClient,
  decodeProcessResult,
} from "../hosted/tokenfactory-client";

// v1 request was refused with HTTP 405 before creation; its journal is retained.
const file = ".loopbench/hosted/token-runtime-v2.json";
const client = new TokenSandboxClient({
  apiKey: process.env.NEBIUS_API_KEY ?? "",
  projectId: process.env.NEBIUS_PROJECT_ID ?? "",
});
const journalSchema = z.object({
  id: z.uuid(),
  phase: z.enum(["import_requested", "imported", "setup_requested", "ready"]),
  importOperationId: z.uuid().optional(),
  sourceImageId: z.uuid().optional(),
  setupOperationId: z.uuid().optional(),
  imageId: z.uuid().optional(),
});
let journal: z.infer<typeof journalSchema>;
async function save() {
  await writeFile(file + ".tmp", JSON.stringify(journal, null, 2), {
    mode: 0o600,
  });
  await rename(file + ".tmp", file);
}
try {
  journal = journalSchema.parse(JSON.parse(await readFile(file, "utf8")));
} catch (error) {
  if (!(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  ))
    throw error;
  journal = { id: randomUUID(), phase: "import_requested" };
  await writeFile(file, JSON.stringify(journal), { flag: "wx", mode: 0o600 });
  journal.importOperationId = await client.importImage(
    "docker://docker.io/library/node:24.15.0-bookworm",
  );
  await save();
}
if (!journal.importOperationId)
  throw Error(
    "Import outcome is uncertain; inspect owned provider operations before proceeding",
  );
if (journal.phase === "import_requested") {
  const op = await client.wait(journal.importOperationId, 330000);
  if (op.status !== "SUCCESS")
    throw Error(`Runtime import ${op.status}; no retry`);
  journal.sourceImageId = z
    .uuid()
    .parse(op.result_image_uuid ?? op.result?.image);
  journal.phase = "imported";
  await save();
}
if (journal.phase === "imported") {
  journal.phase = "setup_requested";
  await save();
  const setup =
    'set -eu; export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; apt-get update -qq; apt-get install -y -qq --no-install-recommends util-linux sudo >/dev/null; npm install -g @earendil-works/pi-coding-agent@1.4.0 >/dev/null; id user >/dev/null 2>&1 || useradd -m -s /bin/bash user; mkdir -p /etc/sudoers.d /opt/loopbench; node -e \'const cp=require("node:child_process");process.stdout.write(JSON.stringify({nodeVersion:process.version,piVersion:cp.execFileSync("pi",["--version"],{encoding:"utf8"}).trim(),setpriv:cp.execFileSync("which",["setpriv"],{encoding:"utf8"}).trim()}));\'';
  journal.setupOperationId = await client.spawn({
    image: z.uuid().parse(journal.sourceImageId),
    command: "/bin/sh",
    args: ["-lc", setup],
    env: { LOOPBENCH_SETUP_ID: journal.id },
    disposable: false,
    timeout: 600,
    networking: { enabled: true },
    truncate_output_at: 1048576,
  });
  await save();
}
if (journal.phase === "setup_requested") {
  if (!journal.setupOperationId)
    throw Error("Setup outcome uncertain; no automatic replay");
  const op = await client.wait(journal.setupOperationId);
  if (op.status !== "SUCCESS")
    throw Error(`Runtime setup ${op.status}; operation retained`);
  const result = decodeProcessResult(op.metadata?.result);
  if (result.exitCode !== 0)
    throw Error(
      `Runtime setup command failed (${result.exitCode}); inspect private operation`,
    );
  const observed = z
    .object({
      nodeVersion: z.string().regex(/^v24\.15\.0$/),
      piVersion: z.literal("1.4.0"),
      setpriv: z.string().min(1),
    })
    .parse(JSON.parse(result.stdout));
  journal.imageId = z.uuid().parse(op.result_image_uuid);
  journal.phase = "ready";
  await save();
  const hash = async (p: string) =>
    createHash("sha256")
      .update(await readFile(p))
      .digest("hex");
  const manifest = {
    schemaVersion: 1,
    provider: "tokenfactory",
    imageId: journal.imageId,
    sourceOperationId: op.uuid,
    ...observed,
    supervisorSha256: await hash("sandbox/pi/supervisor.mjs"),
    toolDefinitionsSha256: await hash("sandbox/pi/request-identity.mjs"),
    verifiedAt: new Date().toISOString(),
    networkPolicy: "guest-network-disabled;host-mediated-inference",
  };
  Object.assign(manifest, {
    relaySha256: await hash("sandbox/pi/token-relay.mjs"),
  });
  await writeFile(
    ".loopbench/hosted/token-runner-manifest.json",
    JSON.stringify(manifest, null, 2),
    { mode: 0o600 },
  );
}
process.stdout.write(
  JSON.stringify({
    event: "token.runtime",
    ...journal,
    costUsd: null,
    costStatus: "provider_units_unconfirmed",
  }) + "\n",
);
