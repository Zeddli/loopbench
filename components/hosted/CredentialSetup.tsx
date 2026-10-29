"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { z } from "zod";
import {
  api,
  credentialSchema,
  ensureSession,
  modelCatalogSchema,
  mutation,
  type ModelCatalog,
} from "./contracts";

export function CredentialSetup() {
  const [key, setKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState(
    "Connecting your private demo session…",
  );
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [credentials, setCredentials] = useState<
    z.infer<typeof credentialSchema>[]
  >([]);
  useEffect(() => {
    let active = true;
    ensureSession()
      .then(() => api("/api/hosted/credentials", z.array(credentialSchema)))
      .then((items) => {
        if (active) {
          setCredentials(items);
          setReady(true);
          setMessage("Your key stays encrypted on the server.");
        }
      })
      .catch((error: unknown) => {
        if (active)
          setMessage(
            error instanceof Error
              ? error.message
              : "Hosted setup is unavailable.",
          );
      });
    return () => {
      active = false;
    };
  }, []);
  async function connect(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage("Checking connection and model availability…");
    try {
      const credential = await api(
        "/api/hosted/credentials",
        credentialSchema,
        mutation({
          schemaVersion: 1,
          provider: "nebius-token-factory",
          label: "Nebius",
          apiKey: key,
        }),
      );
      setKey("");
      setCredentials((items) => [
        credential,
        ...items.filter((item) => item.id !== credential.id),
      ]);
      const models = await api(
        `/api/hosted/models?credentialId=${encodeURIComponent(credential.id)}`,
        modelCatalogSchema,
      );
      setCatalog(models);
      setCredentials(
        await api("/api/hosted/credentials", z.array(credentialSchema)),
      );
      setMessage("Authentication checked. Inference credit is not verified.");
    } catch (error) {
      setKey("");
      setMessage(
        error instanceof Error
          ? error.message
          : "Connection could not be checked.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function revoke(credential: z.infer<typeof credentialSchema>) {
    if (busy) return;
    setBusy(true);
    try {
      const current = (
        await api("/api/hosted/credentials", z.array(credentialSchema))
      ).find((item) => item.id === credential.id);
      if (!current) throw new Error("This credential is no longer available.");
      await api("/api/hosted/credentials", z.unknown(), {
        ...mutation({
          schemaVersion: 1,
          credentialId: credential.id,
          expectedRevision: current.revision ?? 1,
        }),
        method: "DELETE",
      });
      setCredentials((items) =>
        items.filter((item) => item.id !== credential.id),
      );
      setCatalog(null);
      setMessage("Credential revoked. New inference requests are blocked.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Revocation failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="hosted-panel">
      <p className="eyebrow">Private connection</p>
      <h1>Connect Nebius</h1>
      <p className="sub">
        LoopBench supplies limited E2B compute. Your Nebius account pays for
        model inference, within the allowance you review for each experiment.
      </p>
      <form onSubmit={connect} className="hosted-form">
        <label className="field">
          <span>Nebius API key</span>
          <input
            autoComplete="off"
            spellCheck={false}
            type={reveal ? "text" : "password"}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            required
            maxLength={4096}
          />
        </label>
        <label className="hosted-check">
          <input
            type="checkbox"
            checked={reveal}
            onChange={(event) => setReveal(event.target.checked)}
          />{" "}
          Show key
        </label>
        <button
          className="btn btn-primary"
          disabled={!ready || busy || !key.trim()}
        >
          {busy ? "Checking…" : "Connect Nebius key"}
        </button>
      </form>
      <p role="status" className="hosted-status">
        {message}
      </p>
      {credentials.map((credential) => (
        <div className="hosted-credential" key={credential.id}>
          <span>
            {credential.displayHint ??
              credential.maskedLabel ??
              credential.label ??
              "Nebius credential"}{" "}
            · {credential.status}
          </span>
          <button
            className="btn btn-sm"
            disabled={busy || credential.status === "revoked"}
            onClick={() => revoke(credential)}
          >
            Revoke
          </button>
        </div>
      ))}
      {catalog && (
        <div>
          <h2>Current model availability</h2>
          <p className="muted">
            Checked {new Date(catalog.checkedAt).toLocaleString()}.{" "}
            {
              catalog.models.filter(
                (model) => model.availability === "available",
              ).length
            }{" "}
            compatible models available.
          </p>
          {catalog.warnings.map((warning) => (
            <p key={warning} className="muted">
              {warning}
            </p>
          ))}
        </div>
      )}
      <div className="hosted-actions">
        <Link className="btn" href="/">
          Browse published trees
        </Link>
        <Link className="btn btn-primary" href="/experiments/new">
          New experiment →
        </Link>
      </div>
      <p className="muted">
        This demo uses an expiring browser session. Losing its cookie can remove
        access to private experiments. Browser closure does not stop an
        experiment.
      </p>
    </section>
  );
}
