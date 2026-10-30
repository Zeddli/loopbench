"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { NodeRecord } from "@/core/types";
import {
  ancestryOf,
  deltaLabel,
  layoutLineage,
  scoreLabel,
  shortId,
  isChallenge,
  nodeLabel,
  benchmarkGroups,
} from "./lineage";

export function Glyph({
  status,
  x = 7,
  y = 7,
  radius = 6,
}: {
  status: NodeRecord["status"];
  x?: number;
  y?: number;
  radius?: number;
}) {
  if (status === "failed" || status === "rejected")
    return (
      <g className="glyph-cross">
        <circle cx={x} cy={y} r={radius} fill="none" />
        <path
          d={`M${x - radius} ${y - radius}l${radius * 2} ${radius * 2}M${x + radius} ${y - radius}l-${radius * 2} ${radius * 2}`}
        />
      </g>
    );
  return (
    <circle
      cx={x}
      cy={y}
      r={radius}
      className={status === "running" ? "glyph-running" : "glyph-pass"}
    />
  );
}

export function MiniLineage({ nodes }: { nodes: NodeRecord[] }) {
  const { points, width, height } = layoutLineage(nodes);
  return (
    <svg
      className="mini-lineage"
      viewBox={`0 0 ${width} ${height}`}
      aria-label={`${nodes.length} recorded evaluations`}
      role="img"
    >
      {nodes.map((node) => {
        const child = points.get(node.id);
        const parent = node.parentId ? points.get(node.parentId) : null;
        if (!child || !parent) return null;
        return (
          <path
            key={node.id}
            className={`graph-edge ${node.status === "rejected" || node.status === "failed" ? "dead" : ""}`}
            style={{ strokeWidth: 3 }}
            d={`M${parent.x} ${parent.y} C${(parent.x + child.x) / 2} ${parent.y},${(parent.x + child.x) / 2} ${child.y},${child.x} ${child.y}`}
          />
        );
      })}
      {nodes.map((node) => {
        const p = points.get(node.id);
        return p ? (
          <Glyph
            key={node.id}
            x={p.x}
            y={p.y}
            radius={10}
            status={node.status}
          />
        ) : null;
      })}
    </svg>
  );
}

