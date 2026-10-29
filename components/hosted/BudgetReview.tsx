import { usd, type ModelCatalog } from "./contracts";
export function BudgetReview({
  catalog,
  modelId,
  allowance,
  provider = "e2b",
}: {
  catalog: ModelCatalog;
  modelId: string;
  allowance: string | null;
  provider?: string;
}) {
  const model = catalog.models.find((entry) => entry.id === modelId);
  return (
    <section className="hosted-review">
      <h2>Review your experiment</h2>
      <dl className="facts">
        <div>
          <dt>Model for execution and optimization</dt>
          <dd className="mono">{modelId}</dd>
        </div>
        <div>
          <dt>Inference allowance · your Nebius account</dt>
          <dd>{usd(allowance)} total</dd>
        </div>
        <div>
          <dt>Compute allowance · supplied by LoopBench</dt>
          <dd>
            {provider === "tokenfactory"
              ? "Token Factory Sandboxes · operation usage recorded; dollar estimate unavailable"
              : "$5.00 total, within the shared $100 cumulative pool"}
          </dd>
        </div>
        <div>
          <dt>Uncached input / output per million tokens</dt>
          <dd>
            {model?.pricing
              ? `$${Number(model.pricing.promptUsdPerToken) * 1_000_000} / $${Number(model.pricing.completionUsdPerToken) * 1_000_000}`
              : "Unavailable"}
          </dd>
        </div>
        <div>
          <dt>Price captured</dt>
          <dd>{new Date(catalog.checkedAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Harness and benchmark</dt>
          <dd>
            Pi 1.4.0 · coding-adversarial-v1 · six function contracts ·
            independent verification
          </dd>
        </div>
        <div>
          <dt>Continuous evolution</dt>
          <dd>
            Adaptive 2–6 sibling changes · beam width 2 · ten-minute sandbox
            limit
          </dd>
        </div>
      </dl>
      <p className="muted">
        Setup, parent reruns, candidates, verification, optimizer calls, tool
        turns and retries consume their respective allowances. Estimates are not
        invoices. A Nebius account top-up does not increase these limits.
      </p>
      <p className="muted">
        Private experiment. Closing this page does not cancel work. Pause and
        stop remain available in the experiment.
      </p>
    </section>
  );
}
