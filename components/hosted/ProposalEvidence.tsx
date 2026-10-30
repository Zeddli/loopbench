import type { Projection } from "./contracts";

export function ProposalEvidence({
  proposals,
}: {
  proposals: Projection["proposals"];
}) {
  const pending = proposals.filter(
    (proposal) => !proposal.nodeId && proposal.outcome !== "quarantined",
  );
  const quarantined = proposals.filter(
    (proposal) => proposal.outcome === "quarantined",
  );
  return (
    <>
      {pending.length > 0 && (
        <div>
          <h3>Saved hypotheses awaiting execution · {pending.length}</h3>
          <ul>
            {pending.map((proposal, index) => (
              <li key={`${proposal.round}-${index}`}>
                Round {proposal.round} · {proposal.hypothesis}
              </li>
            ))}
          </ul>
        </div>
      )}
      {quarantined.length > 0 && (
        <section aria-label="Quarantined comparisons">
          <h3>Unscored failed comparisons · {quarantined.length}</h3>
          <p className="muted">
            These comparisons are quarantined and excluded from ranking. They
            are finished outcomes, not pending hypotheses.
          </p>
          <ul className="hosted-events">
            {quarantined.map((proposal, index) => (
              <li key={`${proposal.round}-${index}`}>
                <span>
                  Round {proposal.round} · {proposal.hypothesis}
                </span>
                <span className="tag">
                  Unscored ·{" "}
                  {proposal.failurePhase
                    ? `${proposal.failurePhase} evaluation`
                    : "comparison failure"}
                </span>
                {proposal.error && <p>{proposal.error}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
