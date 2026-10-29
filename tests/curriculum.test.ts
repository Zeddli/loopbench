import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { loadBenchmark, evaluateCode } from "../core/benchmarks";
import {
  curriculumOracle,
  curriculumTaskIdSchema,
} from "../core/curriculum-oracles";
import {
  generateCurriculumBenchmark,
  NeedsBenchmarkExtensionError,
} from "../core/curriculum";
import { projectRoot } from "../core/store";

// Independent reference algorithms also used by the evaluator contract tests.
// They are test programs only and never supply adapter responses or experiment evidence.
const referencePrograms: Record<string, string> = {
  "strict-csv": String.raw`module.exports = function(text) {
    if (!text.length) return [];
    const records=[]; let record=[], field='', state='start', ended=false;
    for(let i=0;i<text.length;i++) {
      const c=text[i]; ended=false;
      if(state==='quoted') { if(c==='"') { if(text[i+1]==='"') {field+='"';i++;} else state='closed'; } else field+=c; continue; }
      if(c===',') {record.push(field);field='';state='start';continue;}
      if(c==='\n'||c==='\r') {if(c==='\r'&&text[++i]!=='\n')return null;record.push(field);records.push(record);record=[];field='';state='start';ended=true;continue;}
      if(state==='closed') return null;
      if(c==='"') {if(state!=='start')return null;state='quoted';continue;}
      field+=c;state='plain';
    }
    if(state==='quoted')return null;
    if(!ended){record.push(field);records.push(record);}
    return records;
  };`,
  "json-pointer-patch": String.raw`module.exports = function(document,operations) {
    let value=JSON.parse(JSON.stringify(document)); const own=(o,k)=>Object.hasOwn(o,k);
    for(const operation of operations) {
      const {op,path}=operation;
      if(!['add','replace','remove'].includes(op)||typeof path!=='string'||(op!=='remove'&&!own(operation,'value')))return null;
      if(path===''){if(op==='remove')return null;value=JSON.parse(JSON.stringify(operation.value));continue;}
      if(!path.startsWith('/'))return null;
      const raw=path.slice(1).split('/'); if(raw.some(p=>/~(?:[^01]|$)/.test(p)))return null;
      const parts=raw.map(p=>p.replace(/~1/g,'/').replace(/~0/g,'~'));
      if(parts.some(p=>['__proto__','prototype','constructor'].includes(p)))return null;
      let parent=value;
      for(const key of parts.slice(0,-1)) {
        if(parent===null||typeof parent!=='object'||!own(parent,key))return null;
        if(Array.isArray(parent)&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=parent.length))return null;
        parent=parent[key];
      }
      if(parent===null||typeof parent!=='object')return null;
      const key=parts.at(-1);
      if(Array.isArray(parent)) {
        let index;
        if(key==='-'&&op==='add')index=parent.length;
        else {if(!/^(0|[1-9][0-9]*)$/.test(key))return null;index=Number(key);}
        if(index>parent.length||(op!=='add'&&index===parent.length))return null;
        if(op==='add')parent.splice(index,0,JSON.parse(JSON.stringify(operation.value)));
        else if(op==='replace')parent[index]=JSON.parse(JSON.stringify(operation.value));
        else parent.splice(index,1);
      } else {
        if(op!=='add'&&!own(parent,key))return null;
        if(op==='remove')delete parent[key]; else parent[key]=JSON.parse(JSON.stringify(operation.value));
      }
    }
    return value;
  };`,
  "exact-money-sum": String.raw`module.exports = function(values) {
    const pieces=[];let scale=0;
    for(const value of values) {
      if(typeof value!=='string')return null;
      const match=/^-?[0-9]+(?:\.[0-9]+)?$/.exec(value);
      if(!match||match[0]!==value||value.replace(/[-.]/g,'').length>50)return null;
      const sign=value.startsWith('-')?-1n:1n, [whole,fraction='']=value.replace(/^-/,'').split('.');
      pieces.push({sign,whole,fraction});scale=Math.max(scale,fraction.length);
    }
    let total=pieces.reduce((sum,p)=>sum+p.sign*BigInt(p.whole+p.fraction.padEnd(scale,'0')),0n);
    const negative=total<0n;if(negative)total=-total;
    if(scale<=2)total*=10n**BigInt(2-scale);
    else {const divisor=10n**BigInt(scale-2);total=total/divisor+(total%divisor*2n>=divisor?1n:0n);}
    const result=String(total).padStart(3,'0');return (negative&&total!==0n?'-':'')+result.slice(0,-2)+'.'+result.slice(-2);
  };`,
  "weighted-lru": String.raw`module.exports = function(spec) {
    const entries=[]; const reads=[];let capacity=spec.capacity;
    const trim=()=>{while(entries.reduce((n,e)=>n+e[2],0)>capacity)entries.pop();};
    for(const [op,key,value,weight] of spec.operations) {
      if(op==='resize'){capacity=key;trim();continue;}
      const index=entries.findIndex(e=>e[0]===key);
      if(op==='put'){if(index>=0)entries.splice(index,1);if(weight<=capacity){entries.unshift([key,value,weight]);trim();}}
      else {reads.push(index<0?null:entries[index][1]);if(op==='get'&&index>=0)entries.unshift(entries.splice(index,1)[0]);}
    }
    return {reads,entries};
  };`,
  "timezone-interval-union": String.raw`module.exports = function(intervals) {
    function parse(text) {
      const m=/^(20[0-9]{2})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(Z|([+-])([0-9]{2}):([0-9]{2}))$/.exec(text);
      if(!m||m[0]!==text)return null;
      const [y,month,day,hour,minute,second]=m.slice(1,7).map(Number);
      const oh=Number(m[9]||0),om=Number(m[10]||0);
      if(month<1||month>12||day<1||hour>23||minute>59||second>59||oh>14||om>59||(oh===14&&om!==0))return null;
      const local=Date.UTC(y,month-1,day,hour,minute,second), check=new Date(local);
      if(check.getUTCFullYear()!==y||check.getUTCMonth()!==month-1||check.getUTCDate()!==day)return null;
      return local-(m[8]==='-'?-1:1)*(oh*60+om)*60000;
    }
    const sorted=[];
    for(const [start,end] of intervals){const a=parse(start),b=parse(end);if(a===null||b===null||a>b)return null;if(a!==b)sorted.push([a,b]);}
    sorted.sort((a,b)=>a[0]-b[0]);const result=[];
    for(const interval of sorted){const previous=result.at(-1);if(previous&&interval[0]<=previous[1])previous[1]=Math.max(previous[1],interval[1]);else result.push(interval);}
    return result.map(pair=>pair.map(n=>new Date(n).toISOString()));
  };`,
  "dependency-layers": String.raw`module.exports = function(tasks) {
    const ids=new Set(tasks.map(t=>t.id));if(ids.size!==tasks.length)return null;
    if(tasks.some(t=>t.deps.some(d=>!ids.has(d))))return null;
    const done=new Set(),result=[];
    while(done.size<tasks.length){const layer=tasks.filter(t=>!done.has(t.id)&&t.deps.every(d=>done.has(d))).map(t=>t.id).sort();if(!layer.length)return null;result.push(layer);for(const id of layer)done.add(id);}
    return result;
  };`,
};

