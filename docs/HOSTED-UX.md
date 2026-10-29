# Hosted experiment UX

Status: planned, documentation only. This document describes the proposed E2B/Pi pilot. The hosted pages, session, credential store, model catalog, job API and controls below are not implemented. No paid request, sandbox, deployment or provider setting is authorized by this document alone.

Read this with [the hosted architecture](./ARCHITECTURE-HOSTED.md), [the hosted contracts](./HOSTED-CONTRACTS.md), [the hosted UML](./HOSTED-UML.md) and [the E2B/Pi design](./superpowers/specs/2026-10-27-e2b-pi-design.md). The existing [local design](./DESIGN.md) and [local UML](./UML.md) describe the application that currently runs.

## Product contract

LoopBench is an evidence browser and a harness experiment runner. The hosted pilot adds a browser flow for real experiments while preserving the existing dark, Petri-style, horizontal evolution graph. A graph node records an executed harness version. A proposal, model completion, E2B task sandbox or retry does not become a separate harness version.

The first hosted domain is `coding`. Pi 1.4.0 runs the existing six `coding-adversarial-v1` function contracts as small repository workspaces. It writes `src/solution.cjs` and can run public smoke checks. A separate verifier runs the trusted evaluator. The pilot must be described as function implementation in workspaces. Repository repair and SWE-bench are later benchmark additions.

The selected Nebius model stays fixed within a lineage. In the first pilot, both Pi execution and the harness optimizer use the same selected NVIDIA Nemotron model. Harness evolution changes approved instructions, skills and policy/configuration fields. It does not train model weights.

## Current UI and planned changes

| Current application                                                                         | Hosted plan                                                                                             |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `/` reads the local tree and campaign catalog                                               | Preserve real public archive browsing; add a separate session-owned experiment view                     |
| `TreeCatalog` filters real domain/model/harness records and shows mini lineage graphs       | Keep those filters for archive evidence; add `New experiment` and `My experiments` entry points         |
| `/tree/[id]` inspects a local tree                                                          | Preserve explicitly published archive evidence; private hosted projection lives at `/experiments/[id]`  |
| `TreeWorkspace` has Tree/Stats views, graph selection, task facts, learning and raw records | Reuse that information hierarchy with authorized hosted data and secret-safe artifacts                  |
| `CampaignProgress` shows current-round hypotheses as a text list                            | Retain the text list before execution; link a hypothesis only after an executed node exists             |
| `LineageGraph` has Root, Current head, Fit all, zoom, ancestry and challenge groups         | Preserve the horizontal layout and navigation, with explicit execution and measurement labels           |
| Start, pause, resume and stop are CLI instructions                                          | Add session-owned hosted controls backed by durable control requests                                    |
| Local polling fetches complete records every two seconds                                    | Poll persisted hosted events by cursor, initially every two seconds, and refresh authorized projections |

The legacy `/api/trees` and `/api/campaigns` routes must never become a global view of private hosted records. Public archive and private hosted data use separate read paths. Hosting the current local catalog unchanged is not the multi-user feature.

## Information architecture

| Page                | Audience and purpose                                                                   | Main action                                     |
| ------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `/`                 | Anyone can browse the real, explicitly published archive without a key                 | `Open tree`, `My experiments`, `New experiment` |
| `/tree/[id]`        | Anyone can inspect a published historical tree                                         | Inspect evidence and ancestry                   |
| `/setup`            | Signed demo session can connect or replace its Nebius credential and inspect readiness | `Connect Nebius key`                            |
| `/experiments/new`  | Signed demo session configures and reviews a new private campaign                      | `Start experiment` after budget review          |
| `/experiments`      | Signed demo session lists only its own campaigns, including checkpoints and failures   | `Open experiment`                               |
| `/experiments/[id]` | Owner follows the durable campaign and its tree projection                             | Inspect evidence, pause, resume or stop         |
| `/adapters`         | Existing local adapter protocol and setup reference                                    | Read local tooling instructions                 |

