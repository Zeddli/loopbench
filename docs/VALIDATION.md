# Validation evidence

Latest snapshot: [Live validation, 30 October 2026](LIVE-VALIDATION-2026-10-30.md). The dated sections below preserve earlier evidence; their test counts and running statuses are historical, including the 136-test checkpoint.

## Token Factory and stuck-tree diagnosis, 29 October 2026

The reported `e99ffa32` branch had completed all six tasks and was rejected. Its open URL referenced an older immutable publication showing one completed task. The page now follows newer explicitly published checkpoints from that same public campaign and can return to the original snapshot. Publishing fingerprints include task and phase progress, with safe counters for fresh-parent evaluations, so an unchanged harness graph no longer hides measured work.

The E2B worker separately exhausted a round envelope after retries consumed its originally reserved capacity. The campaign still had USD 1.4702 available. Its error handler masked `BUDGET_NOT_AVAILABLE` with an earlier controlled `ATTEMPT_CALL_LIMIT`. Recovery now checks capacity for both agent and verifier before a new Pi invocation, atomically admits a continuation envelope from existing funds and retains all spent child obligations. Actual execution failure codes take precedence over earlier controlled Pi limits. A subsequent E2B attempt encountered a connection error before any model gateway request; that failure remains unscored in its original lineage.

Authenticated read-only Token Factory checks confirmed spawn, disposable-spawn, import, list and cancel permissions, with a 50-operation account concurrency limit and 3600-second maximum. Prepared private runtime image `91a517fc-84ca-4fa3-84ec-a8329786194c` was observed as Pi 1.4.0 / Node v24.15.0. The real controller probe completed command/file I/O with only loopback present and confirmed termination.

Token Factory campaign `0fa0610b-d374-41a0-ad59-a6198c1f94a0` completed a six-task baseline at 0/6 under the fixed eight-call condition. Pi produced actual submissions; fresh offline verifier operations measured them. The same Nemotron model generated six distinct valid sibling hypotheses from those failures. Fresh parent/candidate evaluation is running. No completed Token Factory improvement is established by the baseline or proposal generation alone.

Compatibility fixes follow observed provider responses: a clean process uses `signal: -1`, and status reads can return HTTP 425 before readiness. Bounded read polling handles 425 without replaying creation. One uncertain verifier was reconciled and confirmed terminated by the owned-operation reaper. Resource observations retain monetary cost null because raw units are not a confirmed invoice.

A later live subprocess-start request also returned 425. Its official contract explicitly says exec is not yet accepted and permits retry after `Retry-After`. Bounded handling now covers that specific rejected POST, while 504 and transport failures remain non-replayable. A regression first reproduced the 425 failure and then passed with explicit 504 no-replay coverage. The reaper confirmed termination of the interrupted verifier before campaign recovery. Its unscored attempt remains in the evidence store.

Invalid optimizer output is preserved internally and receives validation feedback in separately metered scheduler steps. References are constrained to real evaluation IDs. At most three automatic invalid generations occur before an operator hold; partial proposal sets never create graph nodes. Prior failed attempts and publications remain unchanged.

Final software checks passed all 136 tests with zero failures or skips, TypeScript checking and the production build. All 27 Next output-file traces exclude private environment/state files. The actual offline stress probe completed 30 exact round trips of 275000-byte files and confirmed termination. It did not reproduce the earlier single file-write failure; that failure's root cause is not established. Private destination/exit/stderr diagnostics were added. The resumed campaign retains the failed candidate and is rerunning its fresh parent. The final browser observation showed running, three of six fresh-parent tasks complete, hypothesis one of six, automatically followed from an older immutable publication.

