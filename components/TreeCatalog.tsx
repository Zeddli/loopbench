"use client";
import Link from "next/link";
import { useState } from "react";
import type {
  AdapterManifest,
  EvolutionCampaign,
  TreeSummary,
} from "@/core/types";
import { CopyCommand } from "./CopyCommand";
import { MiniLineage } from "./LineageGraph";
import {
  benchmarkGroups,
  isImprovement,
  lineageSummary,
  scoreLabel,
} from "./lineage";
import {
  campaignForTree,
  campaignLabel,
  campaignPriority,
  parseCampaigns,
  parseTrees,
  useLiveRecords,
} from "./live";

function q(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function TreeCatalog({
  initialTrees,
  adapters,
  initialCampaigns,
}: {
  initialTrees: TreeSummary[];
  adapters: AdapterManifest[];
  initialCampaigns: EvolutionCampaign[];
}) {
  const { value: trees, error } = useLiveRecords({
    initial: initialTrees,
    url: "/api/trees",
    parse: parseTrees,
  });
  const { value: campaigns } = useLiveRecords({
    initial: initialCampaigns,
    url: "/api/campaigns",
    parse: parseCampaigns,
  });
  const [domain, setDomain] = useState("");
  const [model, setModel] = useState("");
  const [harness, setHarness] = useState("");
  const shown = trees
    .filter(
      (tree) =>
        (!domain || tree.domain === domain) &&
        (!model || tree.model === model) &&
        (!harness || tree.harness === harness),
    )
    .sort(
      (a, b) =>
        campaignPriority(campaignForTree(b, campaigns)) -
          campaignPriority(campaignForTree(a, campaigns)) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
  const active = shown.filter(
    (tree) =>
      campaignPriority(campaignForTree(tree, campaigns)) >= 60 ||
      tree.nodes.some((node) => node.status === "running"),
  );
  const activeIds = new Set(active.map((tree) => tree.id));
  const branching = shown.filter(
    (tree) =>
      !activeIds.has(tree.id) && lineageSummary(tree.nodes).branchPoints > 0,
  );
  const other = shown.filter(
    (tree) =>
      !activeIds.has(tree.id) &&
      lineageSummary(tree.nodes).branchPoints === 0 &&
      !tree.nodes.every((node) => node.status === "failed"),
  );
  const failed = shown.filter(
    (tree) =>
      !activeIds.has(tree.id) &&
      tree.nodes.length > 0 &&
      tree.nodes.every((node) => node.status === "failed"),
  );
  const domains = [...new Set(trees.map((tree) => tree.domain))];
  const models = [...new Set(trees.map((tree) => tree.model))];
  const harnesses = [...new Set(trees.map((tree) => tree.harness))];
  const first = active[0] ?? branching[0] ?? other[0];
  const config = first?.nodes.find((node) => node.status !== "failed")?.config;
  const adapterId = config?.adapterId ?? adapters[0]?.id ?? "YOUR_ADAPTER";
  const startingBenchmark =
    !config || config.benchmarkId === "coding-functions-v1"
      ? "coding-adversarial-v1"
      : (config.benchmarkPath ?? config.benchmarkId);
  const command = `npm run cli -- evolve --continuous --adapter ${q(adapterId)} --domain ${q(config?.domain ?? "coding")} --model ${q(config?.model ?? "YOUR_MODEL")} --harness ${q(config?.harness ?? adapterId)} --benchmark ${q(startingBenchmark)} --beam-width 2 --max-calls 100`;
  return (
    <>
      <section className="home-hero">
        <h1>
          Evolve an AI agent&apos;s harness.
          <br className="hero-break" /> Keep learning. Raise the challenge.
        </h1>
        <p className="sub">
          Branch into competing experiments, learn from their mistakes, then
          advance to harder tests when a benchmark is solved. Continuous
          campaigns keep the whole lineage and checkpoint when their call budget
          runs out.
        </p>
        <div className="composer">
          <div className="composer-row">
            <label className="field">
              <span>Domain</span>
              <select
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
              >
                <option value="">All domains</option>
                {domains.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Model</span>
              <select
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                <option value="">All models</option>
                {models.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Harness</span>
              <select
                value={harness}
                onChange={(event) => setHarness(event.target.value)}
              >
                <option value="">All harnesses</option>
                {harnesses.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            {first ? (
              <Link
                className="btn btn-primary"
                href={`/tree/${encodeURIComponent(first.id)}`}
              >
                {active.length ? "Open active evolution →" : "Open tree →"}
              </Link>
            ) : (
              <a className="btn btn-primary" href="#start-tree">
                Start evolution →
              </a>
            )}
          </div>
          <p className="composer-note">
            {active.length} active · {branching.length} recorded branching{" "}
            {branching.length === 1 ? "tree" : "trees"} · {other.length}{" "}
            baselines / single-branch experiments · {failed.length} failed runs
          </p>
        </div>
      </section>
      {active.length > 0 && (
        <section className="section active-catalog">
          <div className="section-head">
            <h2>Active evolution</h2>
            <span className="live-note">Live · updates every 2s</span>
          </div>
          <p className="muted">
            Current workers and saved checkpoints. Open a tree to follow
            learning, challenge levels and the remaining call budget.
          </p>
          <TreeCards trees={active} campaigns={campaigns} />
        </section>
      )}
      {(branching.length > 0 || active.length === 0) && (
        <section className="section">
          <div className="section-head">
            <h2>Recorded branching trees</h2>
            <span className="muted">
              {branching.length} {branching.length === 1 ? "tree" : "trees"}{" "}
              with competing changes
            </span>
            <span className="live-note" role="status">
              {error ?? "Live local records"}
            </span>
          </div>
          {branching.length ? (
            <TreeCards trees={branching} campaigns={campaigns} />
          ) : (
            <div className="empty-state">
              <h2>
                {trees.length
                  ? "Ready for competing experiments"
                  : "Start your first evolution"}
              </h2>
              <p>
                A baseline establishes the starting score. The evolution command
                proposes several changes, evaluates their branches and uses the
                results to guide the next round.
              </p>
              <a className="text-link" href="#start-tree">
                Run a branching campaign ↓
              </a>
            </div>
          )}
        </section>
      )}
      {other.length > 0 && (
        <details className="catalog-records" open={!branching.length}>
          <summary>
            Baselines and single-branch experiments{" "}
            <span className="muted">({other.length})</span>
          </summary>
          <p className="muted">
            These records have not developed competing branches yet. Open one to
            continue evolution from a measured version.
          </p>
          <TreeCards trees={other} campaigns={campaigns} />
        </details>
      )}
      {failed.length > 0 && (
        <details className="catalog-records">
          <summary>
            Failed runs <span className="muted">({failed.length})</span>
          </summary>
          <p className="muted">
            Execution failures with no valid baseline. Their records and errors
            remain available.
          </p>
          <TreeCards trees={failed} campaigns={campaigns} />
        </details>
      )}
      <section className="start-panel" id="start-tree">
        <h2>Run continuous evolution</h2>
        <p className="muted">
          Run in PowerShell with your adapter credentials configured. This keeps
          evaluating 2–6 sibling changes per evolution, adapting the count to
          observed failures. It completes the sibling round before advancing a
          solved level to harder tests. At 100 adapter calls it saves a
          checkpoint and waits for an explicit grant. The cap counts proposal
          and evaluation invocations; it is not a dollar budget.
          {!config
            ? " Replace YOUR_MODEL with a model supported by your adapter."
            : ""}
        </p>
        <CopyCommand command={command} />
        <Link className="text-link" href="/adapters">
          Adapter setup and protocol →
        </Link>
      </section>
    </>
  );
}

function TreeCards({
  trees,
  campaigns,
}: {
  trees: TreeSummary[];
  campaigns: EvolutionCampaign[];
}) {
  return (
    <ul className="tree-cards">
      {trees.map((tree) => {
        const groups = benchmarkGroups(tree.nodes);
        const current = groups.at(-1);
        const scores = (current?.nodes ?? []).flatMap((node) =>
          node.score === null ? [] : [node.score],
        );
        const summary = lineageSummary(tree.nodes);
        const campaign = campaignForTree(tree, campaigns);
        return (
          <li key={tree.id}>
            <Link
              className="tree-card"
              href={`/tree/${encodeURIComponent(tree.id)}`}
            >
              <div className="card-top">
                <div>
                  <h3>{tree.harness}</h3>
                  <p className="card-sub">on {tree.model}</p>
                </div>
                <span className="tag">{tree.domain}</span>
              </div>
              <div className="card-classification">
                {campaign && (
                  <span className="tag tag-accent">
                    {campaignLabel(campaign)}
                    {campaign.options.continuous ? " · continuous" : ""}
                  </span>
                )}
                <span
                  className={summary.branchPoints ? "tag tag-accent" : "tag"}
                >
                  {summary.kind}
                </span>
                <span className="muted">
                  {summary.branches} competing{" "}
                  {summary.branches === 1 ? "branch" : "branches"} ·{" "}
                  {summary.depth} generations
                </span>
              </div>
              <div className="card-mini">
                <MiniLineage nodes={tree.nodes} />
              </div>
              <p className="card-goal">
                Level {current?.level ?? 0} · {current?.id ?? tree.benchmarkId}{" "}
                · {current?.totalTasks ?? tree.totalTasks} tests ·{" "}
                {groups.length} benchmark{" "}
                {groups.length === 1 ? "level" : "levels"}
                {tree.nodes.some((node) => node.status === "running")
                  ? " · Running"
                  : ""}
              </p>
              <dl className="card-stats">
                <div>
                  <dt>Evaluations</dt>
                  <dd>{tree.nodes.length}</dd>
                </div>
                <div>
                  <dt>Accepted</dt>
                  <dd>{tree.nodes.filter(isImprovement).length}</dd>
                </div>
                <div>
                  <dt>Kept failures</dt>
                  <dd>
                    {
                      tree.nodes.filter(
                        (node) =>
                          node.status === "rejected" ||
                          node.status === "failed",
                      ).length
                    }
                  </dd>
                </div>
                <div>
                  <dt>Best this level</dt>
                  <dd>
                    {scoreLabel(scores.length ? Math.max(...scores) : null)}
                  </dd>
                </div>
              </dl>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