These page routes are planned. No archive link is inferred from a private campaign ID. Published evidence is an explicit sanitized snapshot with provenance, publication time and visibility. Publishing is outside the first pilot's browser controls.

## Public archive

Archive browsing does not require a Nebius key or a compute allowance. Cards contain only real saved records. Preserve mini graphs, model/harness labels, benchmark revision, accepted/rejected counts and historical notices. A source label distinguishes `Published local archive` from any later `Published hosted experiment`.

Do not relabel local Codex or other historical adapter results as Pi, E2B or Nemotron experiments. An empty archive shows `No published experiments yet` with an explanation of what a real baseline will contain. It never fills the graph with example results. Fixtures remain outside the production catalog.

Archive filters are filters over recorded evidence. The model dropdown in the new experiment form has a different source and purpose: it selects an eligible live provider model.

## Demo session and private ownership

Opening private experiment tools establishes an opaque signed session cookie. Use an HttpOnly cookie, Secure in hosted HTTPS, with an appropriate SameSite policy and explicit expiry. The cookie identifies a demo session, not a verified person or account. The browser receives no signing key or backend credential.

Every credential, campaign, private event read, control request and artifact download checks that session's ownership on the server. Unknown and unowned IDs receive the same safe not-found response. A key that happens to match another session's key does not grant access to that session's campaigns.

Show a short session label and expiry in setup. Explain that deleting browser session data or losing the session can remove access to private work because this pilot has no account recovery. Expiry does not erase execution ownership: the worker and reaper still stop or settle owned work safely. Public archive access remains available.

Rate limits, one active campaign per session and global admission limits supplement session ownership. The UI must not claim that a signed cookie prevents a person from creating another session.

## Nebius setup

Use one focused setup page within the existing dark interface. Explain the split before the key field: LoopBench supplies limited E2B compute; the user's Nebius account pays for model inference.

1. The user pastes a Nebius API key into a password field and selects `Connect Nebius key`.
2. The browser sends the key once over HTTPS to `POST /api/hosted/credentials` with session and same-origin protections. The input is transient browser memory only. Clear it after a completed submission; never save it in local/session storage, URLs, analytics or page state intended for persistence.
3. The backend uses the submitted credential for a bounded provider model-catalog authentication check. A successful response verifies that authentication request. It does not prove available account credit, quota or future inference success, and it does not send a paid test completion.
4. The backend encrypts an accepted credential outside browser-accessible state. Its encryption key stays outside the database. API responses contain an opaque credential reference, masked label, timestamps and status, never the secret or recoverable ciphertext. An invalid key returns a safe error without secret echo.
5. Show eligible models or a safe actionable error. The user can return to setup from a waiting campaign without losing its checkpoint.

| Setup state                          | User-facing result                                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| No credential                        | `Connect a Nebius key to start an experiment. You can browse published trees without one.`                      |
| Checking                             | Disable repeat submission and show `Checking connection and model availability...`                              |
| Connected                            | Show masked credential label, catalog timestamp and `Authentication checked. Inference credit is not verified.` |
| Invalid credential                   | `Nebius did not accept this key. Check or replace it.`                                                          |
| No eligible models                   | `No enabled NVIDIA chat models are available for this pilot.` Keep the setup page usable                        |
| Provider unavailable or rate limited | Retain the masked connection state and show `Model availability could not be checked. Retry later.`             |
| Credential revoked or removed        | Prevent new inference and checkpoint dependent work in `waiting` with reason `credential_revoked`               |
| Platform not ready                   | `Hosted execution is unavailable until operator setup is complete.` Published evidence stays accessible         |

Replacement is a server-side credential operation. A running campaign must never silently switch models. Revocation removes the ability to send new requests and revokes scoped gateway access; it does not erase bills or already returned evidence. Replacement for a checkpointed campaign requires an owner action and a new readiness check while retaining its immutable model ID.

