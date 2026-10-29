import type { PublishedSnapshot } from "@/hosted/publication";

export function PublishedProgress({
  execution,
  totalTasks,
  scoredVersions,
  following,
}: {
  execution: NonNullable<PublishedSnapshot["tree"]["execution"]>;
  totalTasks: number;
  scoredVersions: number;
  following: boolean;
}) {
  const taskTotal = execution.taskTotal ?? totalTasks;
  const completed = execution.tasksCompleted ?? 0;
  const siblingCount = execution.proposalCount ?? 0;
  const sibling = Math.min((execution.proposalIndex ?? 0) + 1, siblingCount);
  const paired =
    execution.phase === "parent" || execution.phase === "candidate";
  const siblingLabel = siblingCount
    ? `${sibling} of ${siblingCount}`
    : "pending";
  const evaluating = ["baseline", "parent", "candidate", "challenge"].includes(
    execution.phase ?? "",
  );
  const title =
    execution.phase === "parent"
      ? `Verifying the parent before sibling ${siblingLabel}`
      : execution.phase === "candidate"
        ? `Evaluating sibling ${siblingLabel}`
        : execution.phase === "propose"
          ? "Preparing the next competing changes"
          : execution.phase === "baseline"
            ? "Measuring the baseline"
            : execution.phase === "challenge"
              ? "Measuring the next benchmark level"
              : execution.phase === "probe"
                ? "Checking model compatibility"
                : "Saved experiment activity";
  return (
    <section
      className={`campaign-progress campaign-${execution.status}`}
      aria-label="Experiment activity"
    >
      <div className="campaign-title">
        <div>
          <span className="eyebrow">Current activity</span>
          <h2>{title}</h2>
        </div>
        <span className="tag tag-accent">
          {execution.status.charAt(0).toUpperCase() + execution.status.slice(1)}
        </span>
      </div>
      {execution.waitReason && (
        <p role="status">
          Waiting for {execution.waitReason.replaceAll("_", " ")}. The
          checkpoint is saved.
        </p>
      )}
      <dl className="campaign-facts">
        <div>
          <dt>Round</dt>
          <dd>{execution.round ?? 0}</dd>
        </div>
        <div>
          <dt>Benchmark level</dt>
          <dd>{execution.level ?? "Not recorded"}</dd>
        </div>
        <div>
          <dt>{paired ? "Current sibling" : "Saved hypotheses"}</dt>
          <dd>{paired ? siblingLabel : siblingCount}</dd>
        </div>
        <div>
          <dt>Scored evaluations</dt>
          <dd>{scoredVersions}</dd>
        </div>
      </dl>
      {evaluating && (
        <div role="status">
          <p>
            {completed} of {taskTotal} tasks verified
          </p>
          <progress
            aria-label="Verified tasks in the current evaluation"
            value={completed}
            max={taskTotal}
            style={{ width: "100%", accentColor: "var(--pass)" }}
          />
        </div>
      )}
      <p className="campaign-selection">
        {execution.phase === "parent"
          ? "The saved baseline stays unchanged while the parent is measured again on the same tasks. The sibling evaluation follows this check."
          : execution.phase === "candidate"
            ? "The branch score is recorded after its task evaluations finish. Parent and candidate use the same benchmark."
            : execution.phase === "propose"
              ? "New hypotheses are generated from measured outcomes. Each sibling receives a fresh parent comparison."
              : "The graph shows recorded harness evaluations. Activity here reports the saved execution checkpoint."}
      </p>
      <p className="muted">
        Recorded{" "}
        {execution.observedAt
          .replace("T", " ")
          .replace(/\.\d+Z$/, " UTC")
          .replace(/Z$/, " UTC")}
        {following
          ? " · checking published updates every 2s"
          : " · saved snapshot"}
      </p>
    </section>
  );
}
