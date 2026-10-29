"use client";
import type { NodeRecord, TreeSummary } from "@/core/types";
import { deltaLabel, isChallenge, scoreLabel, shortId } from "./lineage";

export function LearningRecord({
  node,
  tree,
  onSelect,
}: {
  node: NodeRecord;
  tree: TreeSummary;
  onSelect: (id: string) => void;
}) {
  const learning = node.learning;
  const sources = (learning?.learnedFrom ?? []).flatMap((id) => {
    const source = tree.nodes.find((item) => item.id === id);
    return source ? [source] : [];
  });
  const missingSources = (learning?.learnedFrom ?? []).filter(
    (id) => !sources.some((source) => source.id === id),
  );
  const evidence = learning ? sources : [node];
  const failures = evidence.flatMap((source) =>
    source.tasks
      .filter((task) => !task.passed)
      .map((task) => ({ source, task })),
  );
  const outcome = isChallenge(node)
    ? `Level ${node.curriculum?.level ?? "?"} challenge baseline: the unchanged harness was re-evaluated at ${scoreLabel(node.score)} on ${node.totalTasks} tests. This is not a learned upgrade or a score delta against the previous level.`
    : node.status === "running"
      ? `Evaluation in progress: ${node.tasks.length}/${node.totalTasks} tasks completed.`
      : node.status === "failed"
        ? `Execution failed: ${node.error ?? "No error detail recorded."}`
        : node.comparison
          ? `${scoreLabel(node.comparison.parentScore)} parent → ${scoreLabel(node.comparison.candidateScore)} candidate (${deltaLabel(node.comparison.delta)}). ${node.comparison.reason}`
          : `Baseline measured at ${scoreLabel(node.score)}. ${node.tasks.filter((task) => task.passed).length}/${node.totalTasks} tasks passed.`;
  return (
    <section
      className="learning-record"
      aria-label="Mistake, lesson, harness change and outcome"
    >
      <div className="section-head">
        <h2>
          {learning
            ? "What this branch learned"
            : "Evidence for the next experiment"}
        </h2>
        {learning && <span className="tag">Round {learning.round}</span>}
      </div>
      <ol className="learning-steps">
        <li>
          <h3>
            <span>01</span> Mistake
          </h3>
          <div className="learning-body">
            {sources.length > 0 && (
              <div className="learning-sources">
                <span>Learned from</span>
                {sources.map((source) => (
                  <button
                    className="source-node"
                    key={source.id}
                    onClick={() => onSelect(source.id)}
                  >
                    {shortId(source.id)} · {source.status}
                  </button>
                ))}
              </div>
            )}
            {missingSources.length > 0 && (
              <p className="muted">
                Cited records unavailable:{" "}
                {missingSources.map(shortId).join(", ")}
              </p>
            )}
            {failures.length ? (
              <ul className="learning-errors">
                {failures.map(({ source, task }) => (
                  <li key={`${source.id}-${task.taskId}`}>
                    <details>
                      <summary>
                        <span className="task-state">FAIL</span> {task.taskId}{" "}
                        <span className="muted">· {shortId(source.id)}</span>
                      </summary>
                      <pre>
                        {task.error ??
                          "Task did not pass; no error detail was recorded."}
                      </pre>
                    </details>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">
                {learning
                  ? "No failed task was recorded in the cited versions. Read the proposer diagnosis below as its hypothesis."
                  : node.status === "running"
                    ? "Task evidence appears as the run finishes."
                    : "No task failures recorded in this version."}
              </p>
            )}
            {evidence
              .filter((source) => source.error)
              .map((source) => (
                <details className="learning-run-error" key={source.id}>
                  <summary>Run error · {shortId(source.id)}</summary>
                  <pre>{source.error}</pre>
                </details>
              ))}
          </div>
        </li>
        <li>
          <h3>
            <span>02</span> Lesson
          </h3>
          <div className="learning-body">
            <p>
              {learning?.diagnosis ??
                "No proposer diagnosis was recorded for this version. Start branching evolution to turn the observed evidence into testable changes."}
            </p>
            {learning && (
              <p className="learning-attribution">
                Proposer diagnosis · {learning.proposer}
              </p>
            )}
          </div>
        </li>
        <li>
          <h3>
            <span>03</span> Harness change
          </h3>
          <div className="learning-body">
            <p>
              {learning?.change ??
                (node.parentId
                  ? "Manual experiment; no structured change explanation was recorded."
                  : "Starting configuration for this benchmark.")}
            </p>
            {learning?.prediction && (
              <p className="learning-prediction">
                <b>Prediction:</b> {learning.prediction}
              </p>
            )}
            <details className="learning-instructions">
              <summary>Exact candidate instructions</summary>
              <pre>
                {node.config.settings.instructions ||
                  "No additional instructions configured."}
              </pre>
            </details>
          </div>
        </li>
        <li>
          <h3>
            <span>04</span> Outcome
          </h3>
          <div className="learning-body">
            <p className={`learning-outcome status-${node.status}`}>
              {outcome}
            </p>
            <a className="text-link" href="#task-results">
              Inspect task-level evidence ↓
            </a>
          </div>
        </li>
      </ol>
    </section>
  );
}