Errors expose a stable error code and request/support ID when useful. Never render provider authorization headers, raw upstream bodies, encryption errors, secrets, hidden evaluator cases or internal filesystem paths. Treat model output and logs as untrusted text, never HTML or executable markup.

## Model and harness selection

`GET /api/hosted/models` returns a server-controlled eligible catalog for the connected credential. The server intersects the provider's current list with the operator's enabled model configuration, NVIDIA ownership, chat-generation capability and the Pi integration's required tool, JSON and stream support. The first pilot enables the intended Nemotron entries only. Do not accept a free-text model ID or a browser-supplied provider/base URL.

Display human label, exact provider model ID, current uncached input/output rates per million tokens, currency and price capture time. Default to the cheapest compatible enabled Nemotron for the review's stated input/output estimate. Compare uncached input cost plus estimated output cost, rather than sorting by input rate alone. If compatible prices tie, prefer `nvidia/Nemotron-3_5-Lightning` only when its required tool and JSON behavior has been verified. Do not automatically fall back to a larger or more expensive model.

A stale/unavailable catalog cannot silently select a different model. Recheck eligibility when starting or resuming; if the selected model disappears, show the specific provider/runtime waiting reason. A changed pricing snapshot updates the estimate and requires the owner to review and reconfirm future charges before new admission. It never migrates the campaign's selected model. Changing the target model starts a new lineage.

`GET /api/hosted/harnesses` initially returns the prepared Pi 1.4.0 harness. Show the actual pinned Pi version, template/build identifier and harness artifact digest. If the E2B template cannot establish that version, setup is unavailable until the operator prepares a reproducible template. Do not label a floating template as an actual Pi 1.4.0 run. Do not reinstall or alter the user's global Pi installation.

## New experiment

The form keeps the current catalog's compact controls but separates configuration from archive filtering. Use short help beside each field. The initial pilot exposes supported choices and explains fixed limits.

| Field                      | Initial value and behavior                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Name                       | Optional user label with a bounded length; the server supplies the campaign ID                                      |
| Nebius credential          | Masked owned reference; `Change connection` opens setup                                                             |
| Model                      | Cheapest compatible eligible Nemotron by the displayed estimate; exact ID and captured rates recorded at submission |
| Domain                     | `Coding`, fixed for the first pilot                                                                                 |
| Harness                    | Prepared Pi 1.4.0 artifact, fixed to an immutable initial digest                                                    |
| Benchmark                  | `coding-adversarial-v1`, six function contracts in clean workspaces; show revision/hash and evaluator identity      |
| Evolution                  | Adaptive 2-6 distinct sibling changes per round; no single-candidate round                                          |
| Beam width                 | `2`, pilot default                                                                                                  |
| User inference allowance   | Proposed default USD 0.20; operator ceiling USD 0.50 per campaign in the pilot; no automatic grant                  |
| Platform compute allowance | Proposed USD 5 for the entire campaign; users cannot increase the shared platform pool                              |
| Sandbox lifetime           | Proposed ten minutes per admitted attempt, provider-enforced                                                        |

The six initial contracts are `strict-csv`, `json-pointer-patch`, `exact-money-sum`, `weighted-lru`, `timezone-interval-union` and `dependency-layers`. The public task manifest fixes the permitted output at `src/solution.cjs`, public smoke-check command, source revision and trusted verifier identity. It does not expose hidden cases or expected answers.

A separately authorized one-task integration smoke run must carry a visible `Smoke test: one task` label and its actual subset manifest. It checks plumbing, not six-contract harness improvement. Do not give that subset the full suite's hash, denominator or acceptance claim.

The form says that setup, parent reruns, candidate attempts, independent verification, optimizer calls, tool turns, compaction and retries consume their respective allowances. A Pi process can make many inference requests. Admit a new sibling round only after reserving its conservative complete-round compute requirement. A round of 2-6 siblings can execute sequentially under the global concurrency limit; it still contains all admitted sibling proposals. If a new round cannot be admitted, checkpoint before its execution. Interrupted admitted rounds retain their pending siblings and outstanding reservations.

