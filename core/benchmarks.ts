import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { projectRoot } from "./store";
import { runProcess } from "./adapters";

const builtInBenchmarks = new Map([
  ["coding-functions-v1", "coding-functions-v1.json"],
  ["coding-adversarial-v1", "coding-adversarial-v1.json"],
]);

const benchmarkSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  domain: z.literal("coding"),
  tasks: z
    .array(
      z.object({
        id: z.string().min(1),
        prompt: z.string().min(1),
        nonMutating: z.boolean().default(false),
        cases: z
          .array(
            z.object({
              label: z.string().min(1).optional(),
              args: z.array(z.unknown()),
              expected: z.unknown(),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});
export type Benchmark = z.infer<typeof benchmarkSchema> & {
  hash: string;
  sourcePath: string;
};
export async function loadBenchmark(idOrPath: string): Promise<Benchmark> {
  const builtInFile = builtInBenchmarks.get(idOrPath);
  const file = builtInFile
    ? path.join(projectRoot, "benchmarks", builtInFile)
    : path.resolve(idOrPath);
  const parsed = benchmarkSchema.parse(
    JSON.parse(await readFile(file, "utf8")),
  );
  if (new Set(parsed.tasks.map((task) => task.id)).size !== parsed.tasks.length)
    throw new Error("Benchmark task IDs must be unique");
  const evaluatorHash = createHash("sha256")
    .update(
      await readFile(path.join(projectRoot, "benchmarks", "evaluate.mjs")),
    )
    .digest("hex");
  const controllerHash = createHash("sha256")
    .update(await readFile(path.join(projectRoot, "core", "benchmarks.ts")))
    .digest("hex");
  return {
    ...parsed,
    hash: createHash("sha256")
      .update(
        JSON.stringify({ definition: parsed, evaluatorHash, controllerHash }),
      )
      .digest("hex"),
    sourcePath: file,
  };
}
export async function listBenchmarks(): Promise<
  Pick<Benchmark, "id" | "name" | "domain" | "hash">[]
> {
  const summaries = [];
  for (const benchmarkId of builtInBenchmarks.keys()) {
    const { id, name, domain, hash } = await loadBenchmark(benchmarkId);
    summaries.push({ id, name, domain, hash });
  }
  return summaries;
}
export async function evaluateCode(
  output: string,
  task: Benchmark["tasks"][number],
  cwd: string,
): Promise<{ passed: boolean; error: string | null }> {
  const evaluator = path.join(projectRoot, "benchmarks", "evaluate.mjs");
  const result = await runProcess(
    process.execPath,
    [
      "--permission",
      `--allow-fs-read=${evaluator}`,
      "--max-old-space-size=64",
      evaluator,
    ],
    JSON.stringify({
      output,
      cases: task.cases,
      nonMutating: task.nonMutating,
    }),
    cwd,
    15000,
    64000,
    { NODE_ENV: "production" },
  );
  try {
    return z
      .object({ passed: z.boolean(), error: z.string().nullable() })
      .strict()
      .parse(JSON.parse(result.stdout));
  } catch (cause) {
    throw new Error("Evaluator emitted an invalid result protocol", { cause });
  }
}
