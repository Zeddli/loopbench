import type { NodeRecord } from "@/core/types";

export interface Point {
  x: number;
  y: number;
  depth: number;
}
export interface LineageLayout {
  points: Map<string, Point>;
  width: number;
  height: number;
}

export function lineageSummary(nodes: NodeRecord[]) {
  const childCounts = new Map<string, number>();
  for (const node of nodes)
    if (node.parentId && !isChallenge(node))
      childCounts.set(node.parentId, (childCounts.get(node.parentId) ?? 0) + 1);
  const branchPoints = [...childCounts.values()].filter(
    (count) => count > 1,
  ).length;
  const points = layoutLineage(nodes).points;
  const depth = Math.max(
    0,
    ...[...points.values()].map((point) => point.depth),
  );
  const kind =
    branchPoints > 0
      ? "Branching evolution"
      : nodes.some((node) => node.parentId)
        ? "Single-branch experiment"
        : nodes.every((node) => node.status === "failed")
          ? "Failed run"
          : nodes.some((node) => node.status === "running")
            ? "Run in progress"
            : "Baseline only";
  return {
    branchPoints,
    branches: [...childCounts.values()].reduce(
      (sum, count) => sum + (count > 1 ? count : 0),
      0,
    ),
    depth,
    kind,
  };
}

export function ancestryOf(nodes: NodeRecord[], selected: string): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ancestry = new Set<string>();
  let current = byId.get(selected);
  while (current && !ancestry.has(current.id)) {
    ancestry.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return ancestry;
}

/** Give every leaf its own row and centre each parent over its immediate children. */
export function layoutLineage(nodes: NodeRecord[]): LineageLayout {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, NodeRecord[]>();
  const roots: NodeRecord[] = [];
  for (const node of nodes) {
    if (!node.parentId || !byId.has(node.parentId)) roots.push(node);
    else {
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node);
      children.set(node.parentId, siblings);
    }
  }
  const points = new Map<string, Point>();
  const visiting = new Set<string>();
  let row = 0;
  let maxDepth = 0;
  function visit(node: NodeRecord, depth: number): void {
    if (points.has(node.id) || visiting.has(node.id)) return;
    visiting.add(node.id);
    maxDepth = Math.max(maxDepth, depth);
    const siblings = children.get(node.id) ?? [];
    const accepted = siblings.filter((child) => child.status === "accepted");
    const other = siblings.filter((child) => child.status !== "accepted");
    const midpoint = Math.ceil(other.length / 2);
    for (const child of [
      ...other.slice(0, midpoint),
      ...accepted,
      ...other.slice(midpoint),
    ])
      visit(child, depth + 1);
    const childRows = siblings.flatMap((child) => {
      const point = points.get(child.id);
      return point ? [point.y] : [];
    });
    const y = childRows.length
      ? (Math.min(...childRows) + Math.max(...childRows)) / 2
      : row++ * 104;
    points.set(node.id, { x: 46 + depth * 420, y, depth });
    visiting.delete(node.id);
  }
  for (const root of roots) visit(root, 0);
  // The store rejects cycles; still display every record if an old store contains one.
  for (const node of nodes) if (!points.has(node.id)) visit(node, 0);
  const contentHeight = Math.max(0, row - 1) * 104;
  const height = Math.max(620, contentHeight + 240);
  const offset = Math.max(150, (height - contentHeight) / 2);
  for (const point of points.values()) point.y += offset;
  return { points, width: Math.max(760, 420 * maxDepth + 414), height };
}

export function scoreLabel(score: number | null): string {
  return score === null
    ? "—"
    : `${(score * 100).toFixed(1).replace(/\.0$/, "")}%`;
}
export function deltaLabel(delta: number): string {
  return `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1).replace(/\.0$/, "")}pp`;
}
export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function isChallenge(node: NodeRecord): boolean {
  return node.event === "challenge";
}

export function isImprovement(node: NodeRecord): boolean {
  return (
    !isChallenge(node) &&
    node.status === "accepted" &&
    (node.comparison?.delta ?? 0) > 0
  );
}

export function nodeLabel(node: NodeRecord): string {
  return isChallenge(node)
    ? `Level ${node.curriculum?.level ?? "?"} challenge`
    : node.status;
}

/** Every panel contains one identical set of tests. Never combine pass rates across levels. */
export function benchmarkGroups(nodes: NodeRecord[]) {
  const groups = new Map<
    string,
    {
      hash: string;
      id: string;
      level: number;
      totalTasks: number;
      nodes: NodeRecord[];
    }
  >();
  for (const node of nodes) {
    const hash = node.config.benchmarkHash;
    let group = groups.get(hash);
    if (!group) {
      group = {
        hash,
        id: node.config.benchmarkId,
        level: node.curriculum?.level ?? 0,
        totalTasks: node.totalTasks,
        nodes: [],
      };
      groups.set(hash, group);
    }
    group.nodes.push(node);
  }
  return [...groups.values()];
}