### Review before start

Show a concrete review panel before `Start experiment`:

- Selected model ID and initial Pi/harness artifact identity.
- Current uncached input/output price per million tokens, capture time and input/output assumptions behind the cheapest-model estimate.
- Benchmark name, six contract count, revision and independent evaluation method.
- Adaptive sibling range, beam width and task timeout.
- User inference allowance of USD 0.20 by default, or the edited amount within the USD 0.50 operator ceiling, billed by Nebius.
- Platform compute allowance of USD 5 for the whole campaign, subject to the remaining shared allowance and complete-round admission.
- Estimate coverage, pricing snapshot time and any unknown amount. An estimate is not a provider invoice guarantee.
- Private visibility and the fact that closing the browser does not cancel the job.

The user confirms this concrete budget when submitting. A later increase requires a separate review and explicit owner confirmation. Resume never grants money automatically, and a call count never substitutes for a dollar allowance. The platform USD 100 total ceiling has no automatic reset or top-up.

The user's Nebius account balance is not the campaign allowance. Adding USD 5 to that account does not set either a USD 5 inference campaign budget or an E2B compute budget. Inference allowance and price acceptance use their own reviewed request below; neither is hidden in Resume. Compute allowance changes remain operator-only and cannot raise the platform's total ceiling.

The server validates all selections again, checks ownership and readiness, and commits a durable campaign plus a deduplication key before returning its ID. Repeated submission after a timeout retrieves the same creation result. The API does not run an experiment inline with the browser request. If admission later cannot reserve resources, the worker records a waiting state.

After acceptance, navigate to `/experiments/[id]` immediately. Show `Queued` with the confirmed configuration. Do not claim a baseline, score or node until execution exists.

### Review later inference allowance or prices

The owner can select `Review inference allowance` from a checkpointed campaign. A price-change checkpoint also offers `Review updated prices`. Both open a concrete review showing the pinned model, old and current input/output rates per million tokens, price capture time, spent estimate, held/uncertain amounts, current limit and proposed new total limit. The review says what future charges the owner is accepting. It does not imply that Nebius account funds have been verified.

On confirmation, send `POST /api/hosted/campaigns/[id]/allowances` with `Idempotency-Key` and body fields `{schemaVersion, kind: "inference", newLimitUsdMicros, acceptedPricingSnapshotId, expectedRevision}`. The server validates ownership, current revision, the displayed pricing snapshot and the proposed limit, then commits an immutable approval/audit record and updated allowance transactionally. A repeated identical request returns the same durable result. A stale revision or changed pricing snapshot refreshes the review and requires a new owner confirmation.

The proposed inference ceiling is `500000` USD micro-units, or USD 0.50. A limit cannot be lower than the campaign's spent estimate plus outstanding held/uncertain obligations. A same-limit request can accept new prices without granting extra money. Existing obligations retain their original pricing basis and holds; accepting new prices applies to future admission. No automatic request increases the limit or accepts changed prices.

After approval, show the accepted total allowance and pricing snapshot, with a separate `Resume experiment` action. Approval does not resume work. Resume calls the normal control endpoint and rechecks readiness and remaining funds. The allowances endpoint accepts only inference changes; compute grants and reserve release remain operator-only.

## Live experiment workspace

Preserve the current page hierarchy: campaign header and controls, progress facts, Tree/Stats switch, horizontal graph, selected-node strip and detailed evidence below. Keep dark backgrounds, thin connectors, restrained status accents, visible sibling branches, zoom and keyboard navigation. Keep ancestor emphasis and recorded learning-source links.

The header always shows campaign lifecycle, selected model, pinned Pi version, benchmark level and ownership/private status. Its lifecycle is separate from the selected node's measured verdict. The progress panel shows round, proposed siblings, executed siblings, task attempts completed, pending verification and the selection reason.

### Hypotheses and nodes

