"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  allowanceMicros,
  api,
  benchmarkManifestSchema,
  credentialSchema,
  ensureSession,
  harnessReadinessSchema,
  modelCatalogSchema,
  mutation,
  preferredCredential,
  type ModelCatalog,
} from "./contracts";
import { BudgetReview } from "./BudgetReview";

export function ExperimentForm() {
  const router = useRouter();
  const [credentialId, setCredentialId] = useState("");
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [modelId, setModelId] = useState("");
  const [provider, setProvider] = useState("tokenfactory");
  const [allowance, setAllowance] = useState("0.20");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshingPrices, setRefreshingPrices] = useState(false);
  const [error, setError] = useState("");
  const [runtime, setRuntime] = useState<z.infer<
    typeof harnessReadinessSchema
  > | null>(null);
  const [benchmark, setBenchmark] = useState<z.infer<
    typeof benchmarkManifestSchema
  > | null>(null);
  const idempotencyKey = useRef<string | null>(null);
  const submittedBody = useRef("");
  useEffect(() => {
    let active = true;
    setRefreshingPrices(true);
    setCredentialId("");
    setCatalog(null);
    setModelId("");
    setConsent(false);
    setError("");
    ensureSession()
      .then(async () => {
        const [harness, suite, credentials] = await Promise.all([
          api(
            `/api/hosted/harnesses?provider=${provider}`,
            harnessReadinessSchema,
          ),
          api("/api/hosted/benchmarks", benchmarkManifestSchema),
          api("/api/hosted/credentials", z.array(credentialSchema)),
        ]);
        if (active) {
          setRuntime(harness);
          setBenchmark(suite);
        }
        return credentials;
      })
      .then(async (credentials) => {
        const credential = preferredCredential(credentials);
        if (!credential)
          throw new Error(
            "Connect a valid Nebius key before starting an experiment.",
          );
        if (active) setCredentialId(credential.id);
        const models = await api(
          `/api/hosted/models?credentialId=${encodeURIComponent(credential.id)}`,
          modelCatalogSchema,
        );
        if (active) {
          setCatalog(models);
          setModelId(models.selectedModelId ?? "");
        }
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : "Setup could not be loaded.",
          );
      })
      .finally(() => {
        if (active) setRefreshingPrices(false);
      });
    return () => {
      active = false;
    };
  }, [provider]);
  const micros = allowanceMicros(allowance);
  const model = catalog?.models.find((item) => item.id === modelId);
  async function refreshPrices() {
    if (busy || refreshingPrices || !credentialId) return;
    setRefreshingPrices(true);
    setConsent(false);
    setCatalog(null);
    setModelId("");
    setError("");
    try {
      const models = await api(
        `/api/hosted/models?credentialId=${encodeURIComponent(credentialId)}&refresh=true`,
        modelCatalogSchema,
      );
      setCatalog(models);
      setModelId(models.selectedModelId ?? "");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Model prices could not be refreshed.",
      );
    } finally {
      setRefreshingPrices(false);
    }
  }
  async function start(event: React.FormEvent) {
    event.preventDefault();
    if (
      busy ||
      refreshingPrices ||
      !consent ||
      !model?.pricingSnapshotId ||
      !micros ||
      !runtime?.ready
    )
      return;
    setBusy(true);
    setError("");
    const body = {
      schemaVersion: 1,
      credentialId,
      modelId,
      harnessId:
        provider === "tokenfactory" ? "pi-1.4.0-tokenfactory" : "pi-1.4.0",
      benchmarkId: "coding-adversarial-v1",
      inferenceAllowanceUsdMicros: micros,
      acceptedPricingSnapshotId: model.pricingSnapshotId,
      consent: true,
    };
    const serialized = JSON.stringify(body);
    if (submittedBody.current !== serialized) {
      submittedBody.current = serialized;
      idempotencyKey.current = crypto.randomUUID();
    }
    try {
      const accepted = await api(
        "/api/hosted/campaigns",
        z.object({ campaignId: z.string() }),
        mutation(body, idempotencyKey.current ?? undefined),
      );
      router.push(`/experiments/${encodeURIComponent(accepted.campaignId)}`);
    } catch (cause) {
      setConsent(false);
      setError(
        cause instanceof Error
          ? cause.message
          : "The experiment could not be started.",
      );
      setBusy(false);
    }
  }
  return (
    <section className="hosted-panel">
      <p className="eyebrow">New private experiment</p>
      <h1>Evolve a Pi harness</h1>
      <p className="sub">
        Measure a real baseline, compare competing changes and preserve the
        evidence behind every branch.
      </p>
      <form onSubmit={start} className="hosted-form">
        <div className="composer-row">
          <label className="field">
            <span>Sandbox provider</span>
            <select
              value={provider}
              disabled={busy || refreshingPrices}
              onChange={(event) => {
                setProvider(event.target.value);
                setRuntime(null);
                setConsent(false);
                setError("");
              }}
            >
              <option value="tokenfactory">
                Nebius Token Factory Sandboxes
              </option>
              <option value="e2b">E2B</option>
            </select>
          </label>
          <label className="field">
            <span>NVIDIA Nemotron</span>
            <select
              value={modelId}
              onChange={(event) => {
                setModelId(event.target.value);
                setConsent(false);
              }}
              disabled={busy || refreshingPrices}
            >
              <option value="">No compatible model selected</option>
              {catalog?.models.map((item) => (
                <option
                  key={item.id}
                  value={item.id}
                  disabled={
                    !item.enabled ||
                    item.availability !== "available" ||
                    !item.pricingSnapshotId ||
                    item.id !== catalog.selectedModelId
                  }
                >
                  {item.name}
                  {item.id === catalog.selectedModelId
                    ? " · cheapest compatible"
                    : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Inference allowance · USD, maximum $0.50</span>
            <input
              inputMode="decimal"
              value={allowance}
              onChange={(event) => {
                setAllowance(event.target.value);
                setConsent(false);
              }}
              disabled={busy || refreshingPrices}
              required
            />
          </label>
        </div>
        <p className="muted">
          Coding · Pi 1.4.0 · coding-adversarial-v1.{" "}
          <Link href="/setup">Change connection →</Link>
        </p>
        {credentialId && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={refreshPrices}
            disabled={busy || refreshingPrices}
          >
            {refreshingPrices ? "Refreshing prices…" : "Refresh model prices"}
          </button>
        )}
        {catalog && (
          <BudgetReview
            catalog={catalog}
            modelId={modelId}
            allowance={micros}
            provider={provider}
          />
        )}
        {runtime && (
          <div className="hosted-review">
            <h2>Runtime readiness</h2>
            <p role="status">
              {runtime.ready
                ? `Verified Pi ${runtime.piVersion} · Node ${runtime.nodeVersion} · template ${runtime.templateId}`
                : runtime.reason}
            </p>
            {runtime.hash && (
              <p className="mono muted">Harness digest {runtime.hash}</p>
            )}
            {benchmark && (
              <p className="mono muted">
                Benchmark {benchmark.id} · {benchmark.taskCount} contracts ·{" "}
                {benchmark.hash}
              </p>
            )}
          </div>
        )}
        {model?.reason && <p className="muted">{model.reason}</p>}
        {!micros && (
          <p role="alert">Enter an allowance above $0 and at most $0.50.</p>
        )}
        <label className="hosted-check">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
            disabled={busy || refreshingPrices}
          />{" "}
          I approve this inference allowance and the displayed prices for this
          private experiment.
        </label>
        <button
          className="btn btn-primary"
          disabled={
            busy ||
            refreshingPrices ||
            !consent ||
            !micros ||
            !model?.pricingSnapshotId ||
            model.availability !== "available" ||
            !runtime?.ready
          }
        >
          {busy ? "Saving experiment…" : "Start experiment →"}
        </button>
        {error && (
          <p role="alert" className="error-output">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
