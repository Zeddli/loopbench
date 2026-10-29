"use client";
import { useState } from "react";
import { z } from "zod";
import {
  allowanceMicros,
  api,
  modelCatalogSchema,
  mutation,
  usd,
  type ModelCatalog,
  type Projection,
} from "./contracts";
export function InferenceAllowanceReview({
  projection,
  refresh,
}: {
  projection: Projection;
  refresh: () => Promise<void>;
}) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [amount, setAmount] = useState("0.20");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const model = catalog?.models.find(
    (entry) => entry.id === projection.campaign.modelId,
  );
  const budget = projection.budgets?.inference;
  const micros = allowanceMicros(amount);
  async function review() {
    setBusy(true);
    setMessage("");
    setConsent(false);
    setCatalog(null);
    try {
      const next = await api(
        `/api/hosted/models?campaignId=${encodeURIComponent(projection.campaign.id)}&refresh=true`,
        modelCatalogSchema,
      );
      setCatalog(next);
      setAmount(
        (Number(budget?.limitUsdMicros ?? "200000") / 1_000_000).toFixed(2),
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Prices could not be checked.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function approve() {
    if (busy || !consent || !micros || !model?.pricingSnapshotId) return;
    setBusy(true);
    try {
      await api(
        `/api/hosted/campaigns/${encodeURIComponent(projection.campaign.id)}/allowances`,
        z.unknown(),
        mutation({
          schemaVersion: 1,
          kind: "inference",
          expectedRevision: projection.campaign.revision,
          newLimitUsdMicros: micros,
          acceptedPricingSnapshotId: model.pricingSnapshotId,
        }),
      );
      setCatalog(null);
      setConsent(false);
      setMessage(
        "Inference allowance and prices accepted. Review the checkpoint, then resume separately.",
      );
      await refresh();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Approval could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <button className="btn btn-sm" onClick={review} disabled={busy}>
        Review inference allowance and prices
      </button>
      {catalog && (
        <section className="hosted-review hosted-form">
          <h3>Approve future Nebius charges</h3>
          <p className="mono">{projection.campaign.modelId}</p>
          <p>
            Current limit {usd(budget?.limitUsdMicros)} · spent estimate{" "}
            {usd(budget?.settledEstimateUsdMicros)} · held{" "}
            {usd(budget?.reservedUsdMicros)} ·{" "}
            {budget?.unknownReservationCount ?? 0} unknown obligations.
          </p>
          <p>
            Current uncached input / output per million tokens:{" "}
            {model?.pricing
              ? `$${Number(model.pricing.promptUsdPerToken) * 1_000_000} / $${Number(model.pricing.completionUsdPerToken) * 1_000_000}`
              : "Unavailable"}
            . Captured {new Date(catalog.checkedAt).toLocaleString()}.
          </p>
          <label className="field">
            <span>New total inference allowance · maximum $0.50</span>
            <input
              value={amount}
              inputMode="decimal"
              onChange={(event) => {
                setAmount(event.target.value);
                setConsent(false);
              }}
            />
          </label>
          <label className="hosted-check">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />{" "}
            I approve this total allowance and the displayed current prices.
            This does not resume work or add compute credit.
          </label>
          <button
            className="btn btn-primary"
            disabled={
              busy ||
              !consent ||
              !micros ||
              !model?.pricingSnapshotId ||
              model.availability !== "available" ||
              BigInt(micros ?? "0") < BigInt(budget?.limitUsdMicros ?? "0")
            }
            onClick={approve}
          >
            Approve inference allowance
          </button>
        </section>
      )}
      <p className="muted" role="status">
        {message}
      </p>
    </div>
  );
}