Display raw proposed hypotheses in a `Round N hypotheses` text list as soon as persisted. Label each `Proposed`, `Waiting to execute`, `Executing`, `Measured` or `Execution failed`. These are text records, not placeholder graph nodes. Do not prefill score, accepted status, delta or evidence links.

Add a graph node only when the worker records that harness version's actual evaluation execution. A running node shows `0/6 tasks verified` or the current verified count, with no inferred score. It may later retain failure or partial evidence. If sandbox creation is uncertain before execution can be established, show the operation's reconciliation in campaign details rather than inventing a measured node.

Each harness version has multiple task attempts. Parent reruns, retries, verifier environments and E2B sandbox snapshots belong in the evidence panel. They do not add branches to the harness ancestry graph. Within one benchmark hash, show only measured paired deltas from the candidate and its parent rerun. A failed infrastructure operation has no score of zero and cannot create a positive delta.

At a harder curriculum level, preserve the unchanged champion as a visibly labeled challenge checkpoint/new baseline. Give it the new suite hash and level, and no cross-suite delta. Keep earlier levels visible. A challenge edge says `Harder benchmark`; it is not a learned harness upgrade.

### Evidence panel

Selecting a real node shows hypothesis, approved harness diff, artifact digest, parent, learning citations, benchmark hash, score if valid, paired comparison and verification status. A task table shows clean task identity, executor/verifier status, submitted file/diff artifact, public tool trace, bounded diagnostics and timing.

Separate `Agent reported checks` from `Independent verifier result`. Agent-written tests or success messages are not acceptance evidence. Only the worker's canonical submitted file reaches a fresh trusted verifier; hidden grader material remains outside agent artifacts and browser exports.

Artifacts are authorized through `/api/hosted/artifacts/[id]`. Show safe text previews and downloads with size/type metadata. Never expose an E2B access token, Nebius key, gateway token, Pi auth/session secret or unrestricted provider log. Keep rejected and failed artifacts with their true labels.

## Lifecycle, verdict and control feedback

Campaign lifecycle reports whether work can proceed. Node verdict reports an executed comparison. The UI must render both without collapsing one into the other. The canonical campaign lifecycle uses one `waiting` state plus `waitReason`; screen labels explain that reason. `Preparing` is an attempt phase shown under the running campaign.

| Campaign lifecycle | Visible message and behavior                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `queued`           | `Queued for execution`; configuration is saved, no execution claim                                                         |
| `running`          | Show actual preparation/task/verification/round progress from persisted events                                             |
| `waiting`          | Show `Waiting for compute`, `Waiting for inference`, `Waiting for provider` or the specific recovery/operator reason below |
| `pausing`          | `Pause requested. Finishing the admitted checkpoint.` No new task admission                                                |
| `paused`           | `Paused at a saved checkpoint`; show what remains and the allowed Resume/Stop controls                                     |
| `stopping`         | `Stopping. Revoking inference access and confirming sandbox cleanup.` No new calls or sandbox admission                    |
| `stopped`          | `Stopped. Evidence retained.` Terminal for this campaign; label any pending reconciliation separately                      |
| `failed`           | `Experiment failed`; show safe cause, retained evidence and cleanup/reconciliation status                                  |
| `completed`        | `Requested finite experiment work completed`; evidence decides whether a harness improved                                  |

| `waitReason`                            | Screen label and recovery                                                                                         |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `compute_budget`                        | `Waiting for compute allowance. Checkpoint saved.` No user control to increase the shared platform pool           |
| `global_capacity`                       | `Waiting for compute capacity. Both execution slots are in use.` Safe scheduling can continue when a slot is free |
| `inference_budget`                      | `Waiting for inference allowance. Checkpoint saved.` Offer explicit allowance review within operator limits       |
| `provider_quota`                        | `Waiting for provider quota. Checkpoint saved.` Show safe retry eligibility                                       |
| `provider_auth` or `credential_revoked` | `Waiting for inference connection.` Link to owned credential repair                                               |
| `pricing_unavailable`                   | `Waiting for verified pricing.` Block new paid admission                                                          |
| `reconciliation`                        | `Reconciling provider state.` Retain reservations and do not blindly recreate work                                |
| `runtime_unavailable`                   | `Waiting for the selected model or prepared runtime.` Operator readiness must be restored                         |
| `challenge_required`                    | `A harder benchmark is required.` Preserve the solved suite and its evidence                                      |
| `operator_hold`                         | `Hosted execution is on hold.` Show safe operator explanation                                                     |

