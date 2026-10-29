# Implementation and validation

The hosted Pi/E2B path is implemented and has run real Nemotron inference through Nebius Token Factory. The current pilot completed a six-task baseline and two fresh paired sibling comparisons; both siblings tied and were rejected. The campaign has resumed with four siblings running or pending and its historical unscored failures preserved. Future eligible missing submissions are rejected only from a trusted canonical leaf-missing receipt; no verifier result is fabricated. [Validation evidence](VALIDATION.md) records the exact results, dated spend snapshot and limits.

The latest checks passed 120/120 tests with zero skips or failures, typecheck and production build. The production build's public HTTPS graph, node selection and Tree/Stats controls were exercised in the in-app browser. Final HTTPS ownership/origin/gateway checks returned the expected 201/200/403/404/401 responses without paid work. The production server runs on the local Windows host through a temporary tunnel; the permanent Linux deployment assets are not deployed. See the [hosted runbook](HOSTED-RUNBOOK.md), [architecture](ARCHITECTURE-HOSTED.md) and [implementation status matrix](superpowers/plans/2026-10-27-hosted-pi-e2b-implementation.md#implementation-status--28-october-2026).

## Current hosted feature map

| Area                      | Files                                                                                                     | Implemented behavior and evidence boundary                                                                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ownership and persistence | `hosted/schema.ts`, `database.ts`, `store.ts`, `auth.ts`, `credentials.ts`, `rate-limit.ts`               | SQLite WAL, owned sessions/records, encrypted BYOK credentials, durable rate limits and tested cross-owner denials.                                                                                                                |
| Money and inference       | `hosted/budget.ts`, `pricing.ts`, `models.ts`, `gateway.ts`, `gateway-tokens.ts`                          | Exact micro-USD reservations, live eligible-model/pricing discovery and metered scoped requests. Approved demo inference totals USD 0.50; earlier obligations are retained. E2B compute has a separate cumulative USD 100 ceiling. |
| Pi/E2B execution          | `hosted/e2b.ts`, `sandboxes.ts`, `runtime-sandboxes.ts`, `pi.ts`, `pi-events.ts`, `attempts.ts`           | Actual Pi 1.4.0 / Node v24.15.0 execution on the verified E2B template, bounded calls, durable intents and confirmed cleanup. Unknown remote outcomes retain obligations.                                                          |
| Independent grading       | `hosted/task-workspaces.ts`, `verifier.ts`, `evaluation.ts`, `comparisons.ts`                             | Canonical extraction and fresh trusted verification on six function contracts. Infrastructure failures receive no benchmark score.                                                                                                 |
| Branching search          | `hosted/optimizer.ts`, `worker.ts`, `evolution.ts`, `jobs.ts`, `events.ts`                                | Real same-parent proposals, fresh parent/candidate task batches and durable checkpoints. Six proposals and two completed rejected comparisons are observed; no accepted improvement or completed deep hosted lineage is claimed.   |
| Browser workflow          | `app/api/hosted/**`, `app/api/inference/**`, `app/setup/**`, `app/experiments/**`, `components/hosted/**` | Owned setup, creation, control, allowance and evidence APIs; actual public HTTPS graph selection and Tree/Stats browser checks.                                                                                                    |
| Artifacts and publication | `hosted/artifacts.ts`, `publication.ts`, `publication-schema.ts`                                          | Private bounded evidence and explicit sanitized immutable publication paths; live private records are not an anonymous legacy catalog.                                                                                             |
| Operations                | `scripts/hosted-*.ts`, `deploy/**`                                                                        | Runtime build/probe, readiness, status, worker/reaper and operator tools. Permanent Linux deployment and a restore rehearsal remain unverified.                                                                                    |
| Lessons                   | `scripts/hosted-export-lessons.ts`                                                                        | Private JSONL export succeeded with two real paired-evidence rows and deterministic provenance. No Data Lab upload or measured lesson ablation was performed.                                                                      |

