import Link from "next/link";
import { listAdapters } from "@/core/store";
import { CopyCommand } from "@/components/CopyCommand";
import { isHostedMode } from "@/hosted/http";

export const dynamic = "force-dynamic";
export default async function Adapters() {
  const adapters = isHostedMode() ? [] : await listAdapters();
  return (
    <main className="container">
      <nav className="crumbs">
        <Link href="/">Trees</Link>
        <span>/</span>
        <span>Adapters</span>
      </nav>
      <div className="page-head">
        <div>
          <h1>Connect your agent harness</h1>
          <p className="sub">
            Adapters connect real harness execution to the evaluator. Register
            and run them from your terminal.
          </p>
        </div>
        <span className="tag">{adapters.length} registered</span>
      </div>
      <section className="section">
        <div className="section-head">
          <h2>Available adapters</h2>
          <span className="muted">Loaded from your local registry</span>
        </div>
        {adapters.length ? (
          <ul className="adapter-list">
            {adapters.map((adapter) => (
              <li className="adapter-card" key={adapter.id}>
                <div className="card-top">
                  <div>
                    <h3>{adapter.name}</h3>
                    <code className="muted">{adapter.id}</code>
                  </div>
                  <span className="tag">{adapter.protocol}</span>
                </div>
                <p>{adapter.description || "No description provided."}</p>
                <div className="adapter-meta">
                  <span>Timeout {adapter.timeoutMs / 1000}s</span>
                  <code>
                    {adapter.command} {adapter.args.join(" ")}
                  </code>
                </div>
                <details className="raw-record">
                  <summary>Manifest JSON</summary>
                  <pre>{JSON.stringify(adapter, null, 2)}</pre>
                </details>
                <a
                  className="text-link"
                  href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(adapter, null, 2))}`}
                  download={`${adapter.id}.json`}
                >
                  Download manifest ↓
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty-state">
            <h2>No adapters registered</h2>
            <p>Add an adapter manifest to connect a harness.</p>
          </div>
        )}
      </section>
      <section className="setup-panel">
        <h2>Register an adapter</h2>
        <p>
          Save a manifest for your harness, then register its path. The CLI
          validates the manifest and adds it to the local registry.
        </p>
        <CopyCommand command='npm run cli -- adapter add "path/to/adapter.json"' />
        <CopyCommand command="npm run cli -- adapters" />
        <p className="muted">
          See the adapter manifests in this repository for working examples. Set
          any required provider credentials in your terminal before running.
        </p>
      </section>
      <section className="setup-panel">
        <h2>The task protocol</h2>
        <p>
          LoopBench starts the configured command for a task and sends one JSON
          object to standard input. Your adapter writes a JSON response to
          standard output. Send diagnostic logs to standard error.
        </p>
        <div className="protocol-grid">
          <div>
            <h3>Input · loopbench.task.v1</h3>
            <pre>
              {JSON.stringify(
                {
                  protocol: "loopbench.task.v1",
                  task: { id: "task-id", prompt: "The benchmark task" },
                  config: {
                    model: "your-model",
                    harness: "your-harness",
                    settings: {},
                  },
                  instructions: "The harness instructions for this version",
                },
                null,
                2,
              )}
            </pre>
          </div>
          <div>
            <h3>Response</h3>
            <pre>
              {JSON.stringify(
                {
                  output: "The harness response",
                  inputTokens: 120,
                  outputTokens: 80,
                  costUsd: 0.001,
                },
                null,
                2,
              )}
            </pre>
            <p className="muted">
              Only output is required. The evaluator, rather than the adapter,
              determines whether a task passed. Token counts and cost are
              optional reported values.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