Temporary slot waiting and provider recovery do not require extra spending authorization. The worker may retry only known safe scheduling/reconciliation operations under already confirmed policy. A provider access, allowance or credential checkpoint requires an explicit owner resume after repair. Ambiguous paid operations retain their reservations and cannot be retried as if they never happened.

A continuous campaign never becomes `completed` because it reaches 100% on one suite or exhausts its allowance. It checkpoints or advances the unchanged champion to a harder suite when admitted. `completed` is available only to an explicitly finite campaign that finishes its requested work. Queue jobs have their own `queued`, `leased`, `running`, `waiting`, `completed`, `cancelled` and `failed` states; a job's completion does not imply a measured harness improvement or a completed continuous campaign.

| Node measurement          | Meaning                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| Pending/running execution | No final verdict or score yet; show verified-task progress                               |
| `baseline`                | Measured starting point or unchanged harness on a new challenge suite                    |
| `accepted`                | Candidate improved its paired task pass rate on the same suite/model                     |
| `rejected`                | Measured tie or regression; evidence remains available                                   |
| `failed`                  | Execution/evaluation failed; show the cause and partial evidence, not a fabricated score |

`Pause` requests a checkpoint after the currently admitted bounded task work, including its verifier, settles. It does not promise suspension of Pi process memory. The worker starts no further task or sibling. `Resume` revalidates ownership, credential/model availability, unchanged configuration, outstanding reservations and operator limits, then continues pending work from clean task state. A new attempt has a new attempt ID and retains the interrupted attempt record.

`Stop` requests cancellation, revokes scoped inference tokens and terminates owned environments. Show a confirmation with the concrete active campaign name and the fact that evidence and already incurred costs remain. A control request returns its durable acknowledgement; the page must not show `paused` or `stopped` solely because the button returned success. Controls send `Idempotency-Key` and `expectedRevision`, and display the recorded request status. A stale revision refreshes the review state instead of applying an outdated command.

Worker cleanup/accounting status is independent of terminal campaign lifecycle. For example, `Stopped; confirming provider expiry` can coexist with an outstanding reservation. Show that plainly and retain the allowance hold. Do not offer a terminal campaign resume; starting another campaign creates a new reviewed job.

## Compute and inference display

Keep two labeled accounting sections. Do not add compute and inference into a single apparently exact total.

| Platform E2B compute                                                                        | User Nebius inference                                                             |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Shared platform ceiling USD 100 across users and campaigns, durable across restarts         | Owner-confirmed campaign allowance, default USD 0.20 and initial ceiling USD 0.50 |
| Proposed operational admission allowance USD 90; USD 10 held for uncertainty/reconciliation | Every actual optimizer/Pi/tool/compaction/retry request is accounted for          |
| Proposed USD 5 whole-campaign allowance; setup and verifier sandboxes count                 | Allowance enforced by the gateway using timestamped pricing and reservations      |
| At most two active sandboxes globally, including setup and verification                     | Provider credit/quota remains separate from LoopBench's local allowance           |
| Ten-minute initial provider-enforced lifetime per admitted attempt                          | Interrupted/unknown usage retains a conservative hold                             |

For each section show `Settled estimate`, `Reserved`, `Uncertain hold` and `Available to admit`. A reservation's amount is counted once; an uncertain hold is a retained reservation, not an extra charge. When some usage is unknown, show `Partial estimate` with the known subtotal and outstanding hold. Unknown is never USD 0.00. Report token counts/cache usage only when returned, and claim cache savings only from measured data.

