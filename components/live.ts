"use client";
import { useEffect, useState } from "react";
import { z } from "zod";
import {
  campaignSchema,
  nodeRecordSchema,
  type EvolutionCampaign,
  type TreeSummary,
} from "@/core/types";

export const treeSummarySchema = z.object({
  id: z.string(),
  domain: z.string(),
  model: z.string(),
  harness: z.string(),
  benchmarkId: z.string(),
  benchmarkHash: z.string(),
  totalTasks: z.number(),
  nodes: z.array(nodeRecordSchema),
  updatedAt: z.string(),
});

export function useLiveRecords<T>({
  initial,
  url,
  parse,
}: {
  initial: T;
  url: string;
  parse: (input: unknown) => T;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    let active = false;
    const controller = new AbortController();
    const poll = async () => {
      if (stopped || active || document.visibilityState === "hidden") return;
      active = true;
      try {
        const response = await fetch(url, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Read failed (${response.status})`);
        const payload: unknown = await response.json();
        const next = parse(payload);
        if (!stopped) {
          setValue(next);
          setError(null);
        }
      } catch (cause) {
        if (
          !stopped &&
          !(cause instanceof DOMException && cause.name === "AbortError")
        )
          setError("Live updates paused. Retrying…");
      } finally {
        active = false;
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void poll();
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 2000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [url, parse]);
  return { value, error };
}

export const parseTree = (input: unknown): TreeSummary =>
  treeSummarySchema.parse(input);
export const parseTrees = (input: unknown): TreeSummary[] =>
  z.array(treeSummarySchema).parse(input);
export const parseCampaigns = (input: unknown): EvolutionCampaign[] =>
  z.array(campaignSchema).parse(input);

export function campaignForTree(
  tree: TreeSummary,
  campaigns: EvolutionCampaign[],
) {
  const ids = new Set(tree.nodes.map((node) => node.id));
  return campaigns
    .filter(
      (campaign) =>
        campaign.lineageId === tree.id ||
        (campaign.rootId !== null && ids.has(campaign.rootId)) ||
        campaign.candidateIds.some((id) => ids.has(id)),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

export function campaignLabel(campaign: EvolutionCampaign): string {
  if (
    campaign.status === "waiting_budget" ||
    campaign.status === "budget_exhausted"
  )
    return "Waiting for call budget";
  if (campaign.status === "waiting_challenge") return "Advancing challenge";
  if (campaign.status === "paused") return "Paused";
  if (campaign.status === "stopped") return "Stopped";
  if (campaign.status === "running") return "Learning";
  return campaign.status.replaceAll("_", " ");
}

export function campaignPriority(
  campaign: EvolutionCampaign | undefined,
): number {
  if (!campaign) return 0;
  return (
    (campaign.status === "running"
      ? 100
      : ["waiting_budget", "waiting_challenge", "paused"].includes(
            campaign.status,
          )
        ? 60
        : 10) + (campaign.options.continuous ? 20 : 0)
  );
}
