"use client";
import { type EvolutionCampaign, type TreeSummary } from "@/core/types";
import { campaignForTree, campaignLabel } from "./live";
import { shortId } from "./lineage";
import { CopyCommand } from "./CopyCommand";

export function CampaignProgress({
  tree,
  onSelect,
  campaigns,
}: {
  tree: TreeSummary;
  onSelect: (id: string) => void;
  campaigns: EvolutionCampaign[];
}) {
  const ids = new Set(tree.nodes.map((node) => node.id));
  const campaign = campaignForTree(tree, campaigns);
  if (!campaign) return null;
  const currentProposals = campaign.proposals.filter(
    (proposal) => proposal.round === campaign.round,
  );
  const pendingEvaluations = currentProposals.filter((proposal) => {
    const node = tree.nodes.find((node) => node.id === proposal.nodeId);
    return !node || node.status === "running";
  }).length;
  return (
    <section
      className={`campaign-progress campaign-${campaign.status}`}
      aria-label="Evolution campaign progress"
    >
      <div className="campaign-title">
        <div>
          <span className="eyebrow">
            {campaign.options.continuous
              ? "CONTINUOUS EVOLUTION"
              : "BRANCHING EVOLUTION"}{" "}
            · {shortId(campaign.id)}
          </span>
          <h2>
            {campaignLabel(campaign)} ·{" "}
            {campaign.curriculum ? `Level ${campaign.curriculum.level} · ` : ""}
            Round {campaign.round}
            {!campaign.options.continuous && ` of ${campaign.totalRounds}`}{" "}
            <span className="campaign-status">
              {campaign.options.continuous ? "continuous" : "bounded campaign"}
            </span>
          </h2>
        </div>
        <span className="muted" role="status">
          {campaign.status === "running"
            ? "Live · updates every 2s"
            : `${campaign.completedRounds} rounds completed`}
        </span>
      </div>
      <dl className="campaign-facts">
        <div>
          <dt>Candidate evaluations</dt>
          <dd>
            {campaign.candidateIds.length}
            {!campaign.options.continuous && `/${campaign.maxCandidates}`}
          </dd>
        </div>
        <div>
          <dt>Proposals this round</dt>
          <dd>{currentProposals.length}</dd>
        </div>
        <div>
          <dt>Sibling changes per parent</dt>
          <dd>
            {campaign.options.adaptiveBranches
              ? `Adaptive 2–6 · current ${campaign.branches}`
              : `Fixed ${campaign.branches}`}
          </dd>
        </div>
        <div>
          <dt>Adapter calls</dt>
          <dd>
            {campaign.callsUsed}/{campaign.maxCalls}
          </dd>
        </div>
      </dl>
      {campaign.options.continuous && (
        <p className="campaign-selection">
          Keeps branching and learning within the granted call budget. Each
          sibling round finishes before a solved level advances to a larger
          benchmark with a new measured baseline. Every earlier level remains in
          this tree.
        </p>
      )}
      {currentProposals.length > 0 && (
        <p className="campaign-selection">
          {pendingEvaluations} of {currentProposals.length} proposed evaluations
          pending in this round.
        </p>
      )}
      {(campaign.status === "waiting_budget" ||
        campaign.status === "budget_exhausted") && (
        <p className="budget-notice">
          Checkpoint saved. No further adapter calls run until you explicitly
          grant more calls.
        </p>
      )}
      <p className="campaign-selection">
        <b>Selection:</b>{" "}
        {campaign.selectionReason ||
          "Waiting for candidate measurements before selecting the next parents."}
      </p>
      {campaign.activeNodeId && ids.has(campaign.activeNodeId) && (
        <button
          className="text-button"
          onClick={() => onSelect(campaign.activeNodeId ?? "")}
        >
          Inspect active candidate {shortId(campaign.activeNodeId)} →
        </button>
      )}
      {currentProposals.length > 0 && (
        <details className="campaign-proposals">
          <summary>Round {campaign.round} hypotheses</summary>
          <ul>
            {currentProposals.map((proposal, index) => (
              <li key={`${proposal.round}-${index}`}>
                {proposal.nodeId && ids.has(proposal.nodeId) ? (
                  <button
                    className="text-button"
                    onClick={() => onSelect(proposal.nodeId ?? "")}
                  >
                    {shortId(proposal.nodeId)}
                  </button>
                ) : (
                  <span className="muted">Proposed</span>
                )}
                <span>{proposal.hypothesis}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {campaign.error && <pre className="error-output">{campaign.error}</pre>}
      <details className="campaign-controls">
        <summary>CLI controls and call budget</summary>
        <p className="muted">
          Run in your terminal. Granting calls increases the adapter invocation
          allowance; it does not set a dollar limit.
        </p>
        <CopyCommand command={`npm run cli -- campaign ${campaign.id}`} />
        <CopyCommand command={`npm run cli -- pause ${campaign.id}`} />
        <CopyCommand
          command={`npm run cli -- resume ${campaign.id}${campaign.status === "waiting_budget" || campaign.status === "budget_exhausted" ? " --grant-calls 50" : ""}`}
        />
        <CopyCommand command={`npm run cli -- stop ${campaign.id}`} />
      </details>
    </section>
  );
}
