"use client";
import { useState, useEffect } from "react";
import { z } from "zod";
import Link from "next/link";
import { MiniLineage } from "../LineageGraph";
import type { PublishedSnapshot } from "@/hosted/publication";
import { publishedSnapshotSchema } from "@/hosted/publication-schema";
import { api } from "./contracts";
export function PublishedArchive({
  snapshots,
}: {
  snapshots: PublishedSnapshot[];
}) {
  const [records, setRecords] = useState(snapshots);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        if (!document.hidden) {
          const next = await api(
            "/api/hosted/catalog?scope=published",
            z.array(publishedSnapshotSchema),
          );
          if (active) setRecords(next);
        }
      } catch {
        /* Keep the last explicitly published evidence during a reconnect. */
      }
      if (active) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);
  const [domain, setDomain] = useState(""),
    [model, setModel] = useState(""),
    [harness, setHarness] = useState("");
  const options = (key: "domain" | "model" | "harness") =>
    [...new Set(records.map((snapshot) => snapshot.tree[key]))].sort();
  const visible = records.filter(
    (snapshot) =>
      (!domain || snapshot.tree.domain === domain) &&
      (!model || snapshot.tree.model === model) &&
      (!harness || snapshot.tree.harness === harness),
  );
  return (
    <>
      <section className="home-hero">
        <h1>
          Evolve a harness.
          <br />
          Keep the evidence.
        </h1>
        <p className="sub">
          Run private Pi and Nemotron experiments, compare real sibling
          branches, and inspect independently measured outcomes.
        </p>
        <div className="hosted-actions">
          <Link className="btn btn-primary" href="/experiments/new">
            New experiment →
          </Link>
          <Link className="btn" href="/experiments">
            My experiments
          </Link>
        </div>
      </section>
      <section className="section">
        <div className="section-head">
          <h2>Published experiments</h2>
          <span className="muted">Explicitly reviewed evidence</span>
        </div>
        <div
          className="composer-row"
          role="group"
          aria-label="Filter published trees"
        >
          <label className="field">
            <span>Domain</span>
            <select
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
            >
              <option value="">All domains</option>
              {options("domain").map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Model</span>
            <select
              value={model}
              onChange={(event) => setModel(event.target.value)}
            >
              <option value="">All models</option>
              {options("model").map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Harness</span>
            <select
              value={harness}
              onChange={(event) => setHarness(event.target.value)}
            >
              <option value="">All harnesses</option>
              {options("harness").map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        </div>
        {records.length ? (
          <ul className="tree-cards">
            {visible.map((snapshot) => (
              <li key={snapshot.id}>
                <Link className="tree-card" href={`/tree/${snapshot.id}`}>
                  <div className="card-top">
                    <h3>{snapshot.tree.harness}</h3>
                    <span className="tag">
                      {snapshot.source === "local_archive"
                        ? "Published local archive"
                        : "Published hosted experiment"}
                    </span>
                  </div>
                  <p>{snapshot.tree.model}</p>
                  <div className="card-mini">
                    <MiniLineage nodes={snapshot.tree.nodes} />
                  </div>
                  <p className="muted">
                    {snapshot.tree.benchmarkId} · {snapshot.tree.nodes.length}{" "}
                    recorded evaluations
                  </p>
                  <p className="muted">
                    Published{" "}
                    {new Date(snapshot.publishedAt).toISOString().slice(0,10)} UTC
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty-state">
            <h2>No published experiments yet</h2>
            <p>
              A real baseline records an executed harness, independently
              verified task results and its runtime identity. Private
              experiments appear only in your own workspace.
            </p>
            <Link className="text-link" href="/setup">
              Connect Nebius →
            </Link>
          </div>
        )}
        {records.length > 0 && visible.length === 0 && (
          <p className="muted">No published trees match these filters.</p>
        )}
      </section>
    </>
  );
}
