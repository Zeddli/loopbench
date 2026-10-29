"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { HarnessView } from "./HarnessView";
import { benchmarkGroups, lineageSummary } from "../lineage";
import {
  api,
  preserveSelection,
  projectionSchema,
  usd,
  type Projection,
} from "./contracts";
import { HostedCampaignControls } from "./HostedCampaignControls";
import { AttemptEvidence } from "./AttemptEvidence";
import { InferenceAllowanceReview } from "./InferenceAllowanceReview";

const eventsSchema = z.object({
  nextCursor: z.string(),
  resetRequired: z.boolean(),
  items: z.array(z.unknown()),
});
export function ExperimentWorkspace({ id }: { id: string }) {
  const [projection, setProjection] = useState<Projection | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState("");
  const cursor = useRef<string | null>(null);
  const activeRequest = useRef<Promise<void> | null>(null);
  const endpoint = `/api/hosted/campaigns/${encodeURIComponent(id)}`;
  const refresh = useCallback(async () => {
    if (activeRequest.current) return activeRequest.current;
    const request = (async () => {
      const next = await api(endpoint, projectionSchema);
      cursor.current = next.eventCursor ?? null;
      setProjection(next);
      setSelectedId((previous) =>
        preserveSelection(
          previous,
          next.nodes.map((node) => node.id),
        ),
      );
      setError("");
    })();
    activeRequest.current = request;
    try {
      await request;
    } finally {
      activeRequest.current = null;
    }
  }, [endpoint]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      if (!alive) return;
      if (!document.hidden) {
        try {
          if (!cursor.current) await refresh();
          else {
            const page = await api(
              `${endpoint}/events?after=${encodeURIComponent(cursor.current)}`,
              eventsSchema,
            );
            if (page.resetRequired || page.items.length) await refresh();
            else cursor.current = page.nextCursor;
          }
        } catch (cause) {
          if (alive)
            setError(
              cause instanceof Error
                ? cause.message
                : "Live updates are unavailable.",
            );
        }
      }
      if (alive) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [endpoint, refresh]);
  if (!projection)
    return (
      <div className="empty-state">
        <h1>{error ? "Experiment not available" : "Loading experiment…"}</h1>
        <p role="status">{error || "Reading your private saved records."}</p>
        <Link className="text-link" href="/experiments">
          My experiments →
        </Link>
      </div>
    );
  const { campaign, nodes } = projection;
  const selected = nodes.find((node) => node.id === selectedId);
  const summary = lineageSummary(nodes);
  const groups = benchmarkGroups(nodes);
  return (
    <>
      <div className="tree-heading">
        <div>
          <p className="eyebrow">Private continuous experiment</p>
          <h1>
            {campaign.harnessId}{" "}
            <span className="muted">on {campaign.modelId}</span>
          </h1>
          <p className="muted">
            {campaign.benchmarkId} · {summary.depth} generations ·{" "}
            {summary.branches} competing branches · {groups.length} benchmark
            groups
          </p>
        </div>
        <span className="tag tag-accent">{campaign.status}</span>
      </div>
      <HostedCampaignControls campaign={campaign} refresh={refresh} />
      {campaign.harnessId === "pi-1.4.0-tokenfactory" && (
        <p className="muted">
          Execution: Nebius Token Factory Sandboxes. Guest networking is
          disabled; inference uses the metered host relay. Sandbox operation
          usage is retained, and its dollar cost is unavailable.
        </p>
      )}
      <details className="campaign-progress">
        <summary>Run status, allowances and saved hypotheses</summary>
        <div className="section-head">
          <h2>Experiment progress</h2>
          <span className="live-note">
            {error || "Live · updates every 2s"}
          </span>
        </div>
        {campaign.waitReason && (
          <p role="status">
            Waiting · {campaign.waitReason.replaceAll("_", " ")}. Your saved
            branches and checkpoint are retained.
          </p>
        )}
        {campaign.status === "stopping" && (
          <p>
            Stop requested. Environment cleanup remains pending until confirmed.
          </p>
        )}
        {projection.budgets && (
          <dl className="card-stats">
            {(
              ["inference", "compute"] satisfies Array<"inference" | "compute">
            ).map((kind) => {
              const budget = projection.budgets?.[kind];
              return (
                budget && (
                  <div key={kind}>
                    <dt>
                      {kind === "inference"
                        ? "Your Nebius inference"
                        : "Supplied E2B compute"}
                    </dt>
                    <dd>
                      {usd(budget.settledEstimateUsdMicros)} /{" "}
                      {usd(budget.limitUsdMicros)}
                    </dd>
                    <p className="muted">
                      Held {usd(budget.reservedUsdMicros)} ·{" "}
                      {budget.unknownReservationCount ?? 0} unknown obligations
                      ·{" "}
                      {budget.estimateStatus?.replaceAll("_", " ") ??
                        "estimate"}
                    </p>
                  </div>
                )
              );
            })}
          </dl>
        )}
        {["paused", "waiting"].includes(campaign.status) && (
          <InferenceAllowanceReview projection={projection} refresh={refresh} />
        )}
        {projection.proposals.filter((proposal) => !proposal.nodeId).length >
          0 && (
          <>
            <h3>Saved hypotheses awaiting execution</h3>
            <ul>
              {projection.proposals
                .filter((proposal) => !proposal.nodeId)
                .map((proposal, index) => (
                  <li key={`${proposal.round}-${index}`}>
                    Round {proposal.round} · {proposal.hypothesis}
                  </li>
                ))}
            </ul>
          </>
        )}
      </details>
      {nodes.length ? (
        <>
          <HarnessView
            nodes={nodes}
            selected={selectedId}
            onSelect={setSelectedId}
            statusText={error || "Live · updates every 2s"}
            headId={
              nodes
                .filter(
                  (node) =>
                    node.status === "accepted" || node.status === "baseline",
                )
                .at(-1)?.id
            }
          />
          <AttemptEvidence
            projection={projection}
            selected={selected}
            onSelect={setSelectedId}
          />
        </>
      ) : (
        <div className="empty-state">
          <h2>
            {campaign.status === "queued"
              ? "Queued for a real baseline"
              : "No executed harness versions yet"}
          </h2>
          <p>
            A node appears when a harness evaluation is recorded. Saved
            proposals and task environments are not graph nodes.
          </p>
        </div>
      )}
    </>
  );
}