The original temporary tunnel hostname stopped resolving. A renewed HTTPS tunnel restored public access. The in-app browser opened the exact old `6880ab3a-6296-40cf-b861-678c64040820` URL and observed it follow a newer publication automatically: `e99ffa32` was rejected with all six task results, and seven actual graph records were visible. The two accepted siblings each measured 0/6 fresh parent to 1/6 candidate; neither exceeds the original baseline score. The browser also verified Token Factory selection and runtime readiness on the new-experiment page. `artifacts/tree-live-follow.png` is the actual graph screenshot. Token Factory baseline/proposals are separate evidence and do not establish a completed Token Factory improvement.

The user lifted the prior project validation cap. Larger operator validation windows were recorded for these campaigns while unrelated public visitors' defaults remain unchanged. The earlier USD 0.50 authorization below is historical. Permanent Linux deployment and Data Lab cloud import remain unverified.

This note separates observed model executions from isolated software tests. No test fixture is registered in the application catalog, and no displayed tree is seeded from a prepared example.

## Current hosted evidence — 28 October 2026

The local live demo has now executed real Nebius Token Factory inference with NVIDIA Nemotron Lightning, Pi 1.4.0 and Node v24.15.0 in E2B. The verified immutable template is `x9swjt4humgif3wctzqj`, with 2 vCPU and 2048 MiB RAM. Its runtime inspection confirmed the required tools and confirmed sandbox cleanup. The separate live Token Factory streaming tool-call and strict JSON probes also passed. These observations supersede the earlier local-only provider and browser limitations recorded below.

Hosted pilot campaign `82b6c8bb…` retained the following actual results on the six-task adversarial suite:

| Evidence                     | Observed result                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline                     | Completed at 1/6 tasks passed.                                                                                                                                                                                                                                                                                                                                                                     |
| First evaluated sibling      | Candidate 1/6 against its fresh parent rerun at 1/6; zero delta, rejected.                                                                                                                                                                                                                                                                                                                         |
| Second evaluated sibling     | Candidate 0/6 against its fresh parent rerun at 0/6; zero delta, rejected.                                                                                                                                                                                                                                                                                                                         |
| Proposal set                 | Six real same-parent proposals were saved. Two have completed paired evaluations; six proposals do not mean six completed comparisons.                                                                                                                                                                                                                                                             |
| Third sibling's parent rerun | After canonical extraction, an agent-cleanup operation failed with `fetch failed`, before verifier admission. The failing GET versus DELETE is unknown. No verifier intent or reservation was created. The final cleanup retry confirmed absence; the agent's full 22,200 micro-USD reservation was charged. The incomplete run received no benchmark score and its failed node remains preserved. |

These results establish a real baseline, proposal generation and two independently verified fresh-parent comparisons. Neither completed sibling improved. The interrupted comparison is retained as an infrastructure failure, rather than a low parent score or a successful candidate. No accepted gain or completed deep multi-generation hosted run is claimed.

The same campaign has resumed, retaining its failures and pending siblings. Two of the six proposed siblings have completed comparisons; the remaining four are running or pending. A later historical attempt explicitly removed its canonical submission file and remains unscored rather than being rewritten. The new narrow submission policy applies to future attempts: only a trusted leaf-ENOENT receipt after valid ancestors and eligible settlement produces a missing-submission task failure. It creates no verifier environment or fabricated verifier result. Network, quota, unsafe-path and protocol failures remain infrastructure outcomes. Owned cleanup now retries bounded GET/DELETE operations up to three attempts; create and inference requests are not retried by this cleanup policy.

At the 28 October checkpoint immediately before the final resume, aggregate recorded inference was USD 0.143770 with zero uncertain inference obligations. This is a dated ledger snapshot, not a live spend total, remaining balance or final invoice. The approved aggregate inference allowance remains USD 0.50. Earlier obligations of USD 0.051754 were deducted when setting the current campaign allowance, leaving its ceiling at USD 0.448246. Platform-funded E2B compute remains separate.

