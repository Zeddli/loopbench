"use client";
import { useState, useEffect } from "react";
import { api } from "./contracts";
import { publishedSnapshotSchema } from "@/hosted/publication-schema";
import { HarnessView } from "./HarnessView";
import { LearningRecord } from "../LearningRecord";
import { PublishedProgress } from "./PublishedProgress";
import { PublishedTaskResults } from "./PublishedTaskResults";
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
  const node =
    snapshot.tree.nodes.find((entry) => entry.id === selected) ??
    snapshot.tree.nodes.at(-1);
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
          {connection && <p role="status">{connection}</p>}
          <p className="muted">
            Historical runtime and model labels describe the original evidence.
            This snapshot does not authorize a hosted continuation.
          </p>
        </div>
      </div>
      {snapshot.tree.execution && (
        <PublishedProgress
          execution={snapshot.tree.execution}
          totalTasks={snapshot.tree.totalTasks}
          scoredVersions={
            snapshot.tree.nodes.filter((entry) => entry.score !== null).length
          }
          following={follow}
        />
      )}
      {snapshot.tree.nodes.length ? (
        <>
          <HarnessView
            nodes={snapshot.tree.nodes}
            selected={node?.id ?? ""}
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
      <PublishedTaskResults node={node} />
    </>
  );
}