test("trusted oracles agree with independently hand-authored edge answers and preserve arguments", () => {
  const checks: { id: string; args: unknown[]; expected: unknown }[] = [
    {
      id: "strict-csv",
      args: ['"a\r\nb","say ""yes""",\r\n\n'],
      expected: [["a\r\nb", 'say "yes"', ""], [""]],
    },
    { id: "strict-csv", args: ['"ok" x'], expected: null },
    {
      id: "strict-csv",
      args: ['"literal\rCR",x'],
      expected: [["literal\rCR", "x"]],
    },
    { id: "strict-csv", args: ['"ok"\r'], expected: null },
    {
      id: "exact-money-sum",
      args: [
        [
          "999999999999999999999999999999.999",
          "-999999999999999999999999999999.994",
        ],
      ],
      expected: "0.01",
    },
    {
      id: "exact-money-sum",
      args: [
        [
          "-999999999999999999999999999999.999",
          "999999999999999999999999999999.994",
        ],
      ],
      expected: "-0.01",
    },
    {
      id: "exact-money-sum",
      args: [["-0.0049999999999999999999999999999999999999999999999"]],
      expected: "0.00",
    },
    {
      id: "exact-money-sum",
      args: [["0.0025", "0.0025", "0.0049"]],
      expected: "0.01",
    },
    { id: "exact-money-sum", args: [["1\n"]], expected: null },
    { id: "exact-money-sum", args: [["0".repeat(50)]], expected: "0.00" },
    { id: "exact-money-sum", args: [["0".repeat(51)]], expected: null },
    {
      id: "json-pointer-patch",
      args: [
        { "~1": [1, 2] },
        [
          { op: "add", path: "/~01/1", value: 3 },
          { op: "remove", path: "/~01/0" },
        ],
      ],
      expected: { "~1": [3, 2] },
    },
    {
      id: "json-pointer-patch",
      args: [
        { a: [1] },
        [
          { op: "add", path: "/a/-", value: 2 },
          { op: "replace", path: "/a/02", value: 4 },
        ],
      ],
      expected: null,
    },
    {
      id: "json-pointer-patch",
      args: [{}, [{ op: "add", path: "/constructor", value: 1 }]],
      expected: null,
    },
    {
      id: "json-pointer-patch",
      args: [{ a: 1 }, [{ op: "replace", path: "/a", value: null }]],
      expected: { a: null },
    },
    {
      id: "weighted-lru",
      args: [
        {
          capacity: 4,
          operations: [
            ["put", "a", { n: 1 }, 2],
            ["put", "b", false, 2],
            ["peek", "a"],
            ["put", "c", 3, 1],
            ["get", "a"],
            ["put", "b", 9, 5],
            ["resize", 1],
          ],
        },
      ],
      expected: { reads: [{ n: 1 }, null], entries: [["c", 3, 1]] },
    },
    {
      id: "timezone-interval-union",
      args: [
        [
          ["2024-03-01T00:00:00+01:00", "2024-03-01T01:00:00+01:00"],
          ["2024-02-29T23:30:00Z", "2024-03-01T01:00:00Z"],
        ],
      ],
      expected: [["2024-02-29T23:00:00.000Z", "2024-03-01T01:00:00.000Z"]],
    },
    {
      id: "timezone-interval-union",
      args: [
        [
          ["2000-02-29T00:00:00Z", "2000-02-29T00:00:00Z"],
          ["2024-02-29T00:00:00Z", "2024-02-29T01:00:00Z"],
          ["2024-02-29T01:00:00Z", "2024-02-29T02:00:00Z"],
        ],
      ],
      expected: [["2024-02-29T00:00:00.000Z", "2024-02-29T02:00:00.000Z"]],
    },
    {
      id: "timezone-interval-union",
      args: [[["2023-02-29T00:00:00Z", "2023-02-29T00:00:00Z"]]],
      expected: null,
    },
    {
      id: "timezone-interval-union",
      args: [[["2024-01-01T00:00:00+14:01", "2024-01-02T00:00:00Z"]]],
      expected: null,
    },
    {
      id: "dependency-layers",
      args: [
        [
          { id: "c", deps: ["a", "b", "a"] },
          { id: "b", deps: [] },
          { id: "a", deps: [] },
          { id: "d", deps: ["c"] },
        ],
      ],
      expected: [["a", "b"], ["c"], ["d"]],
    },
    {
      id: "dependency-layers",
      args: [
        [
          { id: "free", deps: [] },
          { id: "a", deps: ["b"] },
          { id: "b", deps: ["a"] },
        ],
      ],
      expected: null,
    },
    {
      id: "dependency-layers",
      args: [
        [
          { id: "a", deps: [] },
          { id: "a", deps: [] },
        ],
      ],
      expected: null,
    },
  ];
  for (const check of checks) {
    const original = structuredClone(check.args);
    assert.deepEqual(
      curriculumOracle(curriculumTaskIdSchema.parse(check.id), check.args),
      check.expected,
      check.id,
    );
    assert.deepEqual(check.args, original, `${check.id} mutated its input`);
  }
});