A user-provided Nebius dashboard screenshot displayed USD 0.88 in trial credits, USD 0.00 paid balance and 27 days remaining, with usage marked last updated at 05:50 UTC. This is a dated user-supplied observation, not a current API balance or an extra spending grant. The planned USD 5 top-up is not confirmed by that screenshot. The application keeps `balanceStatus = unknown`; the USD 0.50 aggregate demo approval and its earlier-obligation deduction remain unchanged.

The in-app browser completed the public HTTPS visual check of the actual hosted graph. Node selection and the Tree/Stats controls were exercised successfully after configuring the exact development origin and stable UTC timestamp rendering. Earlier failed browser-tool attempts remain historical context below; they no longer describe the current verification state.

The final software checks completed successfully: 120/120 tests passed with zero failures and zero skips, typecheck passed, and the latest production build passed. A host-filesystem sandbox `mkdir EPERM` during a build was resolved by running the build outside that filesystem sandbox; it was not an application-code failure. Inspection of all 27 production output-file traces found no `.env`, `.loopbench` or approved runtime-manifest references after correcting dynamic tracing and private-file exclusions.

The final public HTTPS smoke check returned session bootstrap 201 with a Secure `__Host-` cookie, owned catalog 200, cross-origin mutation 403, foreign campaign 404 and an unscoped inference-gateway request 401. Those checks triggered no paid operation. The production server is live locally with the public HTTPS canonical origin and temporary tunnel; permanent Linux/systemd/Caddy deployment remains pending.

Private lesson JSONL export succeeded with two rows from the actual completed paired comparisons. No Data Lab upload or measured lesson ablation was performed.

## Historical local Codex model evidence — 27 October 2026

On 27 October 2026, the installed Codex CLI was authenticated through ChatGPT. Its local model catalog included `gpt-6-luna`, which was used for the recorded runs below. Token usage came from CLI events. Monetary cost was not reported and remains unknown rather than zero.

| Record                                 | Observed result                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `a3a8cbf3-955e-48ab-a469-0284c10d4afe` | Six-task adversarial baseline, 5/6 tasks passed. Exact-money summation failed the cancellation and normalized-zero case.                                     |
| `fd5bd687-5685-41db-ab68-fa3c71980089` | An actual proposer generated three distinct experiments from that failure. Its saved response diagnosed repeated rescaling of the accumulated decimal total. |
| `be704c1f-a5b1-43a8-813b-b51c40857f3c` | First proposed harness evaluated at 5/6 and retained as rejected.                                                                                            |
| `7b43f63f-5936-4897-8738-4e610a87bb0e` | Second proposed harness evaluated at 6/6. Its fresh parent also scored 6/6, so the measured delta was zero and the change remained rejected.                 |
| `826ac64b-6380-4a3d-b1a0-ee891fff370c` | The third evaluation was interrupted before a task result completed. Checkpoint recovery retained it as failed without repeating the reserved call.          |

The recovered finite campaign retained its 26 spent adapter attempts. That finite campaign is historical evidence, not the continuous-mode demonstration. The continuous engine can adopt its measured lineage without changing these records.

Continuous campaign `25857560-0a37-477e-91cd-89d8dbc96bec` adopted the same tree, `bb13cb4c6dc76d23df68`. Its real unchanged-harness challenge at level 1 scored 6/6. The level-2 challenge scored 5/6 and exposed a JSON-pointer root-replacement failure. The actual proposer generated three distinct same-parent experiments from that evidence. Those attempts were interrupted or hit the Codex account's usage limit; none is presented as a completed successful improvement. The original worker recorded one completed attempt round before the quota pause, not three completed scored benchmarks.

After the provider's reset time passed, explicit resume succeeded and started another three-sibling round on level 2. Failed and interrupted nodes, the failed proposer call and all spent adapter attempts remained in the same lineage. That local implementation paused on a recognized provider limit before starting another sibling and required explicit resume. `artifacts/live-verification.json` records the checked historical local snapshot; it is not the current hosted pilot's evidence source.

