import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { loadBenchmark, type Benchmark } from "./benchmarks";
import { dataHome } from "./store";
import {
  curriculumOracle,
  curriculumTaskIdSchema,
  curriculumTaskIds,
  type CurriculumTaskId,
} from "./curriculum-oracles";

const version = "verified-coding-curriculum-v1";
const pinSchema = z
  .object({
    taskId: z.string(),
    case: z
      .object({
        label: z.string().min(1).optional(),
        args: z.array(z.json()),
        expected: z.json(),
      })
      .strict(),
  })
  .strict();
const metadataSchema = z
  .object({
    generator: z.literal(version),
    baseBenchmarkPath: z.string(),
    baseBenchmarkHash: z.string(),
    generatorSourceHash: z.string(),
    seed: z.string(),
    level: z.number().int().positive(),
    retainedLevels: z.array(z.number().int().positive()),
    pinnedLevels: z.array(z.number().int().positive()).default([]),
    retention: z.literal(
      "all base cases and failure pins, level-one anchors, latest eight levels",
    ),
    baseCaseCount: z.number().int(),
    newCaseCount: z.number().int(),
    caseCount: z.number().int(),
    pinnedCaseCount: z.number().int().nonnegative(),
    pinnedCases: z.array(pinSchema),
  })
  .strict();

export class NeedsBenchmarkExtensionError extends Error {
  readonly code = "needs_benchmark_extension";
  constructor(message: string) {
    super(message);
    this.name = "NeedsBenchmarkExtensionError";
  }
}

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
type Case = Benchmark["tasks"][number]["cases"][number];

function random(seed: string) {
  let state = Number.parseInt(hash(seed).slice(0, 8), 16) || 1;
  return (limit: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % limit;
  };
}

