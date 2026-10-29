import { createHash } from "node:crypto";
import { loadBenchmark } from "../core/benchmarks";
import type { RemoteSandbox } from "./e2b";
import { z } from "zod";

export const canonicalSubmissionPath = "/home/user/task/src/solution.cjs";
export const canonicalSubmissionPolicy = "canonical-leaf-missing-rejected-v1";
const publicCases: Record<string, { args: unknown[]; expected: unknown }> = {
  "strict-csv": { args: ["alpha,beta"], expected: [["alpha", "beta"]] },
  "json-pointer-patch": {
    args: [{ x: 1 }, [{ op: "add", path: "/y", value: 2 }]],
    expected: { x: 1, y: 2 },
  },
  "exact-money-sum": { args: [["1.00", "2.00"]], expected: "3.00" },
  "weighted-lru": {
    args: [
      {
        capacity: 1,
        operations: [
          ["put", "x", 7, 1],
          ["get", "x"],
        ],
      },
    ],
    expected: { reads: [7], entries: [["x", 7, 1]] },
  },
  "timezone-interval-union": {
    args: [[["2025-01-01T00:00:00Z", "2025-01-01T00:01:00Z"]]],
    expected: [["2025-01-01T00:00:00.000Z", "2025-01-01T00:01:00.000Z"]],
  },
  "dependency-layers": {
    args: [
      [
        { id: "one", deps: [] },
        { id: "two", deps: ["one"] },
      ],
    ],
    expected: [["one"], ["two"]],
  },
};
export interface WorkspaceManifest {
  taskId: string;
  benchmarkHash: string;
  files: Record<string, string>;
  submissionPath: string;
  hash: string;
}
export async function buildTaskWorkspace(input: {
  benchmarkHash: string;
  taskId: string;
  benchmarkPath?: string;
}): Promise<WorkspaceManifest> {
  const benchmark = await loadBenchmark(
    input.benchmarkPath ?? "coding-adversarial-v1",
  );
  if (benchmark.hash !== input.benchmarkHash)
    throw new Error("Pinned benchmark bytes changed");
  const task = benchmark.tasks.find((task) => task.id === input.taskId);
  const smoke = publicCases[input.taskId];
  if (!task || !smoke) throw new Error("Unknown hosted benchmark task");
  const files = {
    "README.md": `${task.prompt}\n\nWrite your final exported function to src/solution.cjs. Run node test/public-smoke.cjs. Public smoke checks are illustrative; trusted acceptance checks run separately.\n`,
    "src/solution.cjs":
      "module.exports = function () { throw new Error('Implement the contract'); };\n",
    "test/public-smoke.cjs": `const assert = require('node:assert/strict');\nconst solution = require('../src/solution.cjs');\nassert.deepEqual(solution(...${JSON.stringify(smoke.args)}), ${JSON.stringify(smoke.expected)});\nconsole.log('Public smoke passed');\n`,
    "package.json":
      '{"private":true,"scripts":{"test":"node test/public-smoke.cjs"}}\n',
  };
  return {
    ...input,
    files,
    submissionPath: canonicalSubmissionPath,
    hash: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
  };
}
export interface SubmissionArtifact {
  contents: string;
  sha256: string;
  bytes: number;
  path: typeof canonicalSubmissionPath;
}
export class MissingSubmissionError extends Error {
  readonly reason = "missing_submission";
  constructor() {
    super("Canonical submission is missing.");
    this.name = "MissingSubmissionError";
  }
}
/** Paths are supplied only by the trusted platform; the agent never chooses them. */
export function createSubmissionExtractorScript(input: {
  submissionPath: string;
  ancestors: readonly string[];
}): string {
  return `const fs=require('node:fs'); const {submissionPath:path,ancestors}=${JSON.stringify(input)}; for(const item of ancestors){const s=fs.lstatSync(item);if(s.isSymbolicLink()||!s.isDirectory())throw Error('Unsafe submission path');} let leaf;try{leaf=fs.lstatSync(path);}catch(error){if(error&&error.code==='ENOENT'){process.stdout.write(JSON.stringify({kind:'missing_submission'}));process.exit(0);}throw error;} if(leaf.isSymbolicLink())throw Error('Unsafe submission path'); const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const s=fs.fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.size>65536)throw Error('Unsafe submission file');const bytes=fs.readFileSync(fd);fs.closeSync(fd);if(bytes.length>65536)throw Error('Submission too large');process.stdout.write(JSON.stringify({base64:bytes.toString('base64')}));`;
}
const missingSubmissionReceiptSchema = z
  .object({ kind: z.literal("missing_submission") })
  .strict();
const submissionBytesReceiptSchema = z.object({ base64: z.string() }).strict();
export async function extractSubmission(input: {
  remote: RemoteSandbox;
}): Promise<SubmissionArtifact> {
  // Root-owned extractor walks every ancestor, refuses links and opens with O_NOFOLLOW.
  const script = createSubmissionExtractorScript({
    submissionPath: canonicalSubmissionPath,
    ancestors: [
      "/home",
      "/home/user",
      "/home/user/task",
      "/home/user/task/src",
    ],
  });
  await input.remote.writeFile("/opt/loopbench/extract.cjs", script);
  const result = await input.remote.run("node /opt/loopbench/extract.cjs", {
    user: "root",
    timeoutMs: 5000,
  });
  if (result.exitCode !== 0)
    throw new Error("Canonical submission extraction failed");
  const raw: unknown = JSON.parse(result.stdout);
  if (missingSubmissionReceiptSchema.safeParse(raw).success)
    throw new MissingSubmissionError();
  const receipt = submissionBytesReceiptSchema.safeParse(raw);
  if (!receipt.success)
    throw new Error("Invalid submission extraction protocol");
  const bytes = Buffer.from(receipt.data.base64, "base64");
  if (bytes.toString("base64") !== receipt.data.base64)
    throw new Error("Invalid submission extraction protocol");
  if (!bytes.length || bytes.length > 65536 || bytes.includes(0))
    throw new Error("Invalid submission bytes");
  const contents = bytes.toString("utf8");
  if (!Buffer.from(contents).equals(bytes))
    throw new Error("Submission must be UTF-8");
  return {
    contents,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    path: canonicalSubmissionPath,
  };
}
