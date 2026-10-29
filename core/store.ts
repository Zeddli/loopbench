import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  adapterManifestSchema,
  nodeRecordSchema,
  lineageIdSchema,
  type AdapterManifest,
  type NodeRecord,
  type RunConfig,
  type TreeSummary,
} from "./types";

export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export function dataHome(): string {
  // Operator state is mounted at runtime and must never become a build asset.
  return path.resolve(
    /* turbopackIgnore: true */
    process.env.LOOPBENCH_HOME || path.join(projectRoot, ".loopbench"),
  );
}
export function treeIdentity(config: RunConfig): string {
  if (config.lineageId) {
    // Campaigns allocate a UUID or adopt an existing immutable tree identity.
    return lineageIdSchema.parse(config.lineageId);
  }
  return createHash("sha256")
    .update(
      JSON.stringify([
        config.domain,
        config.model,
        config.harness,
        config.benchmarkHash,
      ]),
    )
    .digest("hex")
    .slice(0, 20);
}
function safeId(id: string): string {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error("Invalid record ID");
  return id;
}
async function atomicJson(destination: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, destination);
}
export async function saveNode(node: NodeRecord): Promise<void> {
  const parsed = nodeRecordSchema.parse(node);
  const destination = path.join(
    dataHome(),
    "nodes",
    `${safeId(parsed.id)}.json`,
  );
  const previous = await getNode(parsed.id);
  if (
    previous &&
    (previous.status !== "running" ||
      previous.treeId !== parsed.treeId ||
      previous.parentId !== parsed.parentId ||
      previous.createdAt !== parsed.createdAt ||
      previous.hypothesis !== parsed.hypothesis ||
      previous.totalTasks !== parsed.totalTasks ||
      previous.harnessHash !== parsed.harnessHash ||
      JSON.stringify(previous.curriculum) !==
        JSON.stringify(parsed.curriculum) ||
      previous.event !== parsed.event ||
      JSON.stringify(previous.learning) !== JSON.stringify(parsed.learning) ||
      JSON.stringify(previous.config) !== JSON.stringify(parsed.config) ||
      JSON.stringify(previous.tasks) !==
        JSON.stringify(parsed.tasks.slice(0, previous.tasks.length)))
  ) {
    throw new Error("Completed nodes and node identity are immutable");
  }
  await atomicJson(destination, parsed);
}
export async function getNode(id: string): Promise<NodeRecord | null> {
  try {
    return nodeRecordSchema.parse(
      JSON.parse(
        await readFile(
          path.join(dataHome(), "nodes", `${safeId(id)}.json`),
          "utf8",
        ),
      ),
    );
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
async function jsonFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => path.join(directory, name));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}
export async function listTrees(): Promise<TreeSummary[]> {
  const trees = new Map<string, TreeSummary>();
  for (const file of await jsonFiles(path.join(dataHome(), "nodes"))) {
    const node = nodeRecordSchema.parse(
      JSON.parse(await readFile(file, "utf8")),
    );
    let tree = trees.get(node.treeId);
    if (!tree) {
      tree = {
        id: node.treeId,
        domain: node.config.domain,
        model: node.config.model,
        harness: node.config.harness,
        benchmarkId: node.config.benchmarkId,
        benchmarkHash: node.config.benchmarkHash,
        totalTasks: node.totalTasks,
        nodes: [],
        updatedAt: node.createdAt,
      };
      trees.set(tree.id, tree);
    }
    tree.nodes.push(node);
    const updatedAt = node.completedAt || node.createdAt;
    if (updatedAt > tree.updatedAt) tree.updatedAt = updatedAt;
  }
  return [...trees.values()]
    .map((tree) => ({
      ...tree,
      nodes: tree.nodes.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function getTree(id: string): Promise<TreeSummary | null> {
  return (await listTrees()).find((tree) => tree.id === id) || null;
}
export const builtInAdapter: AdapterManifest = {
  id: "codex-cli",
  name: "Codex CLI",
  command: process.execPath,
  args: [path.join(projectRoot, "adapters", "codex-cli.mjs")],
  description:
    "Installed Codex CLI. Uses existing login; runs read-only, ephemeral tasks with JSON event usage.",
  protocol: "loopbench.task.v1",
  timeoutMs: 120000,
};
export async function listAdapters(): Promise<AdapterManifest[]> {
  const adapters = [builtInAdapter];
  for (const file of await jsonFiles(path.join(dataHome(), "adapters")))
    adapters.push(
      adapterManifestSchema
        .strict()
        .parse(JSON.parse(await readFile(file, "utf8"))),
    );
  return adapters;
}
export async function addAdapter(
  raw: unknown,
  baseDirectory = process.cwd(),
): Promise<AdapterManifest> {
  const parsed = adapterManifestSchema.strict().parse(raw);
  const relative = (value: string) =>
    /^\.\.?[\\/]/.test(value) ? path.resolve(baseDirectory, value) : value;
  const manifest = {
    ...parsed,
    command: relative(parsed.command),
    args: parsed.args.map(relative),
  };
  if (manifest.id === builtInAdapter.id)
    throw new Error("The built-in codex-cli adapter cannot be replaced");
  const serialized = `${manifest.command} ${manifest.args.join(" ")}`;
  if (
    /(?:api[-_]?key|token|authorization|password|secret|bearer)(?:[= :]|$)|\bsk-[a-zA-Z0-9]{10,}/i.test(
      serialized,
    )
  )
    throw new Error(
      "Credentials must be provided through the process environment, never manifest arguments",
    );
  await atomicJson(
    path.join(dataHome(), "adapters", `${safeId(manifest.id)}.json`),
    manifest,
  );
  return manifest;
}
