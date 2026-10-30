# Nebius and NVIDIA demonstration

LoopBench runs real NVIDIA Nemotron inference through Nebius Token Factory and executes Pi in Token Factory Sandboxes. In the sixteen-call campaign `876e9ddd…`, accepted child `e7ca9a1c…` passed 2/6 tasks against a fresh parent at 1/6, above its original same-condition 0/6 baseline. This is a modest verified paired gain, not benchmark mastery or a general coding claim. Rejected siblings and an independently observed resource-quarantine continuation remain visible.

Use the [filming runbook](DEMO-RUNBOOK.md) and [latest validation](LIVE-VALIDATION-2026-10-30.md) for current evidence. The quality campaign completed two rounds and is now executing the first fresh parent for two valid round-three hypotheses after approved source review; no new round-three candidate outcome is claimed. Earlier E2B results and the budget snapshot below are historical, with their original runtime and allowance.

## Historical E2B pilot

LoopBench diagnoses actual mistakes, proposes competing harness changes and evaluates their branches. The hosted pilot has now executed real NVIDIA Nemotron Lightning inference through Nebius Token Factory, with Pi 1.4.0 / Node v24.15.0 in E2B. It completed a six-task baseline and two fresh paired sibling comparisons. Both siblings tied their parent reruns and were rejected; a later infrastructure failure remains unscored. See [Validation evidence](VALIDATION.md) for the recorded outcomes and boundaries.

## Event requirements checked historically