The adversarial suite contains six contracts and 64 named cases. Its recorded revision is `5346182318cc8cfcb60355b3d6129bfb2f201ab828ba321d46497ae46faad8b0`. The hash covers task definitions and evaluator/controller source. Earlier smoke-test records use older revisions and must not be used to establish improvement under the current rules. In particular, historical parent evaluations affected by an outer process timeout are not sound evidence of a better harness; current infrastructure failures abort evaluation instead of reducing a parent's score.

## Historical local continuous software verification

The continuous integration test uses isolated subprocess fixtures and the production evaluator. These are software checks, not live model achievements:

- A finite tree is adopted without rewriting its original files.
- Twelve generations each retain three sibling experiments, with measured ancestry deeper than twelve edges.
- An explicit grant continues the same campaign into another generation while retaining spent attempts.
- A full score triggers an actual evaluation on a generated challenge in the same lineage. That checkpoint has no accepted-improvement claim.
- Candidate and parent comparisons use the same benchmark hash and preserve curriculum labels, including manual continuation.
- Pause preserves unstarted sibling proposals; invalid later proposals cannot commit a partial round.
- Adaptive width starts at two, adds distinct failed task IDs from current-suite frontier/recent evidence, and caps at six. Fixed widths outside 2-6 are refused.
- A perfect baseline still receives a full same-parent sibling round before advancing; a partially executed round cannot be skipped when resuming.
- Provider limits pause before another sibling starts. Explicit resume retains failed attempts, continues pending siblings, or makes a new quota-failed proposer attempt with a new ledger entry.
- Unsupported curriculum contracts wait for a trusted extension. Missing adapters fail before inference.
- Bounded proposer context retains recent evidence and compact archive summaries while full records remain on disk.

Curriculum tests independently check all 64 base answers, hand-authored oracle edge cases, deterministic immutable generation, retained anchors, rotation through level 10000, and a real failing case pinned beyond its original window. Independent reference programs are executed through the real evaluator on generated levels 2 and 100. The level-10000 check concerns generation and retention, not a live model score.

Graph tests cover 91 records over 18 generations, multiple sibling branches, retained ancestry, challenge grouping and the exclusion of challenge checkpoints from accepted-upgrade counts. These records exist only inside tests.

## Historical local service and browser checks

At this earlier local checkpoint, `npm test` passed all 37 tests. The suite ran test files sequentially because concurrent child-process tests on this machine caused infrastructure contention. `npm run typecheck` and that production build passed under Next.js 16.4.3. These are historical counts, not the current hosted verification total.

That production application was served at `http://127.0.0.1:3000`. `scripts/verify-local.ts` checked its actual uncached GET endpoints and server-rendered pages, including the continuous homepage, graph controls, historical-page link to the current tree, retained ancestry, actual 2-6 distinct same-parent proposals and unchanged-harness challenge provenance. The check succeeded with nine real records, two branching parents, two challenge checkpoints, five completed scored evaluations and four failed/interrupted evaluations before the resumed round added more records. Its result is saved to `artifacts/live-verification.json`; none of these counts came from test fixtures.

The earlier local browser automation could not complete its final visual pass because no Browser MCP connection was available. Screenshots from that stage verified the Petri-style horizontal graph. The later successful hosted in-app browser check is recorded above.

An initial hosted UI attempt on 28 October was also blocked by browser tooling: Chrome Browser MCP reported no connected browser, the in-app browser timed out opening the local Windows server, and native Computer Use could not determine the current Chrome URL confidently enough to enforce its policy. Those attempts supplied no successful hosted browser evidence. The subsequent public HTTPS graph and control interactions did succeed, as recorded in the current hosted evidence section.

## Evidence boundaries

The historical local Codex runs did not invoke Nebius. The later hosted pilot did invoke real Nebius/NVIDIA inference through the metered gateway and real Pi execution in E2B. Configuration and injected-response tests alone are not the basis for that claim. The observed hosted results establish actual provider execution and paired evaluation, while retaining rejected changes, infrastructure failures and the absence of a measured improvement.