## Historical/local CLI feature map

The map and phase checklists below describe the retained local CLI implementation. Its file store, adapter-call accounting and browser restrictions are separate from the hosted SQLite/gateway workflow above. Historical local model outcomes remain readable and are not relabeled as Pi/Nemotron results.

| Area             | Files                                                                   | Behavior to verify                                                                                                   |
| ---------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Shared contracts | `core/types.ts`                                                         | Runtime schemas for manifests, configurations, tasks and nodes                                                       |
| Store            | `core/store.ts`                                                         | Atomic node files, completed-node protection, benchmark-aware tree identity, adapter registry                        |
| Execution        | `core/adapters.ts`, `core/runner.ts`                                    | Bounded processes, strict task protocol, fresh parent/candidate batches, retained outcomes                           |
| Evolution        | `core/evolution.ts`, `core/campaigns.ts`, `adapters/codex-proposer.mjs` | Actual model proposals, shared-parent siblings, evidence feedback, durable reservations and exclusive worker lock    |
| Benchmark        | `core/benchmarks.ts`, `benchmarks/*`                                    | Definition hash, actual function execution, per-task pass/fail                                                       |
| Curriculum       | `core/curriculum.ts`, `core/curriculum-oracles.ts`                      | Deterministic fresh inputs, independent expected answers, immutable suites, retained anchors and failure pins        |
| CLI              | `cli/main.ts`                                                           | Run/evolve/pause/resume/stop, campaign inspection, node inspection, list/digest and adapter/benchmark commands       |
| Codex            | `adapters/codex-cli.mjs`                                                | Real installed CLI invocation and JSON event parsing                                                                 |
| Nebius           | `integrations/nebius-adapter.ts`, `adapters/nebius-nemotron.json`       | Opt-in NVIDIA inference, explicit limits, no retries                                                                 |
| Viewer           | `app/**`, `components/**`                                               | Actual catalog, horizontal lineage, record details and live read polling                                             |
| Tests            | `tests/*.test.ts`                                                       | Store/protocol/runner, continuous lineage and grants, curriculum reference checks, graph and Nebius request behavior |

The old application and its prepared experiment state are replaced. Do not add a seed command, snapshot fallback or fixture tree to fill the new home page. Test adapters in `tests/` are deterministic test inputs, not production benchmark evidence.

## Phase 1: establish contracts and storage

The core invariant is that every displayed node corresponds to a stored run record. Validate JSON at boundaries and keep completed results immutable through the store API. Hash benchmark content into ordinary finite tree identity, rather than trusting a human-readable benchmark name. Continuous campaigns keep one validated lineage across verified challenge revisions and retain each node's exact benchmark hash. Store unrelated runs in separate node files to avoid a shared append file becoming a write race.

Checks:

- [x] Shared runtime schemas exist.
- [x] Node and adapter storage use temporary-file then rename writes.
- [x] Finite tree identity includes benchmark content hash; continuous adoption preserves existing immutable history.
- [x] Missing store yields an empty catalog.
- [x] Completed-node writes are refused by the store API.
- [ ] Add migration/version policy before changing persisted schemas in a released deployment.
- [ ] Add standalone-run recovery and durable backups before unattended long-running use. Campaign continuation already preserves interrupted evidence as described below.

The checked items describe inspected implementation, not independent test results. Run the commands below to validate this checkout.

## Phase 2: connect actual harness execution

`loopbench.task.v1` is the extension point. A manifest selects a command and arguments. LoopBench sends the task and settings through stdin, validates one JSON response and evaluates its output. Adapter output cannot declare its own passing score. Logs belong on stderr. Credentials are inherited from the environment or provider login.

The built-in Codex adapter invokes `codex exec` with JSON output, ephemeral operation, read-only sandbox, ignored user configuration and a model chosen by the operator. It starts from a temporary task directory. This reduces unrelated repository context; it does not prove hostile-code isolation.

Checks:

