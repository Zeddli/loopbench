import type { NodeRecord, TaskResult } from "@/core/types";
import { deltaLabel, scoreLabel, shortId } from "../lineage";

function TaskVerdicts({
  title,
  tasks,
  total,
}: {
  title: string;
  tasks: TaskResult[];
  total: number;
}) {
  return (
    <div>
      <h3>{title}</h3>
      <p className="muted">
        {tasks.length} of {total} task verdicts recorded ·{" "}
        {tasks.filter((task) => task.passed).length} passed
      </p>
      {tasks.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Task</th>
                <th>Verdict</th>
                <th>Duration</th>
                <th>Failure category</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.taskId}>
                  <td className="mono">{task.taskId}</td>
                  <td>{task.passed ? "Passed" : "Failed"}</td>
                  <td>{task.durationMs} ms</td>
                  <td>
                    {task.passed
                      ? "None"
                      : task.error
                        ? "Task failure"
                        : "Unspecified failure"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">
          No task verdicts have been recorded for this evaluation.
        </p>
      )}
    </div>
  );
}

export function PublishedTaskResults({
  node,
}: {
  node: NodeRecord | undefined;
}) {
  return (
    <section
      className="task-panel"
      id="task-results"
      aria-label="Published task results"
    >
      <div className="section-head">
        <h2>Selected task evidence</h2>
        {node && (
          <span className="tag">
            {shortId(node.id)} ·{" "}
            {node.score === null ? "Unscored" : scoreLabel(node.score)}
          </span>
        )}
      </div>
      {node ? (
        <>
          <TaskVerdicts
            title={
              node.parentId
                ? "Selected harness evaluation"
                : "Baseline evaluation"
            }
            tasks={node.tasks}
            total={node.totalTasks}
          />
          {node.comparison ? (
            <>
              <p>
                Paired comparison: {scoreLabel(node.comparison.parentScore)}{" "}
                fresh parent → {scoreLabel(node.comparison.candidateScore)}{" "}
                candidate · {deltaLabel(node.comparison.delta)}.
              </p>
              <TaskVerdicts
                title="Fresh parent evaluation"
                tasks={node.comparison.parentTasks}
                total={node.totalTasks}
              />
            </>
          ) : (
            <p className="muted">
              No completed paired comparison is recorded for this evaluation.
            </p>
          )}
          <p className="muted">
            Published verdicts exclude submitted source, hidden inputs, expected
            values and private diagnostics.
          </p>
        </>
      ) : (
        <p className="muted">
          No harness evaluation is selected. Task evidence appears when an
          evaluation is recorded.
        </p>
      )}
    </section>
  );
}