function generatedArguments(
  id: CurriculumTaskId,
  level: number,
  seed: string,
): { category: string; args: unknown[] }[] {
  const next = random(`${version}:${seed}:${level}:${id}`);
  const size = Math.min(96, 12 + level * 4);
  const token = hash(`${seed}:${level}:${id}`).slice(0, 16);
  const cases: { category: string; args: unknown[] }[] = [];
  const add = (category: string, ...args: unknown[]) =>
    cases.push({ category, args });
  switch (id) {
    case "strict-csv": {
      const rows = Array.from({ length: size }, (_, i) => [
        `${token}:${i}`,
        `comma,${next(1000)}`,
        `quote"${next(1000)}`,
        `line\r\n${i}\nend`,
        i % 2 ? "" : " ",
      ]);
      const encoded = rows
        .map((row) =>
          row.map((field) => `"${field.replace(/"/g, '""')}"`).join(","),
        )
        .join("\r\n");
      add("many escaped multiline records", encoded);
      add("final CRLF and empty final field", `${encoded},\r\n`);
      add("mixed LF and blank rows", `${token},x\n\n${encoded}\n\n`);
      add("late unclosed quoted field", `${encoded}\r\n"${token}`);
      add("late extra text after closing quote", `${encoded}\r\n"${token}"x`);
      add("late bare CR", `${encoded}\r${token}`);
      add("late unquoted quote", `${encoded}\r\n${token}"bad`);
      add("literal bare CR within quotes", `"${token}\r\r\n",,""\n`);
      break;
    }
    case "exact-money-sum": {
      const whole = `${next(9) + 1}${Array.from({ length: Math.min(35, 16 + level) }, () => String(next(10))).join("")}`;
      const positive = Array.from(
        { length: size },
        (_, i) =>
          `${next(100000)}.${String(next(1000000)).padStart(6, "0")}${"0".repeat(i % 7)}`,
      );
      const cancellation = positive.flatMap((value) => [value, `-${value}`]);
      add("mixed-scale arbitrary precision", [
        ...positive,
        `${whole}.009`,
        `-${whole}.001`,
      ]);
      add("large cancellation positive half cent", [
        `${whole}.123456789`,
        `-${whole}.123456789`,
        ...cancellation,
        "0.005",
      ]);
      add("large cancellation negative half cent", [
        ...cancellation,
        `-${whole}`,
        whole,
        "-0.005",
      ]);
      add(
        "round after many sub-cent terms",
        Array.from(
          { length: size },
          (_, i) => `${i % 2 ? "-" : ""}0.00${next(9) + 1}${i}`,
        ),
      );
      add("fifty-digit precision boundary", [
        `0.${"0".repeat(30)}${token.replace(/[a-f]/g, "1")}`,
        "0.0049999999999999999999999999999999999999999999999",
      ]);
      add("cancellation normalizes signed zero", [
        ...cancellation,
        `-${whole}.0000`,
        `${whole}.000`,
        "-0.0001",
      ]);
      add("late invalid decimal syntax", [...positive, `${whole}e${next(9)}`]);
      add("late digit limit rejection", [
        ...positive,
        `${whole}${"1".repeat(51 - whole.length)}`,
      ]);
      break;
    }
    case "json-pointer-patch": {
      const values = Array.from({ length: size }, (_, i) => ({
        id: `${token}:${i}`,
        n: next(100),
      }));
      const document = { "a/b": { "~1": values }, [token]: { "": 0 } };
      const edits = Array.from({ length: size }, (_, i) => ({
        op: "add",
        path: `/a~1b/~01/${i * 2}`,
        value: { inserted: i, token },
      }));
      add("deep escaped array insertion sequence", document, edits);
      add("late invalid operation remains atomic", document, [
        ...edits,
        { op: "remove", path: `/a~1b/~01/${size * 2}` },
      ]);
      add("canonical index rejection after edits", document, [
        ...edits,
        { op: "replace", path: "/a~1b/~01/01", value: token },
      ]);
      add("escaped forbidden segment", document, [
        ...edits,
        { op: "add", path: "/a~1b/constructor", value: token },
      ]);
      add("root replacement and empty key", document, [
        { op: "replace", path: "", value: { "": [token] } },
        { op: "add", path: "//-", value: { token } },
        { op: "remove", path: "//0" },
      ]);
      add("append replace remove sequence", document, [
        ...edits,
        { op: "add", path: "/a~1b/~01/-", value: token },
        { op: "replace", path: "/a~1b/~01/0", value: null },
        { op: "remove", path: "/a~1b/~01/1" },
      ]);
      add("late invalid escape", document, [
        ...edits,
        { op: "add", path: `/a~1b/~01/~${next(7) + 2}`, value: 0 },
      ]);
      add("huge array index rejected", document, [
        { op: "add", path: "/a~1b/~01/9007199254740993", value: token },
      ]);
      break;
    }
    case "weighted-lru": {
      const keys = [
        token,
        "__proto__",
        "toString",
        "constructor",
        "",
        ...Array.from({ length: 9 }, (_, i) => `${token}:${i}`),
      ];
      const operations: unknown[][] = [];
      for (let i = 0; i < Math.min(384, 48 + level * 12); i++) {
        const key = keys[next(keys.length)],
          kind = next(10);
        if (kind < 5)
          operations.push([
            "put",
            key,
            { i, token, payload: [false, null, next(1000)] },
            next(12) + 1,
          ]);
        else if (kind < 7) operations.push(["get", key]);
        else if (kind < 9) operations.push(["peek", key]);
        else operations.push(["resize", next(18)]);
      }
      for (let variant = 0; variant < 8; variant++) {
        const capacity = variant * 3;
        add(`weighted eviction resize promotion variant ${variant}`, {
          capacity,
          operations: [
            ["put", token, { token, variant }, 1],
            ["put", "other", variant, 2],
            ...operations,
            ["resize", capacity],
            ["put", token, "replacement", capacity + 1],
            ["get", token],
            ["peek", "other"],
          ],
        });
      }
      break;
    }
    case "timezone-interval-union": {
      const start = Date.UTC(2024, 1, 29, 0, 0, next(60));
      const stamp = (instant: number, offset: number) => {
        const local = new Date(instant + offset * 60000)
          .toISOString()
          .slice(0, 19);
        return offset === 0
          ? `${local}Z`
          : `${local}${offset < 0 ? "-" : "+"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
      };
      const offsets = [-840, -330, 0, 345, 840];
      const pairs = Array.from({ length: size }, (_, i): [string, string] => {
        const a = start + i * 1800000 + next(5) * 60000,
          b = a + next(8) * 900000;
        return [
          stamp(a, offsets[next(offsets.length)]),
          stamp(b, offsets[next(offsets.length)]),
        ];
      }).reverse();
      add("offsets overlap across leap-day boundaries", pairs);
      add("touching intervals in different offsets", [
        ...pairs,
        [stamp(start - 3600000, 840), stamp(start, -840)],
      ]);
      add("late invalid nonleap day", [
        ...pairs,
        ["2023-02-29T00:00:00Z", stamp(start, 0)],
      ]);
      add("late offset minute limit", [
        ...pairs,
        [`2024-02-29T00:00:00+14:01`, stamp(start, 0)],
      ]);
      add("late reversed instants", [
        ...pairs,
        [stamp(start + 1000, -840), stamp(start, 840)],
      ]);
      add("invalid zero duration still validated", [
        ...pairs,
        ["2024-04-31T00:00:00Z", "2024-04-31T00:00:00Z"],
      ]);
      add("zero duration valid offsets", [
        ...pairs,
        [stamp(start, -330), stamp(start, 345)],
      ]);
      add("exact spelling rejects terminal newline", [
        ...pairs,
        [`${stamp(start, 0)}\n`, stamp(start + 1000, 0)],
      ]);
      break;
    }
    case "dependency-layers": {
      const count = Math.min(128, size + 4);
      const ids = [
        "__proto__",
        "toString",
        "Z",
        "a",
        ...Array.from({ length: count - 4 }, (_, i) => `${token}:${i}`),
      ];
      const tasks = ids.map((id, i) => ({
        id,
        deps:
          i < 4
            ? []
            : [
                ids[i - 4],
                ...(i % 3 === 0 ? [ids[i - 4]] : []),
                ...(i > 8 && next(2) ? [ids[i - 8]] : []),
              ],
      }));
      add("deep wide DAG duplicate dependencies", [...tasks].reverse());
      add(
        "deep chain whole layers",
        ids
          .map((id, i) => ({ id, deps: i ? [ids[i - 1], ids[i - 1]] : [] }))
          .reverse(),
      );
      add("disconnected late cycle", [
        ...tasks,
        { id: `${token}:cycle-a`, deps: [`${token}:cycle-b`] },
        { id: `${token}:cycle-b`, deps: [`${token}:cycle-a`] },
      ]);
      add("late duplicate identifier", [
        ...tasks,
        { id: ids[next(ids.length)], deps: [] },
      ]);
      add("late missing dependency", [
        ...tasks,
        { id: `${token}:leaf`, deps: [`${token}:absent`] },
      ]);
      add("late self dependency", [
        ...tasks,
        { id: `${token}:self`, deps: [`${token}:self`] },
      ]);
      add(
        "all parallel lexical UTF16 IDs",
        [...ids, `Ω${token}`, `😀${token}`, `ä${token}`]
          .map((id) => ({ id, deps: [] }))
          .reverse(),
      );
      add(
        "deep cycle through existing DAG",
        tasks.map((task, i) =>
          i === 0 ? { id: task.id, deps: [ids[count - 4]] } : task,
        ),
      );
      break;
    }
  }
  return cases;
}

async function immutableJson(destination: string, contents: string) {
  await mkdir(path.dirname(destination), { recursive: true });
  // Exclusive creation works on Windows as well as Unix. A crash may leave an
  // incomplete artifact, but exact-content verification rejects it on recovery.
  // Existing curriculum files are never overwritten or repaired silently.
  try {
    await writeFile(destination, contents, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
    if ((await readFile(destination, "utf8")) !== contents)
      throw new Error(
        "Immutable curriculum artifact differs from its deterministic identity",
      );
  }
}

/** Every base case is permanent. Level one anchors remain forever; the latest eight
 * complete levels rotate to bound evaluation cost. New levels always add 48 fresh
 * cases, with complexity increasing to per-case safety limits and fresh seeds
 * continuing beyond those limits. Previously observed failures can be pinned
 * permanently by the caller. No inference or self-grading is involved. */
export async function generateCurriculumBenchmark(input: {
  baseBenchmarkPath: string;
  level: number;
  seed: string | number;
  dataDirectory?: string;
  pinnedCases?: { taskId: string; case: Case }[];
  pinnedLevels?: number[];
}): Promise<{
  path: string;
  benchmarkPath: string;
  level: number;
  caseCount: number;
  newCaseCount: number;
  baseCaseCount: number;
  benchmarkHash: string;
  benchmarkId: string;
  pinnedCaseCount: number;
  retainedLevels: number[];
}> {
  const options = z
    .object({
      baseBenchmarkPath: z.string().min(1),
      level: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      seed: z.union([z.string(), z.number().finite()]),
      dataDirectory: z.string().optional(),
      pinnedCases: z.array(pinSchema).default([]),
      pinnedLevels: z.array(z.number().int().positive()).default([]),
    })
    .strict()
    .parse(input);
  const requested = await loadBenchmark(options.baseBenchmarkPath);
  const raw = z
    .object({ curriculum: metadataSchema.optional() })
    .parse(JSON.parse(await readFile(requested.sourcePath, "utf8")));
  const previous = raw.curriculum;
  const base = previous
    ? await loadBenchmark(previous.baseBenchmarkPath)
    : requested;
  if (previous && base.hash !== previous.baseBenchmarkHash)
    throw new NeedsBenchmarkExtensionError(
      "The original benchmark changed; curriculum lineage cannot continue with different regression cases",
    );
  const canonical = await loadBenchmark("coding-adversarial-v1");
  if (
    base.tasks.length !== curriculumTaskIds.length ||
    base.tasks.some(
      (task) =>
        !curriculumTaskIdSchema.safeParse(task.id).success ||
        task.prompt !==
          canonical.tasks.find((item) => item.id === task.id)?.prompt ||
        !task.nonMutating,
    )
  ) {
    throw new NeedsBenchmarkExtensionError(
      "This benchmark needs an independent trusted case generator and oracle for its exact task contracts before curriculum extension",
    );
  }
  // Validate all inherited answers before trusting this source as a regression suite.
  for (const task of base.tasks) {
    const id = curriculumTaskIdSchema.parse(task.id);
    for (const item of task.cases)
      if (!isDeepStrictEqual(curriculumOracle(id, item.args), item.expected))
        throw new NeedsBenchmarkExtensionError(
          `Base benchmark answer disagrees with the independent oracle: ${task.id}/${item.label || "unnamed"}`,
        );
  }
  const pins = [
    ...new Map(
      [...(previous?.pinnedCases || []), ...options.pinnedCases].map((pin) => [
        JSON.stringify(pin),
        pin,
      ]),
    ).values(),
  ].sort((a, b) => {
    const left = JSON.stringify(a),
      right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  for (const pin of pins) {
    const id = curriculumTaskIdSchema.safeParse(pin.taskId);
    if (!id.success || !base.tasks.some((task) => task.id === id.data))
      throw new NeedsBenchmarkExtensionError(
        `No trusted oracle for pinned task: ${pin.taskId}`,
      );
    if (
      !isDeepStrictEqual(
        curriculumOracle(id.data, pin.case.args),
        pin.case.expected,
      )
    )
      throw new NeedsBenchmarkExtensionError(
        `Pinned answer disagrees with the independent oracle: ${pin.taskId}/${pin.case.label || "unnamed"}`,
      );
  }
  const seed = String(options.seed),
    level = options.level;
  const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
  const sources = await Promise.all(
    ["curriculum.ts", "curriculum-oracles.ts"].map((file) =>
      readFile(path.join(sourceDirectory, file), "utf8"),
    ),
  );
  const generatorSourceHash = hash(JSON.stringify({ version, sources }));
  const pinnedLevels = [
    ...new Set([...(previous?.pinnedLevels ?? []), ...options.pinnedLevels]),
  ].sort((a, b) => a - b);
  if (pinnedLevels.some((pinned) => pinned > level))
    throw new NeedsBenchmarkExtensionError(
      "A retained failure level cannot be in the future",
    );
  const identity = hash(
    JSON.stringify({
      baseHash: base.hash,
      generatorSourceHash,
      seed,
      level,
      pins,
      pinnedLevels,
    }),
  );
  const retainedLevels = [...new Set([1, ...pinnedLevels])];
  for (let n = Math.max(2, level - 7); n <= level; n++) retainedLevels.push(n);
  const uniqueLevels = [...new Set(retainedLevels)].sort((a, b) => a - b);
  retainedLevels.splice(0, retainedLevels.length, ...uniqueLevels);
  let newCaseCount = 0;
  const tasks = base.tasks.map((task) => {
    const id = curriculumTaskIdSchema.parse(task.id);
    const cases: Case[] = [...task.cases];
    for (const retained of retainedLevels)
      for (const generated of generatedArguments(id, retained, seed)) {
        cases.push({
          label: `curriculum level ${retained}: ${generated.category}`,
          args: generated.args,
          expected: curriculumOracle(id, generated.args),
        });
        if (retained === level) newCaseCount++;
      }
    const existing = new Set(cases.map((item) => JSON.stringify(item)));
    for (const pin of pins.filter((pin) => pin.taskId === id)) {
      const serialized = JSON.stringify(pin.case);
      if (!existing.has(serialized)) {
        cases.push(pin.case);
        existing.add(serialized);
      }
    }
    return { ...task, cases };
  });
  const baseCaseCount = base.tasks.reduce(
    (count, task) => count + task.cases.length,
    0,
  );
  const caseCount = tasks.reduce((count, task) => count + task.cases.length, 0);
  const benchmarkId = `${base.id}-curriculum-${level}-${identity.slice(0, 20)}`;
  const destination = path.join(
    path.resolve(options.dataDirectory || dataHome()),
    "curricula",
    identity,
    `level-${level}.json`,
  );
  const pinnedCaseCount = pins.length;
  const curriculum = metadataSchema.parse({
    generator: version,
    baseBenchmarkPath: base.sourcePath,
    baseBenchmarkHash: base.hash,
    generatorSourceHash,
    seed,
    level,
    retainedLevels,
    pinnedLevels,
    retention:
      "all base cases and failure pins, level-one anchors, latest eight levels",
    baseCaseCount,
    newCaseCount,
    caseCount,
    pinnedCaseCount,
    pinnedCases: pins,
  });
  await immutableJson(
    destination,
    JSON.stringify(
      {
        id: benchmarkId,
        name: `${base.name} · curriculum level ${level}`,
        domain: "coding",
        tasks,
        curriculum,
      },
      null,
      2,
    ),
  );
  const generated = await loadBenchmark(destination);
  return {
    path: destination,
    benchmarkPath: destination,
    level,
    caseCount,
    newCaseCount,
    baseCaseCount,
    benchmarkHash: generated.hash,
    benchmarkId: generated.id,
    pinnedCaseCount,
    retainedLevels,
  };
}
