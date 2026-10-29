"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { z } from "zod";
import { api, campaignSchema, ensureSession, type Campaign } from "./contracts";
export function ExperimentCatalog() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [message, setMessage] = useState("Loading your private experiments…");
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        if (!document.hidden) {
          await ensureSession();
          const items = await api(
            "/api/hosted/campaigns",
            z.array(campaignSchema),
          );
          if (active) {
            setCampaigns(items);
            setMessage(
              items.length
                ? "Live · updates every 2s"
                : "No private experiments yet. Connect Nebius and review an allowance to begin.",
            );
          }
        }
      } catch (error) {
        if (active)
          setMessage(
            error instanceof Error
              ? error.message
              : "Private experiments are unavailable.",
          );
      }
      if (active) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);
  return (
    <>
      <div className="section-head">
        <h1>My experiments</h1>
        <Link className="btn btn-primary" href="/experiments/new">
          New experiment →
        </Link>
      </div>
      <p className="muted" role="status">
        {message}
      </p>
      <ul className="tree-cards">
        {campaigns.map((campaign) => (
          <li key={campaign.id}>
            <Link
              className="tree-card"
              href={`/experiments/${encodeURIComponent(campaign.id)}`}
            >
              <div className="card-top">
                <h2>{campaign.harnessId}</h2>
                <span className="tag">{campaign.status}</span>
              </div>
              <p>{campaign.modelId}</p>
              <p className="muted">
                {campaign.benchmarkId}
                {campaign.waitReason
                  ? ` · ${campaign.waitReason.replaceAll("_", " ")}`
                  : ""}
              </p>
            </Link>
          </li>
        ))}
      </ul>
      <Link href="/setup" className="text-link">
        Manage Nebius connection →
      </Link>
    </>
  );
}
