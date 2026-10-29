import type { NodeRecord, TreeSummary } from "@/core/types";
import { LearningRecord } from "../LearningRecord";
import { scoreLabel } from "../lineage";
import type { Projection } from "./contracts";
export function AttemptEvidence({
  projection,
  selected,
  onSelect,
}: {
  projection: Projection;
  selected: NodeRecord | undefined;
  onSelect: (id: string) => void;
}) {
  const tree: TreeSummary | undefined = selected
    ? {
        id: selected.treeId,
        domain: selected.config.domain,
        model: selected.config.model,
        harness: selected.config.harness,
        benchmarkId: selected.config.benchmarkId,
        benchmarkHash: selected.config.benchmarkHash,
        totalTasks: selected.totalTasks,
        nodes: projection.nodes,
        updatedAt: selected.completedAt ?? selected.createdAt,
      }
    : undefined;
  return (
    <section className="record" id="evidence">
      {selected && tree && (
        <>
          <div className="section-head">
            <h2>Selected harness evidence</h2>
            <span className="tag">
              {selected.status} · {scoreLabel(selected.score)}
            </span>
          </div>
          <LearningRecord node={selected} tree={tree} onSelect={onSelect} />
          <details>
            <summary>
              Task verdicts · {selected.tasks.length}/{selected.totalTasks}
            </summary>
            <ul className="hosted-events">
              {selected.tasks.map((task) => (
                <li key={task.taskId}>
                  <span className="mono">{task.taskId}</span>
                  <span>
                    {task.passed ? "Passed" : "Failed"} · {task.durationMs} ms
                  </span>
                  {task.error && <pre>{task.error}</pre>}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
      <h2>Attempts and artifacts</h2>
      <p className="muted">
        Task environments and retries are evidence for a harness version. They
        do not create additional graph nodes.
      </p>
      {projection.taskAttempts.length ? (
        <ul className="hosted-events">
          {projection.taskAttempts.map((attempt) => (
            <li key={attempt.id}>
              <span className="mono">{attempt.taskId}</span>
              <span>
                {attempt.status}
                {attempt.outcome ? ` · ${attempt.outcome}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No task attempts recorded yet.</p>
      )}
      {projection.artifacts.map((artifact) => (
        <p key={artifact.id}>
          {artifact.kind} · {artifact.state}
          {artifact.state === "ready" && (
            <a
              className="text-link"
              href={`/api/hosted/artifacts/${encodeURIComponent(artifact.id)}`}
            >
              {" "}
              Download inert artifact
            </a>
          )}
        </p>
      ))}
    </section>
  );
}
