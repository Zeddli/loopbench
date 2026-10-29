"use client";
import { useState } from "react";
import { z } from "zod";
import { api, mutation, type Campaign } from "./contracts";
export function HostedCampaignControls({
  campaign,
  refresh,
}: {
  campaign: Campaign;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function control(action: "pause" | "resume" | "stop") {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await api(
        `/api/hosted/campaigns/${encodeURIComponent(campaign.id)}/control`,
        z.unknown(),
        mutation({
          schemaVersion: 1,
          action,
          expectedRevision: campaign.revision,
        }),
      );
      setMessage(
        `${action === "stop" ? "Stop" : action === "pause" ? "Pause" : "Resume"} requested. Cleanup and running operations may still be pending.`,
      );
      await refresh();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Control request failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  const terminal = ["stopped", "completed", "failed"].includes(campaign.status);
  return (
    <div>
      <div className="hosted-actions">
        <button
          className="btn btn-sm"
          disabled={
            busy || terminal || !["queued", "running"].includes(campaign.status)
          }
          onClick={() => control("pause")}
        >
          Pause
        </button>
        <button
          className="btn btn-sm"
          disabled={busy || !["paused", "waiting"].includes(campaign.status)}
          onClick={() => control("resume")}
        >
          Resume
        </button>
        <button
          className="btn btn-sm"
          disabled={busy || terminal || campaign.status === "stopping"}
          onClick={() => control("stop")}
        >
          Stop
        </button>
      </div>
      <p className="muted" role="status">
        {message ||
          "Resume never increases an allowance. Stop blocks new inference while cleanup is confirmed."}
      </p>
    </div>
  );
}
