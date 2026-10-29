import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  evaluateCode,
  loadBenchmark,
  listBenchmarks,
} from "../core/benchmarks";
import { projectRoot } from "../core/store";

test("built-in array tasks reject correct outputs that mutate the input", async () => {
  const benchmark = await loadBenchmark("coding-functions-v1");
  const chunk = benchmark.tasks.find((task) => task.id === "chunk-array");
  const unique = benchmark.tasks.find((task) => task.id === "unique-stable");
  assert.ok(chunk && unique);
  const destructiveChunk = await evaluateCode(
    "module.exports = (values,size) => { const chunks=[]; if(size<=0)return []; while(values.length)chunks.push(values.splice(0,size)); return chunks; }",
    chunk,
    projectRoot,
  );
  assert.equal(destructiveChunk.passed, false);
  assert.match(destructiveChunk.error || "", /mutated input/);
  const destructiveUnique = await evaluateCode(
    "module.exports = values => { const result=[...new Set(values)]; values.length=0; return result; }",
    unique,
    projectRoot,
  );
  assert.equal(destructiveUnique.passed, false);
  assert.match(destructiveUnique.error || "", /mutated input/);
  assert.equal(
    (
      await evaluateCode(
        "module.exports = values => [...new Set(values)];",
        unique,
        projectRoot,
      )
    ).passed,
    true,
  );
});

test("custom tasks allow mutation by default and can prohibit nested mutation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "loopbench-evaluator-"));
  try {
    const filename = path.join(directory, "benchmark.json");
    await writeFile(
      filename,
      JSON.stringify({
        id: "mutation-contract",
        name: "Mutation contract",
        domain: "coding",
        tasks: [
          {
            id: "nested",
            prompt: "Return the first item value.",
            cases: [{ args: [[{ value: 1 }]], expected: 1 }],
          },
        ],
      }),
    );
    const benchmark = await loadBenchmark(filename);
    assert.equal(benchmark.sourcePath, filename);
    const task = benchmark.tasks[0];
    assert.ok(task);
    const mutator =
      "module.exports = values => { const value=values[0].value; values[0].value=2; return value; };";
    assert.equal((await evaluateCode(mutator, task, directory)).passed, true);
    const checked = await evaluateCode(
      mutator,
      { ...task, nonMutating: true },
      directory,
    );
    assert.equal(checked.passed, false);
    assert.match(checked.error || "", /mutated input/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("benchmark identity includes the exact evaluator and controller source digests", async () => {
  const { hash, sourcePath, ...definition } = await loadBenchmark(
    "coding-functions-v1",
  );
  assert.equal(
    sourcePath,
    path.join(projectRoot, "benchmarks", "coding-functions-v1.json"),
  );
  const evaluatorHash = createHash("sha256")
    .update(
      await readFile(path.join(projectRoot, "benchmarks", "evaluate.mjs")),
    )
    .digest("hex");
  const expected = createHash("sha256")
    .update(
      JSON.stringify({
        definition,
        evaluatorHash,
        controllerHash: createHash("sha256")
          .update(
            await readFile(path.join(projectRoot, "core", "benchmarks.ts")),
          )
          .digest("hex"),
      }),
    )
    .digest("hex");
  assert.equal(hash, expected);
});

test("evaluator launch failures throw instead of becoming incorrect answers", async () => {
  const benchmark = await loadBenchmark("coding-functions-v1");
  const task = benchmark.tasks[0];
  assert.ok(task);
  await assert.rejects(
    evaluateCode(
      "module.exports = () => [];",
      task,
      path.join(tmpdir(), `missing-loopbench-${process.pid}-${Date.now()}`),
    ),
    /ENOENT/,
  );
  const looping = await evaluateCode(
    "module.exports = () => { while(true){} };",
    task,
    projectRoot,
  );
  assert.equal(looping.passed, false);
  assert.match(looping.error || "", /timed out/);
});

test("named hidden cases provide a failure category without the expected value", async () => {
  const benchmark = await loadBenchmark("coding-functions-v1");
  const task = benchmark.tasks[0];
  assert.ok(task);
  const result = await evaluateCode(
    "module.exports = () => null;",
    {
      ...task,
      cases: [
        {
          label: "empty collection",
          args: [[]],
          expected: ["PRIVATE_EXPECTED_VALUE"],
        },
      ],
    },
    projectRoot,
  );
  assert.equal(result.passed, false);
  assert.match(result.error || "", /empty collection/);
  assert.doesNotMatch(result.error || "", /PRIVATE_EXPECTED_VALUE/);
});

test("built-in registry includes the adversarial suite with six named pure tasks", async () => {
  assert.deepEqual(
    (await listBenchmarks()).map((item) => item.id),
    ["coding-functions-v1", "coding-adversarial-v1"],
  );
  const benchmark = await loadBenchmark("coding-adversarial-v1");
  assert.equal(benchmark.tasks.length, 6);
  for (const task of benchmark.tasks) {
    assert.equal(task.nonMutating, true);
    assert.ok(task.cases.length >= 6);
    assert.ok(task.cases.every((item) => item.label));
    assert.equal(
      new Set(task.cases.map((item) => item.label)).size,
      task.cases.length,
    );
  }
});

// Independent algorithms exercise every hand-authored expected value through the real checker.
// These are test-only programs, never registered adapters or model evidence.
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

test("independent reference programs satisfy every adversarial contract", async () => {
  const benchmark = await loadBenchmark("coding-adversarial-v1");
  for (const task of benchmark.tasks) {
    const program = referencePrograms[task.id];
    assert.ok(program, `Missing reference for ${task.id}`);
    const result = await evaluateCode(program, task, projectRoot);
    assert.equal(result.passed, true, `${task.id}: ${result.error}`);
  }
});

test("adversarial cases reject common shortcuts with actionable diagnostics", async () => {
  const benchmark = await loadBenchmark("coding-adversarial-v1");
  const shortcuts = [
    {
      id: "strict-csv",
      program:
        "module.exports = text => text ? text.trimEnd().split(/\\r?\\n/).map(row => row.split(',')) : [];",
      category: /quoted comma/,
    },
    {
      id: "exact-money-sum",
      program:
        "module.exports = values => values.reduce((sum,value)=>sum+Number(value),0).toFixed(2);",
      category: /beyond safe integer/,
    },
    {
      id: "dependency-layers",
      program: "module.exports = tasks => tasks.map(task=>[task.id]);",
      category: /whole ready layer/,
    },
  ];
  for (const shortcut of shortcuts) {
    const task = benchmark.tasks.find((item) => item.id === shortcut.id);
    assert.ok(task);
    const result = await evaluateCode(shortcut.program, task, projectRoot);
    assert.equal(result.passed, false);
    assert.match(result.error || "", shortcut.category);
  }
});
