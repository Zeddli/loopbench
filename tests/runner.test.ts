import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runBenchmark } from "../core/runner";
import {
  addAdapter,
  getNode,
  listAdapters,
  listTrees,
  projectRoot,
  saveNode,
} from "../core/store";
import { evaluateCode, loadBenchmark } from "../core/benchmarks";
import { runProcess } from "../core/adapters";

test("real child-process evaluations persist a baseline, paired acceptance/rejection and failures in isolated storage", async () => {
  const temporary = await mkdtemp(path.join(projectRoot, ".loopbench-test-"));
  const previous = process.env.LOOPBENCH_HOME;
  process.env.LOOPBENCH_HOME = temporary;
  try {
    assert.deepEqual(await listTrees(), []);
    await addAdapter(
      {
        id: "integration-fixture",
        name: "Test fixture",
        command: process.execPath,
        args: ["./tests/fixture-adapter.mjs"],
        protocol: "loopbench.task.v1",
        timeoutMs: 3000,
      },
      projectRoot,
    );
    assert.equal((await listAdapters()).length, 2);
    const options = {
      adapterId: "integration-fixture",
      domain: "coding",
      model: "test-fixture-only",
      harness: "test-process",
      benchmark: "coding-functions-v1",
      hypothesis: "Integration test",
      settings: { mode: "incorrect" },
    };
    let pendingObserved = false;
    const baseline = await runBenchmark(options, (node) => {
      if (node.status === "running" && node.tasks.length === 0)
        pendingObserved = true;
    });
    assert.equal(pendingObserved, true);
    assert.equal(baseline.status, "baseline");
    assert.equal(baseline.score, 0);
    assert.equal(baseline.tasks.length, 3);
    assert.ok(
      baseline.tasks.every((task) => task.error?.includes("Hidden check")),
    );
    const accepted = await runBenchmark({
      ...options,
      parentId: baseline.id,
      settings: { mode: "correct" },
    });
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.score, 1);
    assert.equal(accepted.comparison?.parentScore, 0);
    assert.equal(accepted.comparison?.parentTasks.length, 3);
    assert.equal(accepted.comparison?.delta, 1);
    assert.ok(
      accepted.tasks.every(
        (task) => task.inputTokens === 7 && task.outputTokens === 9,
      ),
    );
    assert.equal(baseline.treeId, accepted.treeId);
    assert.notEqual(baseline.harnessHash, accepted.harnessHash);
    const rejected = await runBenchmark({
      ...options,
      parentId: accepted.id,
      settings: { mode: "incorrect" },
    });
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.comparison?.parentScore, 1);
    assert.equal(rejected.comparison?.delta, -1);
    const failed = await runBenchmark({
      ...options,
      parentId: accepted.id,
      settings: { mode: "invalid" },
    });
    assert.equal(failed.status, "failed");
    assert.match(failed.error || "", /valid.*JSON/);
    assert.equal((await getNode(failed.id))?.status, "failed");
    await assert.rejects(
      saveNode({ ...accepted, hypothesis: "overwrite" }),
      /immutable/,
    );
    await assert.rejects(
      runBenchmark({ ...options, model: "other-model", parentId: accepted.id }),
      /same.*tree/,
    );
    await assert.rejects(
      runBenchmark({ ...options, parentId: failed.id }),
      /completed valid/,
    );
    await assert.rejects(
      runBenchmark({ ...options, parentId: "not-found" }),
      /does not exist/,
    );
    const trees = await listTrees();
    assert.equal(trees.length, 1);
    assert.equal(trees[0]?.nodes.length, 4);
    assert.equal(
      (await readdir(path.join(temporary, "nodes"))).filter((file) =>
        file.endsWith(".json"),
      ).length,
      4,
    );
    await assert.rejects(
      addAdapter({
        id: "bad",
        name: "bad",
        command: "example",
        args: ["--api-key=secret"],
        protocol: "loopbench.task.v1",
      }),
      /Credentials/,
    );
    await assert.rejects(
      addAdapter({
        id: "bad",
        name: "bad",
        command: "example",
        args: [],
        protocol: "loopbench.task.v1",
        apiKey: "secret",
      }),
      /Unrecognized/,
    );
    const benchmark = await loadBenchmark("coding-functions-v1");
    const firstTask = benchmark.tasks[0];
    assert.ok(firstTask);
    const infinite = await evaluateCode(
      "module.exports = () => { while(true){} };",
      firstTask,
      temporary,
    );
    assert.equal(infinite.passed, false);
    assert.match(infinite.error || "", /timed out/);
    const escaped = await evaluateCode(
      "module.exports = values => values.constructor.constructor('return process')().env;",
      firstTask,
      temporary,
    );
    assert.equal(escaped.passed, false);
    assert.match(
      escaped.error || "",
      /Code generation from strings disallowed/,
    );
    await assert.rejects(
      runProcess(
        process.execPath,
        ["-e", "setTimeout(()=>{},10000)"],
        "",
        temporary,
        50,
      ),
      /timed out/,
    );
    const manifest = path.join(temporary, "manifest.json");
    await writeFile(
      manifest,
      JSON.stringify({
        id: "portable",
        name: "portable",
        command: process.execPath,
        args: ["./relative.mjs"],
        protocol: "loopbench.task.v1",
      }),
    );
    await addAdapter(JSON.parse(await readFile(manifest, "utf8")), temporary);
    assert.equal(
      (await listAdapters()).find((item) => item.id === "portable")?.args[0],
      path.join(temporary, "relative.mjs"),
    );
    const custom = path.join(temporary, "custom-benchmark.json");
    const customDefinition = {
      id: "custom-functions",
      name: "Custom test",
      domain: "coding",
      tasks: [firstTask],
    };
    await writeFile(custom, JSON.stringify(customDefinition));
    const customBenchmark = await loadBenchmark(custom);
    assert.notEqual(customBenchmark.hash, benchmark.hash);
    const customNode = await runBenchmark({
      ...options,
      benchmark: custom,
      settings: { mode: "correct" },
    });
    assert.equal(customNode.status, "baseline");
    assert.equal(customNode.score, 1);
    assert.notEqual(customNode.treeId, baseline.treeId);
    await assert.rejects(
      runBenchmark({ ...options, benchmark: custom, parentId: baseline.id }),
      /same.*tree/,
    );
    await assert.rejects(
      runBenchmark({ ...options, domain: "research" }),
      /Benchmark domain/,
    );
    const concurrent = await Promise.all([
      runBenchmark({ ...options, parentId: baseline.id }),
      runBenchmark({ ...options, parentId: baseline.id }),
    ]);
    assert.notEqual(concurrent[0]?.id, concurrent[1]?.id);
    assert.ok(concurrent.every((node) => node.status === "rejected"));
    assert.equal(
      (await listTrees()).find((tree) => tree.id === baseline.treeId)?.nodes
        .length,
      6,
    );
    const copy = path.join(temporary, "copied-adapter.mjs");
    await writeFile(
      copy,
      await readFile(path.join(projectRoot, "tests", "fixture-adapter.mjs")),
    );
    await addAdapter({
      id: "drift-test",
      name: "Drift test",
      command: process.execPath,
      args: [copy],
      protocol: "loopbench.task.v1",
      timeoutMs: 3000,
    });
    const original = await runBenchmark({
      ...options,
      adapterId: "drift-test",
      benchmark: custom,
    });
    await writeFile(
      copy,
      `${await readFile(copy, "utf8")}\n// changed entrypoint`,
    );
    const drift = await runBenchmark({
      ...options,
      adapterId: "drift-test",
      benchmark: custom,
      parentId: original.id,
    });
    assert.equal(drift.status, "failed");
    assert.match(drift.error || "", /entrypoint.*changed/);
  } finally {
    if (previous === undefined) delete process.env.LOOPBENCH_HOME;
    else process.env.LOOPBENCH_HOME = previous;
    await rm(temporary, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});
