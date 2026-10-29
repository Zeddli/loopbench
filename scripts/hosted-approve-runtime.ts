import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { projectRoot } from "../core/store";
import { loadApprovedHarness } from "../hosted/harnesses";

// Offline only. Operator supplies previously observed immutable template/runtime metadata.
// Actual agent and verifier runtime versions are checked again inside each cloud attempt.
const { values } = parseArgs({
  options: {
    "template-id": { type: "string" },
    "verifier-template-id": { type: "string" },
    "node-version": { type: "string" },
    "cpu-count": { type: "string" },
    "memory-mib": { type: "string" },
    "verified-at": { type: "string" },
    output: { type: "string" },
  },
  strict: true,
});
const input = z
  .object({
    templateId: z
      .string()
      .regex(
        /^[a-zA-Z0-9_-]{8,200}$/,
        "Use the immutable template ID, not a moving alias",
      ),
    verifierTemplateId: z.string().regex(/^[a-zA-Z0-9_-]{8,200}$/),
    nodeVersion: z.string().regex(/^v24\.\d+\.\d+$/),
    cpuCount: z.coerce.number().int().positive().max(32),
    memoryMB: z.coerce.number().int().positive().max(131072),
    verifiedAt: z.string().datetime(),
  })
  .strict()
  .parse({
    templateId: values["template-id"],
    verifierTemplateId: values["verifier-template-id"],
    nodeVersion: values["node-version"],
    cpuCount: values["cpu-count"],
    memoryMB: values["memory-mib"],
    verifiedAt: values["verified-at"],
  });
if (Date.parse(input.verifiedAt) > Date.now())
  throw new Error("Runtime observation time cannot be in the future");
const digest = async (filename: string) =>
  createHash("sha256")
    .update(await readFile(path.join(projectRoot, "sandbox", "pi", filename)))
    .digest("hex");
const manifest = {
  schemaVersion: 1,
  piVersion: "1.4.0",
  ...input,
  supervisorSha256: await digest("supervisor.mjs"),
  toolDefinitionsSha256: await digest("request-identity.mjs"),
};
const output = path.resolve(
  values.output ??
    path.join(projectRoot, "sandbox", "pi", "runner-manifest.json"),
);
// Exclusive creation prevents silently replacing an approved runtime used by an existing lineage.
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
await loadApprovedHarness({
  templateId: input.templateId,
  verifierTemplateId: input.verifierTemplateId,
  manifestPath: output,
});
process.stdout.write(
  `Wrote operator-supplied runtime manifest to ${output}. No provider calls or template builds were performed.\n`,
);
