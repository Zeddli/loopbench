import { createHash } from "node:crypto";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "../core/store";

const instruction = z
  .string()
  .max(24_000)
  .refine(
    (value) =>
      !/module\.exports\s*=|(?:api[_-]?key|bearer|sk-nebius)[\s:=]+\S{12,}|-----BEGIN .*PRIVATE KEY|!\s*(?:bash|curl|node)\b/i.test(
        value,
      ),
    "Harness must contain reusable instructions, not solutions, credentials or executable configuration",
  );
export const harnessArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    systemPrompt: instruction,
    skills: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
            description: z.string().min(1).max(200),
            instructions: instruction,
          })
          .strict(),
      )
      .max(12),
    tools: z.enum(["read-write-edit-bash", "read-write-edit"]),
    verificationPolicy: z.enum(["public-smoke", "public-smoke-and-review"]),
    compaction: z
      .object({
        enabled: z.boolean(),
        reserveTokens: z.number().int().min(1024).max(32768),
        keepRecentTokens: z.number().int().min(1024).max(32768),
      })
      .strict(),
    runtime: z
      .object({
        piVersion: z.literal("1.4.0"),
        nodeVersion: z.string().regex(/^v24\.\d+\.\d+$/),
        templateId: z.string().min(1).max(200),
        verifierTemplateId: z.string().min(1).max(200),
        supervisorSha256: z.string().regex(/^[a-f0-9]{64}$/),
        toolDefinitionsSha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict();
export type HarnessArtifact = z.infer<typeof harnessArtifactSchema>;
export function validateHarnessArtifact(raw: unknown): HarnessArtifact {
  return harnessArtifactSchema.parse(raw);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
export function hashHarnessArtifact(artifact: HarnessArtifact): string {
  return createHash("sha256")
    .update(canonical(validateHarnessArtifact(artifact)))
    .digest("hex");
}
export async function materializeHarnessArtifact(
  input: HarnessArtifact,
  context: { store(hash: string, bytes: string): Promise<string> },
): Promise<{ hash: string; ref: string }> {
  const artifact = validateHarnessArtifact(input);
  const hash = hashHarnessArtifact(artifact);
  return { hash, ref: await context.store(hash, canonical(artifact)) };
}
const approvedManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    piVersion: z.literal("1.4.0"),
    nodeVersion: z.string().regex(/^v24\.\d+\.\d+$/),
    templateId: z.string().min(1),
    verifierTemplateId: z.string().min(1),
    supervisorSha256: z.string().regex(/^[a-f0-9]{64}$/),
    toolDefinitionsSha256: z.string().regex(/^[a-f0-9]{64}$/),
    verifiedAt: z.string().datetime(),
    cpuCount: z.number().int().positive(),
    memoryMB: z.number().int().positive(),
  })
  .strict();
export async function loadApprovedHarness(input: {
  templateId: string;
  verifierTemplateId?: string;
  manifestPath?: string;
}): Promise<HarnessArtifact> {
  const manifest = approvedManifestSchema.parse(
    JSON.parse(
      await readFile(
        /* turbopackIgnore: true */
        input.manifestPath ??
          path.join(projectRoot, "sandbox", "pi", "runner-manifest.json"),
        "utf8",
      ),
    ),
  );
  if (
    manifest.templateId !== input.templateId ||
    (input.verifierTemplateId &&
      input.verifierTemplateId !== manifest.verifierTemplateId)
  )
    throw new Error("Approved template manifest mismatch");
  const digest = async (filename: string) =>
    createHash("sha256")
      .update(await readFile(path.join(projectRoot, "sandbox", "pi", filename)))
      .digest("hex");
  if (
    (await digest("supervisor.mjs")) !== manifest.supervisorSha256 ||
    (await digest("request-identity.mjs")) !== manifest.toolDefinitionsSha256
  )
    throw new Error(
      "Approved runner bytes changed; reapprove runtime manifest",
    );
  return validateHarnessArtifact({
    schemaVersion: 1,
    systemPrompt:
      "Solve the function contract in README.md. Inspect the workspace, write the canonical submission, and run the public smoke check. Check boundary conditions and preserve inputs where required.",
    skills: [],
    tools: "read-write-edit-bash",
    verificationPolicy: "public-smoke-and-review",
    compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 8192 },
    runtime: {
      piVersion: manifest.piVersion,
      nodeVersion: manifest.nodeVersion,
      templateId: manifest.templateId,
      verifierTemplateId: manifest.verifierTemplateId,
      supervisorSha256: manifest.supervisorSha256,
      toolDefinitionsSha256: manifest.toolDefinitionsSha256,
    },
  });
}
