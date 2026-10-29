"use client";
import Link from "next/link";
import { useState, type KeyboardEvent } from "react";
import type { EvolutionCampaign, NodeRecord, TreeSummary } from "@/core/types";
import { CopyCommand } from "./CopyCommand";
import { CampaignProgress } from "./CampaignProgress";
import { LearningRecord } from "./LearningRecord";
import { Glyph, LineageGraph } from "./LineageGraph";
import {
  benchmarkGroups,
  deltaLabel,
  isChallenge,
  isImprovement,
  lineageSummary,
  nodeLabel,
  scoreLabel,
  shortId,
} from "./lineage";
import {
  campaignForTree,
  campaignPriority,
  parseCampaigns,
  parseTree,
  parseTrees,
  useLiveRecords,
} from "./live";

function q(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function TreeWorkspace({
  initialTree,
  benchmarkAvailable,
  initialTrees,
  initialCampaigns,
  availableBenchmarkHashes,
}: {
  initialTree: TreeSummary;
  benchmarkAvailable: boolean;
  initialTrees: TreeSummary[];
  initialCampaigns: EvolutionCampaign[];
  availableBenchmarkHashes: string[];
}) {
  const { value: tree, error } = useLiveRecords({
    initial: initialTree,
    url: `/api/trees/${encodeURIComponent(initialTree.id)}`,
    parse: parseTree,
  });
  const { value: trees } = useLiveRecords({
    initial: initialTrees,
    url: "/api/trees",
    parse: parseTrees,
  });
  const { value: campaigns } = useLiveRecords({
    initial: initialCampaigns,
    url: "/api/campaigns",
    parse: parseCampaigns,
  });
  const [selectedId, setSelectedId] = useState(
    initialTree.nodes.at(-1)?.id ?? "",
  );
  const [view, setView] = useState<"tree" | "stats">("tree");
  const node =
    tree.nodes.find((item) => item.id === selectedId) ?? tree.nodes.at(-1);
  const summary = lineageSummary(tree.nodes);
  const groups = benchmarkGroups(tree.nodes);
  const current = groups.at(-1);
  const activeCampaign = campaignForTree(tree, campaigns);
  const successor = trees
    .filter(
      (item) =>
        item.id !== tree.id &&
        item.domain === tree.domain &&
        item.model === tree.model &&
        campaignForTree(item, campaigns),
    )
    .sort(
      (a, b) =>
        campaignPriority(campaignForTree(b, campaigns)) -
          campaignPriority(campaignForTree(a, campaigns)) ||
        b.updatedAt.localeCompare(a.updatedAt),
    )[0];
  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/">Trees</Link>
        <span>/</span>
        <span>{tree.domain}</span>
        <span>/</span>
        <span>
          {tree.harness} × {tree.model}
        </span>
      </nav>
      <div className="page-head">
        <div>
          <h1>
            {tree.harness} <span className="h1-sub">× {tree.model}</span>
          </h1>
          <p className="sub">
            Level {current?.level ?? 0} ·{" "}
            {current?.totalTasks ?? tree.totalTasks} tests · {groups.length}{" "}
            benchmark {groups.length === 1 ? "level" : "levels"} ·{" "}
            {summary.branches} competing branches · {summary.depth} generations.
            Entire recorded lineage.
          </p>
        </div>
        <div className="badges">
          <span className="tag">{tree.domain}</span>
          <span className="tag tag-accent">{summary.kind}</span>
          <span className="tag">{tree.nodes.length} evaluations</span>
        </div>
      </div>
      {!benchmarkAvailable && (
        <aside className="historical-notice">
          <strong>Historical benchmark revision</strong>
          <p>
            This tree records an earlier benchmark or evaluator. Its pass rates
            describe those saved tests.
          </p>
          {successor && (
            <Link
              className="btn btn-primary"
              href={`/tree/${encodeURIComponent(successor.id)}`}
            >
              Open{" "}
              {campaignForTree(successor, campaigns)?.options.continuous
                ? "continuous"
                : "current"}{" "}
              evolution · {successor.nodes.length} evaluations →
            </Link>
          )}
        </aside>
      )}
      <CampaignProgress
        tree={tree}
        onSelect={setSelectedId}
        campaigns={campaigns}
      />
      <div className="view-bar">
        <div className="seg" role="group" aria-label="View">
          <button
            type="button"
            aria-pressed={view === "tree"}
            onClick={() => setView("tree")}
          >
            Tree
          </button>
          <button
            type="button"
            aria-pressed={view === "stats"}
            onClick={() => setView("stats")}
          >
            Stats
          </button>
        </div>
        <span className={`live-note ${error ? "has-error" : ""}`} role="status">
          {error ??
            (tree.nodes.some((item) => item.status === "running")
              ? "● Run in progress · updates every 2s"
              : "Live local records")}
        </span>
      </div>
      {node ? (
        <>
          {view === "tree" ? (
            <figure className="stage">
              <LineageGraph
                nodes={tree.nodes}
                selected={node.id}
                onSelect={setSelectedId}
                headId={activeCampaign?.activeNodeId ?? undefined}
              />
              <figcaption
                className={`selected-strip status-${node.status}`}
                aria-live="polite"
              >
                <svg width="14" height="14" aria-hidden="true">
                  <Glyph status={node.status} />
                </svg>
                <span className="sel-word">
                  {nodeLabel(node).toUpperCase()} · {shortId(node.id)}
                </span>
                <span className="sel-hyp">{node.hypothesis}</span>
                <span className="sel-num">
                  {scoreLabel(node.score)}
                  {isChallenge(node)
                    ? " · harder benchmark"
                    : node.comparison
                      ? ` · ${deltaLabel(node.comparison.delta)}`
                      : ""}
                </span>
                <a href="#record">Full record ↓</a>
              </figcaption>
            </figure>
          ) : (
            <TreeStats
              tree={tree}
              onSelect={(id) => {
                setSelectedId(id);
                setView("tree");
              }}
            />
          )}
          <section id="record" className="record">
            <NodePanel
              node={node}
              tree={tree}
              onSelect={setSelectedId}
              benchmarkAvailable={availableBenchmarkHashes.includes(
                node.config.benchmarkHash,
              )}
            />
            <InfoPanels tree={tree} node={node} onSelect={setSelectedId} />
          </section>
        </>
      ) : (
        <div className="empty-state">
          <h2>No evaluations recorded yet</h2>
          <p>Start a run in the CLI to populate this tree.</p>
        </div>
      )}
    </>
  );
}