- [x] Adapter registration and enumeration exist.
- [x] Invalid output, process failures, excessive output and timeouts have explicit error paths.
- [x] Codex final-message and usage events are parsed.
- [x] Parent manifest, readable absolute-argument entrypoint files, Node version and Codex CLI version are fingerprinted and checked before a paired rerun.
- [ ] Snapshot executable content and dependency versions for stronger reproducibility.
- [ ] Run additional harness integrations against their actual installed tools before advertising verified support.

## Phase 3: measure and retain evidence

The registry contains a three-task function smoke check and `coding-adversarial-v1`, six functions with 64 named cases. The adversarial tasks are strict CSV, atomic JSON Pointer patching, exact decimal sums, weighted LRU, time-zone interval unions and dependency layers. Reference implementations test the evaluator's contract; they are not live agent results. Tasks marked `nonMutating` also check arguments after execution.

The runner saves a `running` record, then each candidate task, then the final result. A child reruns the parent per task before the candidate. Strictly greater pass rate is accepted; equality and regression are rejected. Generated-code mistakes and one-second VM timeouts return task failures. Infrastructure startup/exit/protocol errors and the fifteen-second outer evaluator timeout instead fail the evaluation, so an unhealthy parent process cannot make a candidate appear better.

Checks:

- [x] Actual generated functions run against versioned test cases, with named diagnostics and declared mutation checks.
- [x] Benchmark revisions hash definition plus evaluator/controller source and persist the resolved path.
- [x] Root and child states differ explicitly.
- [x] A child stores the fresh parent task results and paired score delta.
- [x] Unknown tokens/cost remain null.
- [ ] Add repeated paired batches and uncertainty reporting before statistical improvement claims.
- [ ] Add independent held-out tasks and larger repository tasks before production-quality claims.
- [ ] Add a container/VM worker with network and filesystem controls before accepting hostile generated code.

## Phase 4: evolve from mistakes over multiple rounds

The engine now implements the previously planned proposer loop. Each round restricts scored completed nodes to the current benchmark hash, ranks by score and recency, exposes a bounded beam, and asks the actual proposer for 2-6 distinct siblings from one shared parent. Continuous mode selects the count adaptively from measured failures unless `--branches N` fixes it within that range. Every proposal must reference real evidence and its parent; when visible measured mistakes exist, its learning references must include at least one relevant mistake. References must identify actual visible evidence, not every historical record. The engine records diagnosis, concrete change, prediction and complete replacement instructions, then measures every sibling with the same paired runner.

The continuous digest includes eligible parents, nearby ancestry, recent nodes, failures, instruction/output excerpts, comparisons and lessons within a 120,000-character serialized bound. Compact archive summaries retain older failure and strategy counts; raw history remains on disk. Proposed JSON is validated before candidate evaluation. Invalid proposals and interrupted proposer calls retain their evidence. In continuous mode, mastery advances to a verified challenge level in the same lineage only after a sibling round completes on that suite. An already perfect baseline or challenge checkpoint still receives its 2-6 competing experiments. In finite mode, saturation remains a terminal result.

Checks:

- [x] Dedicated actual Codex proposer, plus configurable proposer adapter/model.
- [x] Exactly 2-6 distinct siblings per round, adaptive by default in new continuous campaigns or explicitly fixed. Finite campaigns default to two. Each round has one shared eligible beam parent and no repeated intervention from that parent.
- [x] Later rounds consume measured failure and lesson history.
- [x] Optional node learning records link proposal reasoning to actual source nodes.
- [x] Persistent calls are reserved before proposal, baseline, challenge, parent or candidate invocation.
- [x] Full next-round admission checks the invocation allowance before spending; finite mode also checks its candidate ceiling.
- [x] Existing worker locks are always refused; stale lock removal is an explicit operator action after confirming worker termination.
- [x] Crash continuation preserves spent reservations and incomplete failed nodes without retrying them.
- [x] Finite mode retains `saturated`; continuous mode advances the challenge without fabricating improvement.
- [x] Continuous campaigns ignore finite round/candidate ceilings and retain lineage through explicit call grants.
- [x] Trusted curriculum retains all 64 base cases, level-one anchors, the latest eight levels and every identified historical failing check. Each level adds 48 fresh cases.
- [x] Expected answers come from independent trusted algorithms, with base/pinned answer validation and immutable artifact identity including source hashes.
- [x] Each challenge first measures the unchanged champion as a parent-linked `challenge` baseline. A later acceptance requires a fresh pair on that exact benchmark.
- [x] Operator pause/stop controls preserve history separately from the call ledger; unavailable extensions save `waiting_challenge`.

