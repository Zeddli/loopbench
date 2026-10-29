"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { z } from "zod";
import { api, harnessReadinessSchema } from "./contracts";

type ReadinessState =
  | { status: "loading" }
  | { status: "loaded"; readiness: z.infer<typeof harnessReadinessSchema> }
  | { status: "error"; message: string };
type Provider = "tokenfactory" | "e2b";
const providers: { id: Provider; name: string }[] = [
  { id: "tokenfactory", name: "Nebius Token Factory Sandboxes" },
  { id: "e2b", name: "E2B" },
];

export function HarnessReadinessCard({
  name,
  state,
}: {
  name: string;
  state: ReadinessState;
}) {
  return (
    <li className="adapter-card">
      <div className="card-top">
        <h3>{name}</h3>
        <span className="tag">Pi harness</span>
      </div>
      <p role="status">
        {state.status === "loading"
          ? "Checking runtime…"
          : state.status === "error"
            ? "Readiness could not be checked"
            : state.readiness.ready
              ? "Runtime ready"
              : "Runtime unavailable"}
      </p>
      {state.status === "error" && <p>{state.message}</p>}
      {state.status === "loaded" && (
        <>
          <p>
            {state.readiness.ready
              ? "The approved Pi runtime is configured. Review your model connection and inference allowance before starting."
              : (state.readiness.reason ??
                "The operator must prepare the approved Pi runtime before execution is available.")}
          </p>
          <p className="muted">
            Pi {state.readiness.piVersion}
            {state.readiness.nodeVersion
              ? ` · Node ${state.readiness.nodeVersion}`
              : ""}
          </p>
        </>
      )}
    </li>
  );
}

export function HostedHarnessCatalog() {
  const [checks, setChecks] = useState<Record<Provider, ReadinessState>>({
    tokenfactory: { status: "loading" },
    e2b: { status: "loading" },
  });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setChecks({
      tokenfactory: { status: "loading" },
      e2b: { status: "loading" },
    });
    void Promise.all(
      providers.map(async (provider) => {
        try {
          const readiness = await api(
            `/api/hosted/harnesses?provider=${provider.id}`,
            harnessReadinessSchema,
          );
          if (active)
            setChecks((previous) => ({
              ...previous,
              [provider.id]: { status: "loaded", readiness },
            }));
        } catch (error) {
          if (active)
            setChecks((previous) => ({
              ...previous,
              [provider.id]: {
                status: "error",
                message:
                  error instanceof Error
                    ? error.message
                    : "Runtime readiness is unavailable. Try checking again.",
              },
            }));
        }
      }),
    );
    return () => {
      active = false;
    };
  }, [revision]);
  const checking = Object.values(checks).some(
    (check) => check.status === "loading",
  );
  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/">Trees</Link>
        <span>/</span>
        <span>Harnesses</span>
      </nav>
      <div className="page-head">
        <div>
          <h1>Cloud harnesses</h1>
          <p className="sub">
            Hosted experiments run approved Pi harnesses. Check the configured
            runtime for each sandbox provider before starting.
          </p>
        </div>
        <Link className="btn btn-primary" href="/experiments/new">
          New experiment →
        </Link>
      </div>
      <section className="section">
        <div className="section-head">
          <h2>Runtime readiness</h2>
          <button
            className="btn btn-sm"
            onClick={() => setRevision((previous) => previous + 1)}
            disabled={checking}
          >
            {checking ? "Checking…" : "Check again"}
          </button>
        </div>
        <ul className="adapter-list">
          {providers.map((provider) => (
            <HarnessReadinessCard
              key={provider.id}
              name={provider.name}
              state={checks[provider.id]}
            />
          ))}
        </ul>
      </section>
      <section className="setup-panel">
        <h2>Custom CLI adapters</h2>
        <p>
          Register and run custom adapters in your local LoopBench checkout. The
          hosted server runs its approved Pi harnesses and does not register
          custom adapter manifests.
        </p>
        <Link className="text-link" href="/setup">
          Manage your Nebius connection →
        </Link>
      </section>
    </>
  );
}
