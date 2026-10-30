"use client";
import { useState } from "react";
import type { NodeRecord } from "@/core/types";
import { Glyph, LineageGraph } from "../LineageGraph";
import {
  benchmarkGroups,
  deltaLabel,
  isImprovement,
  lineageSummary,
  nodeLabel,
  scoreLabel,
  shortId,
} from "../lineage";
export function HarnessView({
  nodes,
  selected,
  onSelect,
  headId,
  statusText,
  activityText,
  recordHref = "#evidence",
}: {
  nodes: NodeRecord[];
  selected: string;
  onSelect: (id: string) => void;
  headId?: string;
  statusText: string;
  activityText?: string;
  recordHref?: string;
}) {
  const [view, setView] = useState<"tree" | "stats">("tree");
  const node = nodes.find((item) => item.id === selected),
    summary = lineageSummary(nodes);
  return (
    <>
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
        <span className="live-note">{statusText}</span>
      </div>
      {view === "tree" ? (
        <figure className="stage">
          <div className="graph-panel">
            <LineageGraph
              activityText={activityText}
              nodes={nodes}
              selected={selected}
              onSelect={onSelect}
              headId={headId}
            />
          </div>
          {node && (
            <figcaption className={`selected-strip status-${node.status}`}>
              <svg width="14" height="14" aria-hidden="true">
                <Glyph status={node.status} />
              </svg>
              <span className="sel-word">
                {nodeLabel(node).toUpperCase()} · {shortId(node.id)}
              </span>
              <span className="sel-hyp">{node.hypothesis}</span>
              <span className="sel-num">
                {scoreLabel(node.score)}
                {node.comparison
                  ? ` · ${deltaLabel(node.comparison.delta)}`
                  : ""}
              </span>
              <a href={recordHref}>Full record ↓</a>
            </figcaption>
          )}
        </figure>
      ) : (
        <section className="section" aria-label="Measured harness statistics">
          <dl className="card-stats">
            <div>
              <dt>Evaluations</dt>
              <dd>{nodes.length}</dd>
            </div>
            <div>
              <dt>Measured improvements</dt>
              <dd>{nodes.filter(isImprovement).length}</dd>
            </div>
            <div>
              <dt>Rejected</dt>
              <dd>
                {nodes.filter((item) => item.status === "rejected").length}
              </dd>
            </div>
            <div>
              <dt>Generations / branches</dt>
              <dd>
                {summary.depth} / {summary.branches}
              </dd>
            </div>
          </dl>
          {benchmarkGroups(nodes).map((group) => (
            <div key={group.hash}>
              <h3>
                {group.id} · {group.hash.slice(0, 8)}
              </h3>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Version</th>
                      <th>Hypothesis</th>
                      <th>Status</th>
                      <th>Score</th>
                      <th>Fresh parent</th>
                      <th>Delta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nodes
                      .filter(
                        (item) => item.config.benchmarkHash === group.hash,
                      )
                      .map((item) => (
                        <tr key={item.id}>
                          <td>
                            <button
                              className="text-button"
                              onClick={() => {
                                onSelect(item.id);
                                setView("tree");
                              }}
                            >
                              {shortId(item.id)}
                            </button>
                          </td>
                          <td>{item.hypothesis}</td>
                          <td>{nodeLabel(item)}</td>
                          <td>{scoreLabel(item.score)}</td>
                          <td>
                            {item.comparison
                              ? scoreLabel(item.comparison.parentScore)
                              : "—"}
                          </td>
                          <td>
                            {item.comparison
                              ? deltaLabel(item.comparison.delta)
                              : "—"}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