test("failed level identifiers regenerate trusted regressions after the rotating window expires", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "loopbench-level-regressions-"),
  );
  try {
    const common = {
      baseBenchmarkPath: "coding-adversarial-v1",
      level: 11,
      seed: "retained-level-proof",
      dataDirectory: directory,
    };
    const ordinary = await generateCurriculumBenchmark(common);
    const retained = await generateCurriculumBenchmark({
      ...common,
      pinnedLevels: [2],
    });
    assert.ok(!ordinary.retainedLevels.includes(2));
    assert.ok(retained.retainedLevels.includes(2));
    assert.notEqual(ordinary.benchmarkHash, retained.benchmarkHash);
    const benchmark = await loadBenchmark(retained.path);
    assert.ok(
      benchmark.tasks.every((task) =>
        task.cases.some((item) =>
          item.label?.startsWith("curriculum level 2:"),
        ),
      ),
    );
    const next = await generateCurriculumBenchmark({
      ...common,
      baseBenchmarkPath: retained.path,
      level: 12,
    });
    assert.ok(next.retainedLevels.includes(2));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("independent oracles validate all 64 permanent regression answers", async () => {
  const base = await loadBenchmark("coding-adversarial-v1");
  let count = 0;
  for (const task of base.tasks)
    for (const item of task.cases) {
      assert.deepEqual(
        curriculumOracle(curriculumTaskIdSchema.parse(task.id), item.args),
        item.expected,
        `${task.id}: ${item.label}`,
      );
      count++;
    }
  assert.equal(count, 64);
});

test("curricula are deterministic immutable artifacts with retained regressions and distinct fresh levels", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "loopbench-curriculum-"));
  try {
    const base = await loadBenchmark("coding-adversarial-v1");
    const originalBytes = await readFile(base.sourcePath, "utf8");
    const options = {
      baseBenchmarkPath: base.sourcePath,
      seed: "stable-seed",
      dataDirectory: directory,
    };
    const first = await generateCurriculumBenchmark({ ...options, level: 1 });
    const repeat = await generateCurriculumBenchmark({ ...options, level: 1 });
    const second = await generateCurriculumBenchmark({ ...options, level: 2 });
    const otherSeed = await generateCurriculumBenchmark({
      ...options,
      seed: "other-seed",
      level: 1,
    });
    const fromPrior = await generateCurriculumBenchmark({
      ...options,
      baseBenchmarkPath: first.path,
      level: 2,
    });
    assert.deepEqual(first, repeat);
    assert.deepEqual(second, fromPrior);
    assert.notEqual(first.benchmarkHash, second.benchmarkHash);
    assert.notEqual(first.benchmarkHash, otherSeed.benchmarkHash);
    assert.equal(first.baseCaseCount, 64);
    assert.equal(first.newCaseCount, 48);
    assert.equal(first.caseCount, 112);
    assert.equal(second.caseCount, 160);
    const firstBenchmark = await loadBenchmark(first.path),
      secondBenchmark = await loadBenchmark(second.path);
    assert.equal(firstBenchmark.hash, first.benchmarkHash);
    for (const task of base.tasks) {
      const one = firstBenchmark.tasks.find((item) => item.id === task.id);
      const two = secondBenchmark.tasks.find((item) => item.id === task.id);
      assert.ok(one && two);
      assert.equal(one.prompt, task.prompt);
      assert.deepEqual(one.cases.slice(0, task.cases.length), task.cases);
      assert.deepEqual(two.cases.slice(0, one.cases.length), one.cases);
      const earlierArgs = new Set(
        one.cases.map((item) => JSON.stringify(item.args)),
      );
      assert.ok(
        two.cases
          .filter((item) => item.label?.startsWith("curriculum level 2:"))
          .every((item) => !earlierArgs.has(JSON.stringify(item.args))),
        task.id,
      );
    }
    assert.equal(await readFile(base.sourcePath, "utf8"), originalBytes);
    // An existing artifact is never silently overwritten, even if corrupted externally.
    await writeFile(first.path, "corrupt");
    await assert.rejects(
      generateCurriculumBenchmark({ ...options, level: 1 }),
      /Immutable curriculum/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("arbitrary unsupported or altered contracts explicitly need a trusted benchmark extension", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "loopbench-curriculum-contract-"),
  );
  try {
    const custom = path.join(directory, "custom.json");
    await writeFile(
      custom,
      JSON.stringify({
        id: "custom",
        name: "Custom",
        domain: "coding",
        tasks: [
          {
            id: "unknown",
            prompt: "Do something",
            cases: [{ args: [1], expected: 1 }],
          },
        ],
      }),
    );
    await assert.rejects(
      generateCurriculumBenchmark({
        baseBenchmarkPath: custom,
        level: 1,
        seed: 7,
        dataDirectory: directory,
      }),
      (error) =>
        error instanceof NeedsBenchmarkExtensionError &&
        error.code === "needs_benchmark_extension",
    );
    const base = await loadBenchmark("coding-adversarial-v1");
    const changed = {
      ...base,
      id: "changed-contract",
      tasks: base.tasks.map((task, index) =>
        index === 0 ? { ...task, prompt: "Return 42" } : task,
      ),
    };
    await writeFile(custom, JSON.stringify(changed));
    await assert.rejects(
      generateCurriculumBenchmark({
        baseBenchmarkPath: custom,
        level: 1,
        seed: 7,
        dataDirectory: directory,
      }),
      NeedsBenchmarkExtensionError,
    );
    changed.tasks = base.tasks.map((task, index) =>
      index === 0
        ? { ...task, cases: [{ args: ["hello"], expected: 42 }] }
        : task,
    );
    await writeFile(custom, JSON.stringify(changed));
    await assert.rejects(
      generateCurriculumBenchmark({
        baseBenchmarkPath: custom,
        level: 1,
        seed: 7,
        dataDirectory: directory,
      }),
      /answer disagrees/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded retention preserves base and level-one anchors and keeps creating fresh challenges beyond level two", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "loopbench-curriculum-retention-"),
  );
  try {
    const options = {
      baseBenchmarkPath: "coding-adversarial-v1",
      seed: "long-campaign",
      dataDirectory: directory,
    };
    const one = await generateCurriculumBenchmark({ ...options, level: 1 });
    const nine = await generateCurriculumBenchmark({ ...options, level: 9 });
    const ten = await generateCurriculumBenchmark({ ...options, level: 10 });
    const distant = await generateCurriculumBenchmark({
      ...options,
      level: 10000,
    });
    assert.equal(nine.caseCount, 496);
    assert.equal(ten.caseCount, 496);
    assert.equal(distant.caseCount, 496);
    assert.equal(ten.newCaseCount, 48);
    assert.notEqual(nine.benchmarkHash, ten.benchmarkHash);
    const anchors = await loadBenchmark(one.path);
    for (const result of [ten, distant]) {
      const benchmark = await loadBenchmark(result.path);
      for (const task of anchors.tasks) {
        const advanced = benchmark.tasks.find((item) => item.id === task.id);
        assert.ok(advanced);
        assert.deepEqual(
          advanced.cases.slice(0, task.cases.length),
          task.cases,
        );
        assert.equal(
          advanced.cases.filter((item) =>
            item.label?.startsWith(`curriculum level ${result.level}:`),
          ).length,
          8,
        );
      }
    }
    const metadata = z
      .object({
        curriculum: z.object({
          retainedLevels: z.array(z.number()),
          retention: z.string(),
        }),
      })
      .parse(JSON.parse(await readFile(ten.path, "utf8")));
    assert.deepEqual(
      metadata.curriculum.retainedLevels,
      [1, 3, 4, 5, 6, 7, 8, 9, 10],
    );
    assert.match(metadata.curriculum.retention, /all base cases/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("independent reference programs solve generated suites through the real 15-second evaluator", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "loopbench-curriculum-evaluate-"),
  );
  try {
    const options = {
      baseBenchmarkPath: "coding-adversarial-v1",
      seed: "independent-programs",
      dataDirectory: directory,
    };
    // Exercise early growth and the bounded maximum across different seed/level inputs.
    for (const level of [2, 100]) {
      const generated = await generateCurriculumBenchmark({
        ...options,
        level,
      });
      const benchmark = await loadBenchmark(generated.path);
      for (const task of benchmark.tasks) {
        const program = referencePrograms[task.id];
        assert.ok(program);
        const result = await evaluateCode(program, task, projectRoot);
        assert.equal(
          result.passed,
          true,
          `level ${level} ${task.id}: ${result.error}`,
        );
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real failing cases remain pinned when their generated level leaves the active window", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "loopbench-curriculum-pins-"),
  );
  try {
    const options = {
      baseBenchmarkPath: "coding-adversarial-v1",
      seed: "regression-pins",
      dataDirectory: directory,
    };
    const second = await generateCurriculumBenchmark({ ...options, level: 2 });
    const benchmark = await loadBenchmark(second.path);
    const task = benchmark.tasks.find((item) => item.id === "exact-money-sum");
    assert.ok(task);
    const failingCase = task.cases.find(
      (item) =>
        item.label?.startsWith("curriculum level 2:") && item.expected !== null,
    );
    assert.ok(failingCase);
    const failure = await evaluateCode(
      "module.exports = () => '0.00';",
      { ...task, cases: [failingCase] },
      projectRoot,
    );
    assert.equal(failure.passed, false);
    assert.ok(failure.error?.includes(failingCase.label || "missing label"));
    const pin = { taskId: task.id, case: failingCase };
    const advanced = await generateCurriculumBenchmark({
      ...options,
      level: 20,
      pinnedCases: [pin, pin],
    });
    const unpinned = await generateCurriculumBenchmark({
      ...options,
      level: 20,
    });
    assert.equal(advanced.pinnedCaseCount, 1);
    assert.equal(advanced.caseCount, unpinned.caseCount + 1);
    assert.notEqual(advanced.benchmarkHash, unpinned.benchmarkHash);
    const retained = await loadBenchmark(advanced.path);
    assert.ok(
      retained.tasks
        .find((item) => item.id === task.id)
        ?.cases.some(
          (item) => JSON.stringify(item) === JSON.stringify(failingCase),
        ),
    );
    const resumed = await generateCurriculumBenchmark({
      ...options,
      baseBenchmarkPath: advanced.path,
      level: 21,
    });
    assert.equal(resumed.pinnedCaseCount, 1);
    assert.ok(
      (await loadBenchmark(resumed.path)).tasks
        .find((item) => item.id === task.id)
        ?.cases.some(
          (item) => JSON.stringify(item) === JSON.stringify(failingCase),
        ),
    );
    await assert.rejects(
      generateCurriculumBenchmark({
        ...options,
        level: 20,
        pinnedCases: [
          { taskId: task.id, case: { ...failingCase, expected: "WRONG" } },
        ],
      }),
      /Pinned answer disagrees/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