Checked on 27 October 2026. The [official overview](https://nebiusglobalaihackathon.devpost.com/) gives the submission deadline as 30 October 2026 at 10:00 AM PDT, which is 31 October at 1:00 AM in Malaysia. It requires a working demo, public repository with an open-source license, setup instructions and a public video of no more than three minutes.

The [official rules](https://nebiusglobalaihackathon.devpost.com/rules) require a working application using an NVIDIA open-source model and either a runtime Token Factory inference call or execution on Nebius AI Cloud. They define four equally weighted judging criteria: implementation, design, impact and idea quality. A configured adapter or mocked request alone does not meet the runtime requirement.

Eligibility depends on the entrant and full rules. This document does not establish personal eligibility, registration or a submitted entry. Recheck the linked pages before submission.

## What is implemented

The primary current path uses `hosted/models.ts` for live eligible Nemotron discovery, `hosted/gateway.ts` for admitted and metered inference, and `hosted/worker.ts` with Token Factory Sandboxes agent/verifier operations. Pi 1.4.0 and Node v24.15.0 run in the pinned offline guest image; scoped inference travels through the loopback relay. Fresh independent verification establishes each comparison. The live eight-call campaign demonstrated parent-memory quarantine followed by execution of the next sibling, without a fabricated low parent score.

The optimizer can review explicitly approved, owned, hash-matched generated-source excerpts and public behavioral contracts, with hidden cases and expected answers excluded. Only the known agent-facing JavaScript-output boilerplate suffix is stripped from that optimizer view; benchmark definitions and agent README contracts stay unchanged. Its reasoning/output allowance and new 180-second timeout are separate from unchanged parent/candidate settings and 110-second Pi/probe timeouts. Invalid solution-like output and an uncertain body-read timeout remain recorded; the timeout reservation is retained. The completed sixteen-call 2/6 result is measured evidence; neither source review nor proposal generation alone proves improvement. The latest local verification passed all 218 tests and production build v6; all 27 production traces exclude private environment/state and runner-manifest references. These software checks are separate from the measured 2/6 model result. The local controller still needs this laptop awake. Permanent hosting, a submitted public video and Data Lab cloud import are not established.

### Historical E2B implementation checkpoint

The current hosted path uses `hosted/models.ts` for live eligible Nemotron discovery, `hosted/gateway.ts` for every admitted inference request, and `hosted/worker.ts` with Pi/E2B execution and fresh verifier environments. Nemotron supplied both task execution and six actual same-parent proposals. The local production build's public HTTPS graph, node selection and Tree/Stats controls were checked in the in-app browser. Permanent Linux deployment, a public submission video and an actual Data Lab cloud workflow are not established by this evidence.

The sections below retain the separate optional CLI adapter instructions. They do not describe the hosted gateway's accounting or its already recorded live inference.

`integrations/nebius-adapter.ts` implements the task protocol using one chat-completion request per task. `adapters/nebius-nemotron.json` registers it. The adapter checks an NVIDIA-prefixed model ID, an allowed HTTPS Nebius host, prompt lengths, explicit positive price/token limits and an opt-in environment flag. It uses a timeout, refuses redirects and does not retry failed requests.

For task execution, the response supplies generated code and token counts. For proposing, `settings.responseFormat=json` asks for the campaign proposal object, which the evolution engine then validates. `costUsd` is calculated from provider token usage and the operator's configured rates. It is an estimate from those rates, not an invoice or provider-reported charge. The runner executes returned functions with the same evaluator as any other adapter.

Registering the adapter is a local operation:

```powershell
npm run cli -- adapter add ./adapters/nebius-nemotron.json
npm run cli -- adapters
```

Next, obtain the exact currently available NVIDIA model ID and its input/output prices from the Nebius account or current provider documentation. Do not guess a model alias or copy prices from an old example. The adapter requires all price fields and `maxTokens`; it deliberately has no silently assumed rates.

## Current operator campaign allowances

The quality campaign's explicit inference allowance was raised from 400,000 to 500,000 micro-USD. The eight-call validation campaign remains at 400,000. These are per-campaign admissions, not confirmed Nebius account balances. A timed-out optimizer call retains its unknown reservation; neither a timeout nor an account top-up silently creates free budget.

## Historical hosted pilot budget, 28 October

The approved aggregate inference allowance is USD 0.50. Earlier demo obligations of USD 0.051754 were deducted from the current campaign's limit, leaving USD 0.448246 for that campaign. At the 28 October checkpoint before the final resume, aggregate recorded inference was USD 0.143770 with zero uncertain inference obligations. This dated snapshot is separate from the cumulative USD 100 platform E2B compute ceiling and is not a live spend total or remaining Nebius account balance. The gateway reserves each request before transmission, retains unknown usage and requires explicit allowance changes; a provider top-up does not enlarge an allowance automatically.

## Legacy CLI adapter budget contract

For the legacy CLI adapter only, paid inference is disabled unless `NEBIUS_ALLOW_PAID=1`. `.env.example` documents the environment names, but the CLI inherits the current shell environment; it does not automatically load that file. Keep the actual API key out of commands, manifests, logs and Git.

Before a request, the adapter estimates input using UTF-8 byte length plus overhead and the maximum output token count. It rejects a request whose estimate exceeds `maxCostUsd`, which is restricted to at most $0.05 per task. `maxTokens` must be an integer no greater than 8192. Operator rates must be positive and no greater than $100 per million tokens.

This legacy adapter's admission estimate is not a hard billing guarantee. Provider accounting, account balance and current prices remain authoritative. The adapter has no shared account-wide budget ledger or automatic balance lookup; the hosted path has its separate durable campaign ledger described above.

For `n` tasks and a per-invocation admission cap `b`, a root or unchanged-champion challenge checkpoint admits up to `n × b` of estimated task cost and a paired child up to `2 × n × b`. The adversarial six-task suite needs six baseline/challenge invocations or twelve per child. The parent rerun uses the parent's stored settings and current matching manifest; check those limits too. A Nebius proposer adds one inference invocation per proposed round. An adaptive 2-6-sibling round therefore requires 25-73 adapter invocations, plus six whenever a new baseline or challenge checkpoint is measured. An explicit `--branches 3` fixes a round at 37 calls. A perfect suite still requires a completed sibling round before advancing its challenge. Continuous search has no finite total inference cost. Choose one small explicit allowance, inspect its ledger and account spend, and grant more only deliberately. A finite two-round check with two siblings from an existing baseline requires 50 invocations, or 56 including a new baseline. Do not budget on an assumed early success.

Campaign `maxCalls` includes proposer, new baseline, challenge, parent and candidate adapter reservations. It limits controlled adapter invocations, not the internal provider calls or tool use of an opaque CLI. The Nebius adapter itself makes one HTTP inference call per invocation without retries. Its per-call admission estimate and campaign count are useful independent controls; neither reads the account balance or guarantees a total invoice.

After intentionally enabling the provider in the current shell, the command shape is:

```powershell
npm run cli -- run --adapter nebius-nemotron --domain coding --model "nvidia/EXACT_AVAILABLE_MODEL_ID" --harness nemotron-functions --benchmark coding-adversarial-v1 --hypothesis "Measure NVIDIA function generation on Nebius" --setting maxTokens=OUTPUT_TOKEN_LIMIT --setting maxCostUsd=PER_TASK_LIMIT --setting inputUsdPerMillion=CURRENT_INPUT_RATE --setting outputUsdPerMillion=CURRENT_OUTPUT_RATE
```

Every uppercase value is a placeholder. This is intentionally not an executable paid default. Registering, reading documentation, running tests and viewing existing records do not require enabling paid inference.

The same registered adapter can propose changes by adding `--proposer-adapter nebius-nemotron --proposer-model "nvidia/EXACT_AVAILABLE_MODEL_ID"` to an `evolve` command with the required limit/price settings. The engine supplies JSON response mode. Using Nebius only for the proposer is a meaningful runtime integration if actually executed and demonstrated; do not imply task execution was on Nebius when another adapter generated those functions.

## Demonstration outline

Use the [filming and submission runbook](DEMO-RUNBOOK.md) for the current 30 October Token Factory campaign, safe process controls, latest publication pointer and a two-to-three-minute storyboard. Fill its result card only after a completed verified comparison. Earlier E2B demonstrations above remain historical evidence, not the current campaign's measured outcome.

## Submission checklist

- [x] Actual NVIDIA model inference on Nebius is recorded, with pinned runtime, provider calls, usage and verification evidence. Reproduction uses the configured credentials and an explicit admitted allowance.
- [ ] The demo URL/test build works for a reviewer without access to the developer's private files.
- [x] Local repository contains an MIT license. Public accessibility and third-party attribution still need submission review.
- [ ] README explains setup, model configuration, run commands and evidence limits.
- [ ] Video is public, no longer than three minutes, and shows the modules in action.
- [ ] Description distinguishes this rebuild from Petri and identifies new work during the submission period.
- [ ] Nebius/NVIDIA feedback is based on actual usage.
- [ ] Entrant eligibility, registration, track and submission form are checked against the official rules.

The autonomous proposer, sibling evaluation, bounded lesson context and continuous curriculum scheduling are implemented. Actual hosted Nebius/NVIDIA execution is supported by the recorded pilot, not by adapter registration or injected-response tests. A separate adversarial critic, distributed attestations, arbitrary repository patching, production promotion and measured Data Lab lesson ablation remain future work. The other submission checklist items remain pending until separately verified; neither a temporary demo tunnel nor a successful build establishes a submitted entry or permanent deployment.