Platform spending displays may summarize remaining admission availability without exposing other users' campaigns. The operator must separately verify the actual E2B account spending limit, scope and enforcement behavior before enabling paid work. UI estimates cannot guarantee an invoice cap or prove introductory credit remains.

## Refresh, reconnect and recovery

The first release polls `GET /api/hosted/campaigns/[id]/events?after=<cursor>` every two seconds while visible. Events are durable, ordered within the campaign and owned by the session. The response includes the next cursor. Apply events once by event ID and refresh the campaign's authorized projection when a revision changes. Initial load reads the durable snapshot and its cursor consistently, so the first poll neither skips nor invents state.

After a network failure keep the last verified view visible and show `Live updates interrupted. Reconnecting...` with its last-update time. A stale browser connection does not pause the worker or change measured results. Refetch on visibility restoration. If the cursor is no longer retained, fetch a fresh snapshot and cursor; do not interpret a missing event as success.

Closing the page does not stop the campaign. Reopening the owner URL restores the durable state, proposals, real nodes, artifacts and cursor. A worker restart first reconciles existing sandbox creation intents and active leases. The page may show `Reconciling provider state` as a recovery phase; it must not report a new experiment, free retry or released credit before reconciliation.

SSE can be added later over the same persisted event cursor. It is not required for the first pilot and is never the source of truth.

## Accessibility and narrow screens

Keep graph keyboard selection, visible focus, status text and symbols in addition to color. Update a polite status region for lifecycle changes and completed verification, not every token. The selected record must remain readable outside SVG, and hypotheses/artifacts use text with wrapping and bounded previews.

On narrow screens stack configuration and budget sections, keep controls reachable, and preserve the horizontal graph's scrolling with Root, Current head and Fit all. Provide the task/record list as an alternate way to select real nodes. Do not shrink the entire graph until labels are unreadable or auto-scroll away from a node the user is inspecting.

## Review and acceptance scenarios

These are planned acceptance checks, not claims that the hosted feature passes today.

1. A visitor without a key opens a real published historical tree. No private campaign, key prompt or paid call is needed.
2. A connected session sees only its owned credential descriptors and campaigns. Another session cannot fetch the campaign, events, controls or artifacts by guessing its ID.
3. Setup checks authentication/catalog availability without a paid completion. No key persists in browser storage or appears in API responses, logs or graph exports.
4. New experiment offers only enabled eligible NVIDIA models from the server catalog. A manipulated model ID/provider URL is refused, and optimizer/executor record the same selected Nemotron model.
5. Start shows concrete allowances, commits one campaign despite a duplicate click/reconnect, and displays queued state without fake nodes.
6. A raw proposal appears in the hypotheses list. Its graph node appears only after actual execution, and a failed attempt does not become an accepted or zero-scored result.
7. At least two real sibling artifacts survive a small live pilot. Parent/candidate comparisons use the same suite/model, and a challenge checkpoint has no cross-suite improvement delta.
8. With both global slots occupied, additional work waits. Setup/verifier environments count, and sequential siblings retain the round's 2-6 width.
9. Insufficient compute, inference allowance, invalid credentials, provider quota, interrupted usage and ambiguous sandbox creation all show their specific checkpoints with retained evidence and holds.
10. Pause, resume and stop reflect durable worker acknowledgement; page close/reopen restores the campaign. Stop or crash recovery leaves no unowned sandbox and does not release an unconfirmed reservation.
11. Known and unknown costs remain distinct. No automatic allowance grant occurs on retry/resume, and the shared platform USD 100 ceiling does not reset per campaign or user.
12. An owned allowance/price review uses the dedicated endpoint, revision and idempotency key. It refuses an amount over USD 0.50 or below spent plus holds, permits same-limit price acceptance, and leaves the campaign checkpointed until a separate Resume action.
