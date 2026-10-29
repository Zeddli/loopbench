import { z } from "zod";

// Trusted answer generation only. These functions never execute as a model adapter.
const json = z.json();
type Json = z.infer<typeof json>;
const operation = z.object({
  op: z.string(),
  path: z.string(),
  value: json.optional(),
});
const cacheOperation = z.union([
  z.tuple([z.literal("put"), z.string(), json, z.number().int().positive()]),
  z.tuple([z.enum(["get", "peek"]), z.string()]),
  z.tuple([z.literal("resize"), z.number().int().nonnegative()]),
]);
const cache = z.object({
  capacity: z.number().int().nonnegative(),
  operations: z.array(cacheOperation),
});
const dependencies = z.array(
  z.object({ id: z.string(), deps: z.array(z.string()) }),
);

export const curriculumTaskIdSchema = z.enum([
  "strict-csv",
  "json-pointer-patch",
  "exact-money-sum",
  "weighted-lru",
  "timezone-interval-union",
  "dependency-layers",
]);
export const curriculumTaskIds = curriculumTaskIdSchema.options;
export type CurriculumTaskId = z.infer<typeof curriculumTaskIdSchema>;

function csv(text: string): string[][] | null {
  if (text === "") return [];
  const records: string[][] = [];
  let record: string[] = [],
    cursor = 0;
  while (true) {
    const remaining = text.slice(cursor);
    const match = remaining.startsWith('"')
      ? /^"((?:[^"]|"")*)"/.exec(remaining)
      : /^[^",\r\n]*/.exec(remaining);
    if (!match) return null;
    record.push(
      remaining.startsWith('"') ? match[1].replace(/""/g, '"') : match[0],
    );
    cursor += match[0].length;
    if (cursor === text.length) {
      records.push(record);
      return records;
    }
    if (text[cursor] === ",") {
      cursor++;
      continue;
    }
    if (text[cursor] === "\n" || text.slice(cursor, cursor + 2) === "\r\n") {
      cursor += text[cursor] === "\r" ? 2 : 1;
      records.push(record);
      record = [];
      if (cursor === text.length) return records;
    } else return null;
  }
}

function money(values: unknown[]): string | null {
  // Every legal input has at most 50 digits, hence at most 49 fraction digits.
  // A fixed decimal lattice avoids the reference program's dynamic-scale algorithm.
  const lattice = 10n ** 50n;
  let total = 0n;
  for (const value of values) {
    if (
      typeof value !== "string" ||
      !/^-?[0-9]+(?:\.[0-9]+)?$/.test(value) ||
      /\s/.test(value)
    )
      return null;
    const digits = value.replace(/[-.]/g, "");
    if (digits.length > 50) return null;
    const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
    const integer =
      BigInt(whole) * lattice +
      BigInt(fraction || "0") * 10n ** BigInt(50 - fraction.length);
    total += value.startsWith("-") ? -integer : integer;
  }
  const absolute = total < 0n ? -total : total;
  const cent = lattice / 100n;
  const rounded = (absolute + cent / 2n) / cent;
  return `${total < 0n && rounded !== 0n ? "-" : ""}${rounded / 100n}.${String(rounded % 100n).padStart(2, "0")}`;
}

function patch(document: Json, operations: z.infer<typeof operation>[]): Json {
  let result = structuredClone(document);
  for (const item of operations) {
    if (
      !["add", "replace", "remove"].includes(item.op) ||
      (item.op !== "remove" && item.value === undefined)
    )
      return null;
    if (item.path === "") {
      if (item.op === "remove" || item.value === undefined) return null;
      result = structuredClone(item.value);
      continue;
    }
    if (!item.path.startsWith("/")) return null;
    const parts = item.path.substring(1).split("/");
    if (parts.some((part) => /~([^01]|$)/.test(part))) return null;
    const keys = parts.map((part) =>
      part.replace(/~1/g, "/").replace(/~0/g, "~"),
    );
    if (
      keys.some((key) =>
        ["__proto__", "constructor", "prototype"].includes(key),
      )
    )
      return null;
    let current: Json = result;
    for (const [position, key] of keys.entries()) {
      if (current === null || typeof current !== "object") return null;
      const last = position === keys.length - 1;
      if (Array.isArray(current)) {
        const index =
          key === "-" && last && item.op === "add"
            ? current.length
            : /^(0|[1-9][0-9]*)$/.test(key)
              ? Number(key)
              : -1;
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index > current.length ||
          (index === current.length && !(last && item.op === "add"))
        )
          return null;
        if (!last) current = current[index];
        else if (item.op === "remove") current.splice(index, 1);
        else if (item.value !== undefined) {
          if (item.op === "add")
            current.splice(index, 0, structuredClone(item.value));
          else current[index] = structuredClone(item.value);
        }
      } else {
        if ((!last || item.op !== "add") && !Object.hasOwn(current, key))
          return null;
        if (!last) current = current[key];
        else if (item.op === "remove") delete current[key];
        else if (item.value !== undefined)
          current[key] = structuredClone(item.value);
      }
    }
  }
  return result;
}

