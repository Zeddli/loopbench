"use client";
import { useState, useEffect } from "react";
import { api } from "./contracts";
import { publishedSnapshotSchema } from "@/hosted/publication-schema";
import { HarnessView } from "./HarnessView";
import { LearningRecord } from "../LearningRecord";
import type { PublishedSnapshot } from "@/hosted/publication";
export function PublishedWorkspace({
  snapshot: original,
}: {
  snapshot: PublishedSnapshot;
}) {
  const [snapshot, setSnapshot] = useState(original);
  const [follow, setFollow] = useState(original.source === "hosted_published");
  const [connection, setConnection] = useState("");
  useEffect(() => {
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        if (follow && !document.hidden) {
          const next = await api(
            `/api/hosted/catalog?latestForSnapshot=${encodeURIComponent(original.id)}`,
            publishedSnapshotSchema,
          );
          if (active) {
            setSnapshot(next);
            setConnection("");
          }
        }
      } catch {
        if (active)
          setConnection(
            "Published updates disconnected. Showing the last verified snapshot.",
          );
      }
      if (active) timer = setTimeout(poll, 2000);
    }
    if (follow) void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [follow, original.id]);
  const [selected, setSelected] = useState(
    snapshot.tree.nodes.at(-1)?.id ?? "",
  );
  const node = snapshot.tree.nodes.find((entry) => entry.id === selected);
  return (
    <>
      <div className="tree-heading">
        <div>
          <p className="eyebrow">
            {snapshot.source === "local_archive"
              ? "Published local archive"
              : "Published hosted experiment"}
          </p>
          <h1>
            {snapshot.tree.harness}{" "}
            <span className="muted">on {snapshot.tree.model}</span>
          </h1>
          <p className="muted">
            {snapshot.tree.benchmarkId} · immutable snapshot · published{" "}
            {new Date(snapshot.publishedAt)
              .toISOString()
              .slice(0, 19)
              .replace("T", " ")}{" "}
            UTC
          </p>
          {original.source === "hosted_published" && (
            <label>
              <input
                type="checkbox"
                checked={follow}
                onChange={(event) => {
                  setFollow(event.target.checked);
                  if (!event.target.checked) setSnapshot(original);
                }}
              />{" "}
              Follow latest published updates
            </label>
          )}
          {snapshot.id !== original.id && (
            <p className="muted">
              Showing a newer published checkpoint.{" "}
              <button
                className="btn"
                onClick={() => {
                  setFollow(false);
                  setSnapshot(original);
                }}
              >
                View original snapshot
              </button>
            </p>
          )}
          {snapshot.tree.execution && (
            <p role="status">
              Campaign: {snapshot.tree.execution.status.replaceAll("_", " ")}
              {snapshot.tree.execution.waitReason
                ? ` · ${snapshot.tree.execution.waitReason.replaceAll("_", " ")}`
                : ""}{" "}
              · observed {snapshot.tree.execution.observedAt.replace("T", " ")}
            </p>
          )}
          {connection && <p role="status">{connection}</p>}
          {snapshot.tree.execution?.phase && (
            <p className="muted">
              {snapshot.tree.execution.phase === "parent"
                ? "Fresh parent evaluation"
                : snapshot.tree.execution.phase === "candidate"
                  ? "Candidate evaluation"
                  : snapshot.tree.execution.phase === "propose"
                    ? "Generating competing hypotheses"
                    : snapshot.tree.execution.phase}{" "}
              · round {snapshot.tree.execution.round ?? 0}
              {snapshot.tree.execution.phase !== "propose" &&
                ` · ${snapshot.tree.execution.tasksCompleted ?? 0}/${snapshot.tree.execution.taskTotal ?? snapshot.tree.totalTasks} tasks complete`}
              {!!snapshot.tree.execution.proposalCount &&
                ` · hypothesis ${(snapshot.tree.execution.proposalIndex ?? 0) + 1}/${snapshot.tree.execution.proposalCount}`}
            </p>
          )}
          <p className="muted">
            Historical runtime and model labels describe the original evidence.
            This snapshot does not authorize a hosted continuation.
          </p>
        </div>
      </div>
      {snapshot.tree.nodes.length ? (
        <>
          <HarnessView
            nodes={snapshot.tree.nodes}
            selected={selected}
            onSelect={setSelected}
            statusText={
              follow
                ? "Following published checkpoints"
                : "Immutable published snapshot"
            }
            recordHref="#task-results"
          />
          {node && (
            <LearningRecord
              tree={snapshot.tree}
              node={node}
              onSelect={setSelected}
            />
          )}
        </>
      ) : (
        <div className="empty-state">
          No executed harness versions in this snapshot.
        </div>
      )}
    </>
  );
}