export function LineageGraph({
  nodes,
  selected,
  onSelect,
  headId,
  activityText,
}: {
  nodes: NodeRecord[];
  selected: string;
  onSelect: (id: string) => void;
  headId?: string;
  activityText?: string;
}) {
  const layout = useMemo(() => layoutLineage(nodes), [nodes]);
  const [zoom, setZoom] = useState(1);
  const groups = benchmarkGroups(nodes);
  const ancestry = ancestryOf(nodes, selected);
  const learningSources = new Set(
    nodes.find((node) => node.id === selected)?.learning?.learnedFrom ?? [],
  );
  const viewport = useRef<HTMLDivElement>(null);
  const previousIds = useRef(new Set(nodes.map((node) => node.id)));
  const previousSelected = useRef("");
  function navigate(id: string) {
    onSelect(id);
    const point = layout.points.get(id);
    const element = viewport.current;
    if (point && element)
      element.scrollTo({
        left: Math.max(0, point.x * zoom - 60),
        top: Math.max(0, point.y * zoom - element.clientHeight / 2),
        behavior: "auto",
      });
  }
  useEffect(() => {
    if (previousSelected.current === selected) return;
    previousSelected.current = selected;
    const point = layout.points.get(selected);
    const element = viewport.current;
    if (!point || !element) return;
    const left =
      point.x * zoom < element.scrollLeft + 30
        ? Math.max(0, point.x * zoom - 30)
        : (point.x + 330) * zoom > element.scrollLeft + element.clientWidth
          ? (point.x + 350) * zoom - element.clientWidth
          : element.scrollLeft;
    const top =
      (point.y - 40) * zoom < element.scrollTop
        ? Math.max(0, (point.y - 80) * zoom)
        : (point.y + 40) * zoom > element.scrollTop + element.clientHeight
          ? (point.y + 80) * zoom - element.clientHeight
          : element.scrollTop;
    element.scrollTo({ left, top, behavior: "auto" });
  }, [selected, layout, zoom]);
  useEffect(() => {
    const added = nodes.findLast((node) => !previousIds.current.has(node.id));
    previousIds.current = new Set(nodes.map((node) => node.id));
    const point = added ? layout.points.get(added.id) : null;
    if (point && viewport.current)
      viewport.current.scrollTo({
        left: Math.max(
          0,
          point.x * zoom - viewport.current.clientWidth + 360 * zoom,
        ),
        behavior: "auto",
        top: Math.max(0, point.y * zoom - viewport.current.clientHeight / 2),
      });
  }, [nodes, layout, zoom]);
  return (
    <div className="graph-panel">
      <div className="graph-tools" aria-label="Graph navigation">
        <button
          type="button"
          onClick={() => {
            const root = nodes.find((node) => !node.parentId) ?? nodes[0];
            if (root) navigate(root.id);
          }}
        >
          Root
        </button>
        <button
          type="button"
          onClick={() => {
            const head =
              nodes.find((node) => node.id === headId) ??
              nodes.findLast(
                (node) =>
                  node.status === "accepted" || node.status === "baseline",
              ) ??
              nodes.at(-1);
            if (head) navigate(head.id);
          }}
        >
          Current head
        </button>
        <button
          type="button"
          onClick={() => {
            const element = viewport.current;
            if (element) {
              setZoom(
                Math.max(
                  0.02,
                  Math.min(
                    1,
                    (element.clientWidth - 24) / layout.width,
                    (element.clientHeight - 24) / layout.height,
                  ),
                ),
              );
              element.scrollTo({ left: 0, top: 0 });
            }
          }}
        >
          Fit all
        </button>
        <button type="button" onClick={() => setZoom(1)}>
          100%
        </button>
        <label>
          Zoom{" "}
          <input
            aria-label="Graph zoom"
            type="range"
            min="2"
            max="150"
            step="1"
            value={Math.round(zoom * 100)}
            onChange={(event) => setZoom(Number(event.target.value) / 100)}
          />
          <output>{Math.round(zoom * 100)}%</output>
        </label>
        <span className="muted">
          {nodes.length} evaluations · scroll in both directions
        </span>
      </div>
      <div className="graph-legend" aria-label="Legend">
        <span>
          <svg width="14" height="14" aria-hidden="true">
            <Glyph status="accepted" />
          </svg>
          Accepted · improved on the same tests
        </span>
        <span>
          <svg width="14" height="14" aria-hidden="true">
            <Glyph status="rejected" />
          </svg>
          Rejected · evidence kept
        </span>
        <span>
          <svg width="14" height="14" aria-hidden="true">
            <Glyph status="running" />
          </svg>
          Running · evaluation in progress
        </span>
        {groups.length > 1 && (
          <span>Challenge · same harness on harder tests</span>
        )}
        {learningSources.size > 0 && (
          <span className="learning-legend">
            Dotted outline — cited learning source
          </span>
        )}
      </div>
      <div
        className="graph-scroll"
        ref={viewport}
        tabIndex={0}
        aria-label="Horizontal lineage graph. Scroll to explore all evaluations."
      >
        {activityText && (
          <div
            role="status"
            aria-label="Current graph activity"
            style={{
              position: "sticky",
              top: 0,
              left: 0,
              zIndex: 3,
              padding: "10px 16px",
              background: "var(--pass-soft)",
              color: "var(--ink)",
              borderBottom: "1px solid var(--rule)",
              fontFamily: "var(--mono)",
            }}
          >
            {activityText}
          </div>
        )}
        <svg
          width={layout.width * zoom}
          height={layout.height * zoom}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="group"
          aria-label={`Lineage of ${nodes.length} recorded evaluations`}
        >
          {groups.map((group) => {
            const positions = group.nodes.flatMap((node) => {
              const p = layout.points.get(node.id);
              return p ? [p] : [];
            });
            const start = Math.min(...positions.map((p) => p.x)) - 24;
            const end = Math.max(...positions.map((p) => p.x)) + 330;
            return (
              <g key={group.hash} className="curriculum-stage">
                <rect
                  x={start}
                  y={68}
                  width={Math.max(360, end - start)}
                  height={28}
                  rx={5}
                />
                <text x={start + 12} y={86}>
                  BENCHMARK LEVEL {group.level} · {group.totalTasks} TESTS ·{" "}
                  {group.hash.slice(0, 8)}
                </text>
              </g>
            );
          })}
          {nodes.map((node) => {
            const p = layout.points.get(node.id);
            const parent = node.parentId
              ? layout.points.get(node.parentId)
              : null;
            if (!p || !parent) return null;
            const mid = (p.x + parent.x) / 2;
            return (
              <path
                key={`edge-${node.id}`}
                className={`graph-edge ${node.status === "rejected" || node.status === "failed" ? "dead" : ""}${ancestry.has(node.id) ? " ancestry" : ""}`}
                d={`M${parent.x + 8} ${parent.y} C${mid} ${parent.y},${mid} ${p.y},${p.x - 8} ${p.y}`}
              />
            );
          })}
          {nodes.map((node) => {
            const point = layout.points.get(node.id);
            if (!point) return null;
            const { x, y } = point;
            const active = node.id === selected;
            const hypothesis =
              node.hypothesis.length > 42
                ? `${node.hypothesis.slice(0, 41)}…`
                : node.hypothesis;
            return (
              <g
                key={node.id}
                className={`graph-node status-${node.status}${isChallenge(node) ? " challenge-node" : ""}${active ? " is-selected" : ""}${learningSources.has(node.id) ? " is-learning-source" : ""}`}
                role="button"
                tabIndex={0}
                aria-pressed={active}
                aria-label={`${node.status} ${shortId(node.id)}. ${node.hypothesis}. Score ${scoreLabel(node.score)}`}
                onClick={() => onSelect(node.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(node.id);
                  }
                }}
              >
                <title>{node.hypothesis}</title>
                <rect
                  className="node-backdrop"
                  x={x + 15}
                  y={y - 32}
                  width={300}
                  height={28}
                />
                <rect
                  className="node-backdrop"
                  x={x + 15}
                  y={y + 8}
                  width={300}
                  height={19}
                />
                <rect
                  className="node-hit"
                  x={x - 18}
                  y={y - 36}
                  width={344}
                  height={68}
                  rx={7}
                />
                {active && (
                  <circle className="node-ring" cx={x} cy={y} r={13} />
                )}
                <Glyph status={node.status} x={x} y={y} radius={8} />
                <text className="node-status" x={x + 19} y={y - 21}>
                  {nodeLabel(node).toUpperCase()} · {shortId(node.id)}
                </text>
                <text className="node-hypothesis" x={x + 19} y={y - 5}>
                  {hypothesis}
                </text>
                <text className="node-numbers" x={x + 19} y={y + 21}>
                  {node.status === "running"
                    ? `${node.tasks.length}/${node.totalTasks} tasks completed`
                    : `${scoreLabel(node.score)} · ${node.tasks.filter((task) => task.passed).length}/${node.totalTasks} tasks`}
                </text>
              </g>
            );
          })}
          {nodes.map((node) => {
            const p = layout.points.get(node.id);
            if (
              !p ||
              !node.parentId ||
              (!node.comparison && !isChallenge(node))
            )
              return null;
            const label = isChallenge(node)
              ? "Harder benchmark"
              : node.comparison
                ? deltaLabel(node.comparison.delta)
                : "";
            const width = isChallenge(node) ? 128 : 64;
            const badgeY = p.y - (isChallenge(node) ? 62 : 10);
            return (
              <g key={`delta-${node.id}`} className="edge-badge">
                <rect
                  x={p.x - width - 28}
                  y={badgeY}
                  width={width}
                  height={20}
                  rx={10}
                />
                <text
                  x={p.x - width / 2 - 28}
                  y={badgeY + 13}
                  textAnchor="middle"
                >
                  {label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