From an existing six-task baseline:

```powershell
npm run cli -- evolve --continuous --adapter codex-cli --domain coding --model MODEL --harness codex-cli --benchmark coding-adversarial-v1 --parent BASELINE_UUID --beam-width 2 --max-calls 80
npm run cli -- campaigns
npm run cli -- campaign CAMPAIGN_ID
npm run cli -- evolve --resume CAMPAIGN_ID --grant-calls 80
npm run cli -- pause CAMPAIGN_ID
npm run cli -- resume CAMPAIGN_ID
npm run cli -- stop CAMPAIGN_ID
```

Continuous search checkpoints when its adapter allowance cannot cover more work. It has no fixed generation ceiling. A six-task paired candidate requires twelve task adapter invocations. An adaptive 2-6-sibling round therefore needs 25-73 calls including its proposer; each new baseline or challenge checkpoint adds six. The engine checks the selected full round before spending and does not reduce it to one sibling for lack of allowance. Continue the same checkpoint with `evolve --resume CAMPAIGN_ID --grant-calls 80`. Limits count adapter invocations, not opaque internal Codex/provider requests. Legacy finite mode can still run a bounded two-round check.

## Phase 5: reconstruct the usable viewer

The browser reads the same store used by the CLI through uncached GET endpoints. It offers actual-value filters, tree cards, SVG lineage, record inspection and an adapter setup page. Visible-tab polling refreshes progress and keeps the selected node stable.

Checks:

- [x] Home, tree detail and adapter routes exist.
- [x] SVG layout grows left to right and retains failed branches.
- [x] Selected record sits below the graph, with task evidence beside it on desktop.
- [x] Browser actions cannot start inference or mutate verdicts.
- [x] Branching histories are separate from baselines/single branches and all-failed histories.
- [x] Campaign progress and Mistake → Lesson → Harness change → Outcome evidence are visible.
- [x] Historical benchmark revisions remain readable but cannot produce misleading continuation commands.
- [ ] Complete the manual visual checklist in [DESIGN.md](DESIGN.md) for each target viewport.

## Validation commands

From the repository root:

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run cli -- help
npm run cli -- benchmark list
npm run cli -- adapters
```

Tests use temporary stores and deterministic test adapters or injected HTTP responses. Reference functions exercise all 64 adversarial cases and generated suites through the real evaluator at levels 2 and 100. A separate deterministic-retention check generates level 10,000 and verifies its fresh case identities and retained anchors. Continuous process tests assert twelve rounds with 36 sibling evaluations and depth of at least thirteen, despite finite round/candidate settings, then resume through a call grant without changing campaign identity. They also check challenge-baseline semantics, retained failure cases, pause/stop controls and unsupported-extension waiting. These fixtures are software tests and never populate the production catalog. They prove software behavior under those inputs; they do not prove that a provider is reachable, that an installed Codex model is authorized, or that an NVIDIA model produced a real score. See [VALIDATION.md](VALIDATION.md) for actual command outcomes and live model records, kept separate from this implementation checklist.

For the local browser check:

```powershell
npm run dev
```

Inspect `http://127.0.0.1:3000`, `/adapters` and a real tree. Run one authorized baseline from another terminal and confirm progress appears. Then run a child and inspect its paired parent batch. Record the actual node IDs, model ID, status, task outputs and usage rather than adding a claimed result to this document in advance.