function NodePanel({
  node,
  tree,
  onSelect,
  benchmarkAvailable,
}: {
  node: NodeRecord;
  tree: TreeSummary;
  onSelect: (id: string) => void;
  benchmarkAvailable: boolean;
}) {
  const parent = tree.nodes.find((item) => item.id === node.parentId);
  const passed = node.tasks.filter((task) => task.passed).length;
  const cost = node.tasks.reduce((sum, task) => sum + (task.costUsd ?? 0), 0);
  const hasCost = node.tasks.some((task) => task.costUsd !== null);
  const verdict = isChallenge(node)
    ? "The unchanged harness was re-evaluated on a harder benchmark. This is a new challenge baseline, not a learned upgrade. Its score is not a delta against the previous level."
    : node.status === "baseline"
      ? "Starting point for this tree. No parent comparison."
      : node.status === "running"
        ? "Evaluation is running. Completed tasks appear as they are recorded."
        : (node.comparison?.reason ?? node.error ?? "No comparison recorded.");
  const canFork =
    benchmarkAvailable &&
    node.status !== "running" &&
    node.status !== "failed" &&
    node.score !== null;
  const settings = Object.entries(node.config.settings)
    .filter(([key]) => key !== "instructions")
    .map(([key, value]) => ` --setting ${q(`${key}=${value}`)}`)
    .join("");
  const runCommand = `npm run cli -- run --adapter ${q(node.config.adapterId)} --domain ${q(node.config.domain)} --model ${q(node.config.model)} --harness ${q(node.config.harness)} --benchmark ${q(node.config.benchmarkPath ?? "PATH_TO_YOUR_BENCHMARK_JSON")} --parent ${q(node.id)}${settings} --hypothesis "Describe your change" --instructions "Describe the harness change to evaluate"`;
  const evolveCommand = `npm run cli -- evolve --continuous --adapter ${q(node.config.adapterId)} --domain ${q(node.config.domain)} --model ${q(node.config.model)} --harness ${q(node.config.harness)} --benchmark ${q(node.config.benchmarkPath ?? "PATH_TO_YOUR_BENCHMARK_JSON")} --parent ${q(node.id)}${settings} --beam-width 2 --max-calls 100`;
  return (
    <aside className="node-panel">
      <div className="np-head">
        <span className="eyebrow">SELECTED EVALUATION</span>
        <span className={`status-label status-${node.status}`}>
          {nodeLabel(node)}
        </span>
      </div>
      <code className="record-id">{node.id}</code>
      <h2 className="np-hyp">{node.hypothesis}</h2>
      <div className={`verdict status-${node.status}`}>
        <strong>{nodeLabel(node).toUpperCase()}</strong>
        <p>{verdict}</p>
      </div>
      <dl className="facts">
        <div>
          <dt>Score</dt>
          <dd>{scoreLabel(node.score)}</dd>
        </div>
        <div>
          <dt>Parent delta</dt>
          <dd>
            {isChallenge(node)
              ? "New benchmark"
              : node.comparison
                ? deltaLabel(node.comparison.delta)
                : "—"}
          </dd>
        </div>
        <div>
          <dt>Tasks passed</dt>
          <dd>
            {passed}/{node.totalTasks}
          </dd>
        </div>
        <div>
          <dt>Completed</dt>
          <dd>
            {node.tasks.length}/{node.totalTasks}
          </dd>
        </div>
      </dl>
      {node.comparison && !isChallenge(node) && (
        <div className="np-block">
          <h3>Paired comparison</h3>
          <p>
            Parent {scoreLabel(node.comparison.parentScore)} → candidate{" "}
            {scoreLabel(node.comparison.candidateScore)}. Both evaluated on this
            benchmark in the same run.
          </p>
        </div>
      )}
      {node.error && (
        <div className="error-detail">
          <h3>Run error</h3>
          <pre>{node.error}</pre>
        </div>
      )}
      <div className="np-block">
        <h3>Configuration fingerprint</h3>
        <code className="hash">{node.harnessHash}</code>
      </div>
      <dl className="record-meta">
        <div>
          <dt>Benchmark level</dt>
          <dd>
            {node.curriculum?.level ?? 0} · {node.config.benchmarkId} ·{" "}
            {node.totalTasks} tests
          </dd>
        </div>
        <div>
          <dt>Benchmark hash</dt>
          <dd>
            <code className="hash">{node.config.benchmarkHash}</code>
          </dd>
        </div>
        <div>
          <dt>Adapter</dt>
          <dd>{node.config.adapterId}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{new Date(node.createdAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Run duration</dt>
          <dd>
            {node.completedAt
              ? `${((Date.parse(node.completedAt) - Date.parse(node.createdAt)) / 1000).toFixed(1)}s`
              : "In progress"}
          </dd>
        </div>
        <div>
          <dt>Reported cost subtotal</dt>
          <dd>{hasCost ? `$${cost.toFixed(4)}` : "Not reported"}</dd>
        </div>
      </dl>
      {parent && (
        <p className="parent-link">
          Parent{" "}
          <button onClick={() => onSelect(parent.id)}>
            {shortId(parent.id)} ↑
          </button>
        </p>
      )}
      <div className="np-block">
        <h3>Inspect this record</h3>
        <CopyCommand command={`npm run cli -- inspect ${q(node.id)}`} />
      </div>
      <div className="np-block">
        <h3>Evolve from this version</h3>
        {canFork ? (
          <>
            <p>
              Evaluate 2–6 sibling changes per evolution, adapting the count to
              observed failures. Complete each sibling round before advancing a
              solved level to harder tests. At 100 adapter calls the campaign
              saves a checkpoint and waits for an explicit budget grant.
            </p>
            <CopyCommand command={evolveCommand} />
          </>
        ) : (
          <p>
            Choose a completed version with an available benchmark to start
            branching evolution.
          </p>
        )}
      </div>
      <div className="np-block">
        <h3>Fork from this version</h3>
        {canFork ? (
          <>
            <p>
              Edit the hypothesis and instructions, then run in your terminal.
              {!node.config.benchmarkPath
                ? " Replace PATH_TO_YOUR_BENCHMARK_JSON with the original benchmark file path."
                : ""}
            </p>
            <CopyCommand command={runCommand} />
          </>
        ) : (
          <p>
            {benchmarkAvailable
              ? "Choose a completed baseline, accepted or rejected version to fork."
              : "This historical benchmark or its evaluator has changed or is unavailable. Start a new tree with the current benchmark to make comparable measurements."}
          </p>
        )}
      </div>
      <details className="raw-record">
        <summary>Raw record JSON</summary>
        <pre>{JSON.stringify(node, null, 2)}</pre>
      </details>
    </aside>
  );
}

const infoTabs = ["Goal", "Rules", "How it works", "Limits"];
function InfoPanels({
  tree,
  node,
  onSelect,
}: {
  tree: TreeSummary;
  node: NodeRecord;
  onSelect: (id: string) => void;
}) {
  const [tab, setTab] = useState("Goal");
  function moveTab(event: KeyboardEvent<HTMLButtonElement>, name: string) {
    const index = infoTabs.indexOf(name);
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % infoTabs.length
        : event.key === "ArrowLeft"
          ? (index - 1 + infoTabs.length) % infoTabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? infoTabs.length - 1
              : null;
    const label = next === null ? undefined : infoTabs[next];
    if (label && next !== null) {
      event.preventDefault();
      setTab(label);
      event.currentTarget.parentElement
        ?.querySelectorAll<HTMLButtonElement>("button")
        [next]?.focus();
    }
  }
  return (
    <div className="record-info">
      <LearningRecord tree={tree} node={node} onSelect={onSelect} />
      <div className="chips" role="tablist" aria-label="About this tree">
        {infoTabs.map((name) => (
          <button
            key={name}
            id={`tab-${name.replaceAll(" ", "-")}`}
            role="tab"
            tabIndex={tab === name ? 0 : -1}
            onKeyDown={(event) => moveTab(event, name)}
            aria-selected={tab === name}
            aria-controls="info-panel"
            className="chip"
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </div>
      <section
        className="info-panel"
        id="info-panel"
        role="tabpanel"
        aria-labelledby={`tab-${tab.replaceAll(" ", "-")}`}
      >
        {tab === "Goal" ? (
          <>
            <span className="eyebrow">THE GOAL</span>
            <h2>Turn mistakes into competing experiments.</h2>
            <p className="lede">
              Study what failed in {tree.harness} on {tree.model}, propose
              alternative harness changes and measure each branch against its
              parent on the same tests. The next round learns from rejected
              branches as well as accepted ones. Continuous campaigns advance
              solved benchmarks to harder tests and record a new baseline.
            </p>
            <dl className="goal-facts">
              <div>
                <dt>Benchmark</dt>
                <dd>{node.config.benchmarkId}</dd>
              </div>
              <div>
                <dt>Tasks</dt>
                <dd>{node.totalTasks}</dd>
              </div>
              <div>
                <dt>Metric</dt>
                <dd>Tasks passed</dd>
              </div>
            </dl>
            <p className="small-note">
              Selected benchmark hash{" "}
              <code className="hash">{node.config.benchmarkHash}</code>
            </p>
          </>
        ) : tab === "Rules" ? (
          <>
            <span className="eyebrow">ACCEPTANCE RULES</span>
            <h2>A result comes from execution.</h2>
            <ol className="rules">
              <li>
                <b>Establish a baseline.</b> Run the starting harness on every
                task.
              </li>
              <li>
                <b>Change the harness.</b> Record the hypothesis, instructions
                and configuration fingerprint.
              </li>
              <li>
                <b>Compare like with like.</b> Use the same task set and model.
                Preserve the adapter and settings for each version.
              </li>
              <li>
                <b>Keep every outcome.</b> Improvements are accepted.
                Regressions and ties are rejected. Execution errors remain
                visible.
              </li>
            </ol>
          </>
        ) : tab === "How it works" ? (
          <>
            <span className="eyebrow">THE LOOP</span>
            <h2>Observe. Branch. Measure. Learn.</h2>
            <ol className="rules">
              <li>Register an adapter that runs your harness.</li>
              <li>
                Start an evolution campaign with several proposals per round.
                The proposer reads recorded outcomes and cites the versions
                behind each lesson.
              </li>
              <li>
                The evaluator reruns the parent and each candidate on real
                tasks. Competing children share a parent; rejected branches
                remain available to later proposals.
              </li>
              <li>
                This page reads the store every two seconds while visible.
                Select a node to inspect the complete result.
              </li>
              <li>
                Continuous campaigns preserve every level, checkpoint when their
                call allowance runs out and resume only after an explicit grant.
              </li>
            </ol>
            <Link className="text-link" href="/adapters">
              Adapter protocol and setup →
            </Link>
          </>
        ) : (
          <>
            <span className="eyebrow">WHAT A SCORE MEANS</span>
            <h2>One measured comparison, with limits.</h2>
            <ul className="limits">
              <li>
                A paired run is one evaluation. It does not establish
                statistical confidence or independent verification.
              </li>
              <li>
                A higher task pass rate applies to this benchmark.
                Generalization requires more tasks and repeated runs.
              </li>
              <li>
                Costs and tokens appear only when the adapter reports them.
              </li>
              <li>
                Adapters run locally with your configured credentials and
                permissions.
              </li>
            </ul>
          </>
        )}
      </section>
      <section className="task-panel" id="task-results">
        <div className="section-head">
          <h2>Task results</h2>
          <span className="muted">
            {node.tasks.length} of {node.totalTasks} completed
          </span>
        </div>
        {node.tasks.length ? (
          <div className="task-list">
            {node.tasks.map((task) => {
              const paired = node.comparison?.parentTasks.find(
                (item) => item.taskId === task.taskId,
              );
              return (
                <details
                  key={task.taskId}
                  className={`task-row ${task.passed ? "task-passed" : "task-failed"}`}
                >
                  <summary>
                    <span className="task-state">
                      {task.passed ? "PASS" : "FAIL"}
                    </span>
                    <span>{task.taskId}</span>
                    <span className="task-duration">
                      {(task.durationMs / 1000).toFixed(2)}s
                    </span>
                  </summary>
                  <div className="task-detail">
                    {paired && (
                      <p className="muted">
                        Paired parent: {paired.passed ? "PASS" : "FAIL"} ·{" "}
                        {(paired.durationMs / 1000).toFixed(2)}s
                      </p>
                    )}
                    {task.error && (
                      <pre className="error-output">{task.error}</pre>
                    )}
                    <h3>Candidate output</h3>
                    <pre>{task.output || "No output returned."}</pre>
                    {paired && (
                      <>
                        <h3>Parent output</h3>
                        <pre>
                          {paired.error ??
                            (paired.output || "No output returned.")}
                        </pre>
                      </>
                    )}
                    <p className="muted">
                      Input tokens: {task.inputTokens ?? "not reported"} ·
                      Output tokens: {task.outputTokens ?? "not reported"} ·
                      Cost:{" "}
                      {task.costUsd === null
                        ? "not reported"
                        : `$${task.costUsd.toFixed(5)}`}
                    </p>
                  </div>
                </details>
              );
            })}
          </div>
        ) : (
          <p className="muted">
            {node.status === "running"
              ? "Waiting for the first task result…"
              : "No task results were recorded."}
          </p>
        )}
      </section>
    </div>
  );
}

function TreeStats({
  tree,
  onSelect,
}: {
  tree: TreeSummary;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="stats">
      <p className="muted">
        Each panel measures one benchmark revision. Pass rates across levels use
        different tests and cannot be read as an improvement curve.
      </p>
      {benchmarkGroups(tree.nodes).map((group) => (
        <section className="benchmark-stats" key={group.hash}>
          <div className="section-head">
            <h2>
              Level {group.level} · {group.totalTasks} tests
            </h2>
            <code className="muted">
              {group.id} · {group.hash.slice(0, 8)}
            </code>
          </div>
          <BenchmarkStats
            tree={{
              ...tree,
              nodes: group.nodes,
              totalTasks: group.totalTasks,
              benchmarkId: group.id,
              benchmarkHash: group.hash,
            }}
            onSelect={onSelect}
          />
        </section>
      ))}
    </section>
  );
}

function BenchmarkStats({
  tree,
  onSelect,
}: {
  tree: TreeSummary;
  onSelect: (id: string) => void;
}) {
  const completed = tree.nodes.filter((node) => node.score !== null);
  const accepted = tree.nodes.filter(isImprovement);
  const baseline = tree.nodes.find((node) => node.status === "baseline");
  const best = completed.length
    ? Math.max(
        ...completed.flatMap((node) =>
          node.score === null ? [] : [node.score],
        ),
      )
    : null;
  const graphWidth = Math.max(720, tree.nodes.length * 80 + 80);
  return (
    <section className="stats">
      <dl className="stats-facts">
        <div>
          <dt>Baseline</dt>
          <dd>{scoreLabel(baseline?.score ?? null)}</dd>
        </div>
        <div>
          <dt>Best measured</dt>
          <dd>{scoreLabel(best)}</dd>
        </div>
        <div>
          <dt>Accepted changes</dt>
          <dd>{accepted.length}</dd>
        </div>
        <div>
          <dt>Failures kept</dt>
          <dd>
            {
              tree.nodes.filter(
                (node) =>
                  node.status === "rejected" || node.status === "failed",
              ).length
            }
          </dd>
        </div>
      </dl>
      <div className="chart-panel">
        <h2>Measured pass rate</h2>
        <div className="chart-scroll">
          <svg
            width={graphWidth}
            height={270}
            role="img"
            aria-label="Score by recorded evaluation on the same benchmark"
          >
            {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
              <g key={tick}>
                <line
                  className="chart-grid"
                  x1={48}
                  x2={graphWidth - 20}
                  y1={220 - tick * 180}
                  y2={220 - tick * 180}
                />
                <text className="chart-label" x={5} y={224 - tick * 180}>
                  {tick * 100}%
                </text>
              </g>
            ))}
            {tree.nodes.map((node, index) =>
              node.score === null ? null : (
                <g key={node.id}>
                  <circle
                    className={
                      node.status === "rejected"
                        ? "chart-rejected"
                        : "chart-point"
                    }
                    cx={80 + index * 80}
                    cy={220 - node.score * 180}
                    r={5}
                  >
                    <title>
                      {shortId(node.id)}: {scoreLabel(node.score)} ·{" "}
                      {nodeLabel(node)}
                    </title>
                  </circle>
                  <text
                    className="chart-label"
                    x={80 + index * 80}
                    y={245}
                    textAnchor="middle"
                  >
                    {index + 1}
                  </text>
                </g>
              ),
            )}
          </svg>
        </div>
        <p className="muted">
          Evaluation order · individual measured scores, including rejected
          changes.
        </p>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Evaluation</th>
              <th>Hypothesis</th>
              <th>Status</th>
              <th>Score</th>
              <th>Paired delta</th>
            </tr>
          </thead>
          <tbody>
            {tree.nodes.map((node) => (
              <tr key={node.id}>
                <td>
                  <button
                    className="text-button"
                    onClick={() => onSelect(node.id)}
                  >
                    {shortId(node.id)}
                  </button>
                </td>
                <td>{node.hypothesis}</td>
                <td>
                  <span className={`status-label status-${node.status}`}>
                    {node.status}
                  </span>
                </td>
                <td>{scoreLabel(node.score)}</td>
                <td>
                  {isChallenge(node)
                    ? "New benchmark baseline"
                    : node.comparison
                      ? deltaLabel(node.comparison.delta)
                      : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
