import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { getHostedContext } from "../hosted/database";
import { importSelectedArchive } from "../hosted/publication";

const args = process.argv.slice(2);
const source = args.find((arg) => !arg.startsWith("--"));
if (!source || !args.includes("--reviewed"))
  throw new Error(
    "Usage: tsx scripts/hosted-import-archive.ts <selected-tree.json> --reviewed. Review the sanitized source and provenance before publication.",
  );
const tree: unknown = JSON.parse(await readFile(source, "utf8"));
const snapshot = importSelectedArchive(
  { source: "legacy-local", reviewed: true, tree, operationId: randomUUID() },
  getHostedContext(),
);
process.stdout.write(
  JSON.stringify({
    snapshotId: snapshot.id,
    source: snapshot.source,
    sha256: snapshot.sha256,
    url: `/tree/${snapshot.id}`,
  }) + "\n",
);