function lru(spec: z.infer<typeof cache>) {
  const values = new Map<string, { value: Json; weight: number }>();
  const reads: Json[] = [];
  let capacity = spec.capacity,
    weight = 0;
  function remove(key: string) {
    const old = values.get(key);
    if (old) {
      weight -= old.weight;
      values.delete(key);
    }
  }
  function trim() {
    while (weight > capacity) {
      const oldest = values.keys().next();
      if (oldest.done) break;
      remove(oldest.value);
    }
  }
  for (const op of spec.operations) {
    if (op[0] === "resize") {
      capacity = op[1];
      trim();
    } else if (op[0] === "put") {
      remove(op[1]);
      if (op[3] <= capacity) {
        values.set(op[1], { value: structuredClone(op[2]), weight: op[3] });
        weight += op[3];
        trim();
      }
    } else {
      const entry = values.get(op[1]);
      reads.push(entry ? structuredClone(entry.value) : null);
      if (entry && op[0] === "get") {
        values.delete(op[1]);
        values.set(op[1], entry);
      }
    }
  }
  return {
    reads,
    entries: [...values]
      .reverse()
      .map(([key, entry]) => [key, entry.value, entry.weight]),
  };
}

function timestamp(text: string): number | null {
  const m =
    /^(20\d{2})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      text,
    );
  if (!m || m[0] !== text) return null;
  const year = Number(m[1]),
    month = Number(m[2]),
    day = Number(m[3]),
    hour = Number(m[4]),
    minute = Number(m[5]),
    second = Number(m[6]);
  const offsetHour = Number(m[9] || 0),
    offsetMinute = Number(m[10] || 0);
  const days = [
    31,
    year % 4 === 0 ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  )
    return null;
  return (
    Date.UTC(year, month - 1, day, hour, minute, second) +
    (m[8] === "-" ? 1 : -1) * (offsetHour * 60 + offsetMinute) * 60000
  );
}

function intervals(input: [string, string][]): string[][] | null {
  // Sweep events instead of the reference program's interval-by-interval merge.
  const events = new Map<number, number>();
  for (const [start, end] of input) {
    const a = timestamp(start),
      b = timestamp(end);
    if (a === null || b === null || a > b) return null;
    if (a === b) continue;
    events.set(a, (events.get(a) || 0) + 1);
    events.set(b, (events.get(b) || 0) - 1);
  }
  let depth = 0,
    start = 0;
  const result: string[][] = [];
  for (const [time, delta] of [...events].sort((a, b) => a[0] - b[0])) {
    if (depth === 0) start = time;
    depth += delta;
    if (depth === 0)
      result.push([
        new Date(start).toISOString(),
        new Date(time).toISOString(),
      ]);
  }
  return result;
}

function layers(tasks: z.infer<typeof dependencies>): string[][] | null {
  const graph = new Map(tasks.map((task) => [task.id, new Set(task.deps)]));
  if (graph.size !== tasks.length) return null;
  const outgoing = new Map<string, string[]>();
  for (const [id, deps] of graph)
    for (const dep of deps) {
      if (!graph.has(dep)) return null;
      outgoing.set(dep, [...(outgoing.get(dep) || []), id]);
    }
  let ready = [...graph]
    .filter(([, deps]) => deps.size === 0)
    .map(([id]) => id);
  const result: string[][] = [];
  let completed = 0;
  while (ready.length) {
    result.push(ready.sort());
    completed += ready.length;
    const next: string[] = [];
    for (const id of ready)
      for (const child of outgoing.get(id) || []) {
        const deps = graph.get(child);
        if (deps) {
          deps.delete(id);
          if (deps.size === 0) next.push(child);
        }
      }
    ready = next;
  }
  return completed === tasks.length ? result : null;
}

export function curriculumOracle(
  taskId: CurriculumTaskId,
  args: unknown[],
): unknown {
  switch (taskId) {
    case "strict-csv":
      return csv(z.tuple([z.string()]).parse(args)[0]);
    case "exact-money-sum":
      return money(z.tuple([z.array(z.unknown())]).parse(args)[0]);
    case "json-pointer-patch": {
      const [document, operations] = z
        .tuple([json, z.array(operation)])
        .parse(args);
      return patch(document, operations);
    }
    case "weighted-lru":
      return lru(z.tuple([cache]).parse(args)[0]);
    case "timezone-interval-union":
      return intervals(
        z.tuple([z.array(z.tuple([z.string(), z.string()]))]).parse(args)[0],
      );
    case "dependency-layers":
      return layers(z.tuple([dependencies]).parse(args)[0]);
  }
}