## Operational cases

| Trigger                                                                                      | Required behavior                                                                                                          |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| No `codex` executable                                                                        | Preflight refusal during version fingerprinting; no simulated response                                                     |
| Bad model authorization after initial persistence                                            | Failed node with process error; no simulated response                                                                      |
| Adapter emits prose before JSON                                                              | Protocol failure; diagnostics should have gone to stderr                                                                   |
| Generated function returns wrong value                                                       | Task fails; run can still complete with a lower score                                                                      |
| Generated code loops inside the VM                                                           | One-second VM limit returns a task failure                                                                                 |
| Evaluator fails to start, exits abnormally, emits invalid protocol or hits its outer timeout | Evaluation fails; never substitute a zero-scoring parent batch                                                             |
| Wrong parent or benchmark changed                                                            | Refuse cross-tree comparison                                                                                               |
| Registered parent manifest, hashed entrypoint or runtime changed                             | Fail reproduction rather than use its historical score                                                                     |
| Ordinary manual candidate ties a 100% paired parent                                          | Reject the tie; continuous mastery uses a separate verified challenge transition                                           |
| CLI and viewer show different catalogs                                                       | Check that both use the same absolute `LOOPBENCH_HOME`                                                                     |
| Read poll fails                                                                              | Keep last valid browser data and retry with a visible update-error state                                                   |
| Runner is killed                                                                             | Running node may remain; do not declare it completed automatically                                                         |
| Evolution worker crashes                                                                     | Confirm worker stopped, clear only its stale lock, then resume; reservations stay spent and interrupted work stays failed  |
| Next work cannot fit the call budget                                                         | Continuous mode saves `waiting_budget`; finite mode saves `budget_exhausted`                                               |
| A measured node passes every task                                                            | Complete a 2-6-sibling round on that suite before a continuous challenge transition; finite mode can then save `saturated` |
| Trusted next challenge cannot be generated                                                   | Save `waiting_challenge`; never manufacture an accepted upgrade                                                            |
| Operator requests pause or stop                                                              | Save a persisted control checkpoint after active work settles; retain lineage and remaining allowance                      |

## Phase 6: legacy optional Nebius adapter

The legacy CLI adapter is implemented separately from the hosted gateway. Registration does not call the provider. A paid request through this adapter requires `NEBIUS_ALLOW_PAID=1`, `NEBIUS_API_KEY`, an NVIDIA-prefixed model ID and explicit settings for `maxTokens`, `maxCostUsd`, `inputUsdPerMillion` and `outputUsdPerMillion`. The hosted pilot instead uses an owned connected credential, explicit campaign allowance and per-request ledger admission. See [HACKATHON.md](HACKATHON.md).

No paid provider invocation is implied by a successful build or mock HTTP test. Verify availability and pricing in the account, calculate baseline, proposer and both comparison sides, then make a deliberately bounded run. A six-task root needs six task invocations; each child needs twelve. The adapter also supports proposal JSON through `--proposer-adapter nebius-nemotron --proposer-model nvidia/EXACT_MODEL_ID`. Every Nebius invocation requires the explicit price/token settings and opt-in. Its admission estimate is not an account-wide billing cap.

## Later engineering work

The next useful steps are independent holdouts, repeated paired evaluation and complete reproducible adapter snapshots. The model proposer and multi-round branching loop already exist. Add a separate critic only when it has a distinct, measurable role beyond the current named contract tests. Keep proposal reasoning, learning references and actual outcome separately inspectable.

Automatic promotion should be a separate release action after repeated evaluation and regression checks. The current `accepted` label does not deploy code, edit a repository, switch a production agent, sign an attestation or roll back a service. The hosted pilot already has a durable single-host SQLite worker; multi-host scheduling and a PostgreSQL migration remain future scaling work.
