# Nebius and NVIDIA demonstration

LoopBench diagnoses actual mistakes, proposes competing harness changes and evaluates their branches. The hosted pilot has now executed real NVIDIA Nemotron Lightning inference through Nebius Token Factory, with Pi 1.4.0 / Node v24.15.0 in E2B. It completed a six-task baseline and two fresh paired sibling comparisons. Both siblings tied their parent reruns and were rejected; a later infrastructure failure remains unscored. See [Validation evidence](VALIDATION.md) for the recorded outcomes and boundaries.

## Event requirements checked historically

Checked on 27 October 2026. The [official overview](https://nebiusglobalaihackathon.devpost.com/) gives the submission deadline as 30 October 2026 at 10:00 AM PDT, which is 31 October at 1:00 AM in Malaysia. It requires a working demo, public repository with an open-source license, setup instructions and a public video of no more than three minutes.

The [official rules](https://nebiusglobalaihackathon.devpost.com/rules) require a working application using an NVIDIA open-source model and either a runtime Token Factory inference call or execution on Nebius AI Cloud. They define four equally weighted judging criteria: implementation, design, impact and idea quality. A configured adapter or mocked request alone does not meet the runtime requirement.

Eligibility depends on the entrant and full rules. This document does not establish personal eligibility, registration or a submitted entry. Recheck the linked pages before submission.

## What is implemented

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

## Hosted pilot budget

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

1. Show the actual hosted catalog and six-task scope, with the pinned Pi/Node/E2B runtime and selected Nemotron model.
2. Show the recorded baseline, six genuine proposals and the two completed fresh-parent comparisons. Preserve both rejected ties.
3. Select a graph node and show task evidence, separate compute/inference accounting and the retained unscored cleanup failure.
4. Explain the resumed campaign, retained failures, pending siblings and explicit allowance/resume controls. Additional execution requires remaining admitted budget; a submitted video is still pending.
5. State that this pilot demonstrates actual provider execution and measured comparisons, with no accepted improvement or completed deep hosted lineage yet.

A convincing demo can show a rejected change. The useful claim is that the tool evaluates and preserves evidence rather than trusting an agent's assertion that it improved.

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
