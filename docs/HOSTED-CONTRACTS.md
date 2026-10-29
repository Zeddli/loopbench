# Hosted data and API contracts

Status: proposed reference for implementation review, dated 2026-10-27. This document does not describe a completed hosted integration. It authorizes no deployment, sandbox creation, template build, provider request, secret change, package installation, or paid operation.

The governing design is [Hosted Pi evolution with E2B and Nebius Token Factory](superpowers/specs/2026-10-27-e2b-pi-design.md). This reference defines its persistent records, ownership rules, HTTP contracts, accounting rules, recovery states, and acceptance assertions. The overall implementation sequence belongs in the implementation plan. Provider-specific execution details belong in the architecture and runtime design.

## 1. Current implementation and proposed boundary

| Concern         | Present repository behavior                                                                                                                | Proposed hosted contract                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persistence     | `core/types.ts` defines local node and campaign records. `core/campaigns.ts` persists campaign JSON and uses a file lock.                  | SQLite on persistent disk stores hosted sessions, credentials, jobs, attempts, intents, reservations, events, and artifact metadata.                                         |
| Evaluation      | `core/runner.ts` reruns the parent for each task before the candidate and computes a paired pass-rate delta.                               | Preserve paired evaluation semantics. Replace the execution boundary with independent Pi task environments and a fresh trusted verifier.                                     |
| Accounting      | Campaign calls have `reserved`, `completed`, or `failed` status and nullable floating-point USD values. One adapter call is a coarse unit. | Distinguish every actual inference request from task attempts. Use integer money, durable reservations, explicit unknown usage, and separate compute and inference accounts. |
| Identity        | Legacy tree and campaign GET routes read local global stores.                                                                              | New `/api/hosted/*` routes enforce an explicit owner scope. Published snapshots use a separate sanitized read path.                                                          |
| Worker lifetime | Current evolution runs in-process and uses local campaign controls.                                                                        | A persistent worker claims durable jobs. Browser disconnects and request cancellation do not own campaign execution.                                                         |
| E2B and gateway | No claim of a working integration follows from the local types.                                                                            | Creation intents, scoped inference tokens, reaper recovery, and gateway metering are new work.                                                                               |

All entities, route schemas, indexes, status values, defaults, limits, and assertions below are proposed unless a statement explicitly identifies current behavior. Do not change the legacy JSON schema in place to make it appear hosted. Use an explicit compatibility adapter at the evidence boundary.

The planned server-only implementation root is `hosted/`. Proposed contract modules include `hosted/contracts.ts`, `hosted/storage/`, `hosted/services/`, `hosted/worker/`, `hosted/providers/`, and `hosted/gateway/`. These paths are responsibilities for later implementation, not files created by this document.

## 2. Contract conventions

### 2.1 Identifiers, timestamps, versions, and hashes

| Type            | Contract                                                                                                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Uuid`          | Canonical lowercase UUID string. All new entity IDs use UUIDs, including sessions, campaigns, jobs, versions, attempts, intents, calls, accounts, reservations, events, and artifacts. Provider-assigned sandbox IDs remain opaque provider strings. |
| `OwnerScope`    | Server-generated UUID that identifies a pilot browser session's private namespace. It is never accepted from a browser body or query parameter.                                                                                                      |
| `Instant`       | UTC RFC 3339 timestamp with millisecond precision in DTOs. SQLite stores integer UTC epoch milliseconds.                                                                                                                                             |
| `Revision`      | Positive safe integer used for optimistic concurrency on a mutable record. Each state mutation increments the revision.                                                                                                                              |
| `Cursor`        | Opaque versioned encoding of a campaign UUID and nonnegative event sequence. Clients store and return it without interpreting it.                                                                                                                    |
| `Sha256`        | Lowercase 64-character hex digest over canonical bytes. The contract specifies the serialization version whenever it hashes structured data.                                                                                                         |
| `UsdMicros`     | Nonnegative signed-64-bit integer count of one-millionth USD. SQLite uses `INTEGER`; DTOs use a base-10 string with no sign, exponent, separators, or decimal point.                                                                                 |
| `DurationMs`    | Nonnegative safe integer duration. Provider lifetime admission rounds to the provider's billable interval conservatively.                                                                                                                            |
| `SchemaVersion` | Explicit positive integer on durable JSON payloads, API envelopes, event payloads, and published snapshots. The initial hosted version is `1`.                                                                                                       |

IDs are distinct from authorization. Knowledge of a campaign, event, artifact, or credential UUID confers no access. Existing historical lineage IDs may use the legacy format in `core/types.ts`; hosted imports retain an `archiveRef` instead of treating those values as hosted UUIDs.

JSON rejects unknown fields at mutation boundaries. Text fields have explicit length limits. Collections have bounded lengths. The server normalizes strings before hashing, admission, or idempotency comparison. A DTO never contains a database path, encryption value, provider secret, raw gateway token, sandbox controller token, hidden test case, or hidden expected answer.

### 2.2 API envelope

Successful JSON responses contain `schemaVersion`, `requestId`, and `data`. Collection `data` contains `items` and `nextCursor`. A mutation also returns the authoritative record revision and, where applicable, an asynchronous job reference. Binary artifact responses use their own transport contract. Campaign event SSE is deferred beyond the first release.

The common error envelope contains the following fields.

| Field                | Type                         | Meaning                                                                                                                                 |
| -------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`      | `1`                          | Contract version.                                                                                                                       |
| `requestId`          | `Uuid`                       | Server-generated correlation ID.                                                                                                        |
| `error.code`         | Stable enum string           | Machine-readable error category from section 12.                                                                                        |
| `error.message`      | Bounded string               | Sanitized explanation safe for the caller.                                                                                              |
| `error.retryable`    | Boolean                      | Whether the same operation may succeed after the stated condition changes. This never authorizes blind replay of an external operation. |
| `error.details`      | Allowlisted object or `null` | Field paths, current revision, wait reason, or safe limit information. No arbitrary provider error body.                                |
| `error.retryAfterMs` | Safe integer or `null`       | Suggested delay when a retry is meaningful.                                                                                             |

Every private response uses `Cache-Control: no-store`. Shared caching of a private GET, SSE stream, or artifact is prohibited. Public snapshots have their own explicit cache policy and content digest.

### 2.3 Ownership queries

Every private table has `owner_scope`, including child tables that could derive it through a campaign. Each repository method requires an `OwnerScope` or a distinct internal service context. A raw UUID lookup is not an owner authorization check.

The testable lookup contract is `WHERE id = :id AND owner_scope = :owner_scope`. A child lookup also checks its campaign relationship and owner scope. Lists include `WHERE owner_scope = :owner_scope` before pagination. Updates and deletes include the same predicate and the expected revision. Nested foreign keys use owner scope with their referenced IDs so a child cannot refer to a different session's parent.

A job lease authorizes internal worker operations on exactly the job's persisted campaign and owner scope. The worker derives that scope from the claimed job, then includes it in every query. It does not borrow a browser cookie. A platform maintenance context is a separate internal capability with explicit operations and an audit record. It is not an unscoped default repository method.

For an unauthenticated, expired, unknown, or wrong-owner private identifier, return the same `404 NOT_FOUND` shape. An owned campaign whose credential expired can return a visible waiting reason. The API must not reveal whether another session owns the referenced credential or campaign.

## 3. Identity and credential contracts

### 3.1 `Session`

The pilot uses a signed opaque browser-session cookie. This is possession-based browser continuity, not verified account login or human identity. Losing the cookie does not establish a right to recover someone else's private records.

| Field                                                    | Persistent contract                                                                            |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `id`, `owner_scope`                                      | Independent UUIDs. `owner_scope` is unique and immutable.                                      |
| `token_digest`                                           | Digest of a random opaque session token. The database never stores the browser's usable token. |
| `signing_key_id`                                         | Key identifier for cookie-signature rotation. No signing secret in SQLite.                     |
| `status`                                                 | `active`, `revoked`, or `expired`.                                                             |
| `created_at`, `last_seen_at`, `expires_at`, `revoked_at` | Millisecond timestamps. `revoked_at` is nullable.                                              |
| `revision`                                               | Optimistic record version.                                                                     |

Production cookies are `HttpOnly`, `Secure`, and `SameSite=Lax`, scoped to the application origin and root path. Cookie naming, signing, duration, and rotation become operator configuration with tests. Local HTTP development has a documented development-only cookie configuration. It cannot silently disable production HTTPS requirements.

Session expiration blocks new browser operations. A worker already holding an admitted job may retain access to its encrypted credential reference until that job reaches a permitted checkpoint, subject to credential revocation and campaign controls. Session expiry does not orphan live sandboxes or erase budget obligations. Revoking the session explicitly requests stop for all its nonterminal campaigns and revokes its gateway grants.

Admission still applies platform concurrency limits, one active campaign per owner scope, per-session limits, credential-fingerprint limits, and IP rate limits. A session cookie is not an anti-abuse proof. Store IP rate-limit keys as operator-keyed hashes with bounded retention. Do not publish them.

### 3.2 `Credential`

| Field                                                         | Persistent contract                                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `owner_scope`                                           | UUID and owning scope.                                                                                                                |
| `provider`                                                    | Initially `nebius-token-factory`.                                                                                                     |
| `label`                                                       | User-visible bounded label without secret material.                                                                                   |
| `secret_ciphertext`, `nonce`, `auth_tag`, `encryption_key_id` | Authenticated encryption envelope. Encryption keys live outside SQLite.                                                               |
| `fingerprint`                                                 | Operator-keyed digest for duplicate detection and cross-session abuse controls. Never use a reversible key prefix as the fingerprint. |
| `display_hint`                                                | Allowlisted masked display text. Full keys and usable prefixes are excluded.                                                          |
| `status`                                                      | `unverified`, `verified`, `invalid`, `revoked`, or `unavailable`.                                                                     |
| `verified_at`, `last_checked_at`, `revoked_at`                | Nullable timestamps.                                                                                                                  |
| `verification_error_code`                                     | Safe provider category or `null`.                                                                                                     |
| `created_at`, `updated_at`, `revision`                        | Mutable-record metadata.                                                                                                              |

Verification performs an authenticated server-side verbose models request against the configured Token Factory origin. A verified key proves authentication at a time. It does not prove positive balance, inference access for every model, absence of quotas, or successful future requests. The user's planned USD 5 top-up concerns their Nebius Token Factory account; it is not a confirmed balance. It is separate from the proposed USD 5 campaign compute limit funded by LoopBench. It does not authorize a campaign to spend USD 5 on inference. Unless a supported response actually establishes remaining balance, record `balanceStatus = unknown`, with no invented zero or assumed USD 5 available balance. A user-provided dashboard screenshot is a dated external observation, not an automatic API balance result or allowance grant.

Revocation immediately prevents new upstream requests and new grants. Existing in-flight calls remain accounting obligations. Revocation requests stop or waiting status for dependent campaigns and gateway-token revocation without deleting evidence. Physical secret deletion follows a policy that preserves ledger records. Deleted or revoked keys never become an implicit fallback to a platform inference key.

`CredentialDTO` contains `id`, `provider`, `label`, `displayHint`, `status`, `verifiedAt`, `lastCheckedAt`, `createdAt`, `updatedAt`, and `revision`. It omits encryption fields, fingerprint, and the submitted secret. Creation returns the masked DTO once verification finishes or an asynchronous verification reference if the implementation later chooses that mode. The first pilot uses bounded synchronous verification and records the outcome.

## 4. Experiment records

### 4.1 `Campaign`

One campaign owns a search history, pinned runtime configuration, a credential reference, compute and inference accounts, and one active orchestration job. A tree node is a `HarnessVersion`. Sandboxes and individual inference calls never become graph nodes.

| Field group | Persistent fields and invariant                                                                                                                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity    | `id`, `owner_scope`, `created_at`, `updated_at`, `revision`.                                                                                                                                                                                                     |
| Visibility  | `visibility = private` for the pilot's live record. Publication creates a sanitized immutable snapshot; it does not flip this row to public.                                                                                                                     |
| Runtime     | `adapter_id = pi-e2b`, exact `model_id`, `proposer_model_id`, `provider_origin_id`, `pi_version`, `node_version`, `template_build_id`, `runtime_manifest_hash`, `network_policy_hash`. These values are pinned before an evaluated attempt.                      |
| Benchmark   | `benchmark_id`, `benchmark_hash`, `benchmark_manifest_hash`, `verifier_revision`, `curriculum_revision`, `curriculum_level`. Filesystem paths and hidden content are internal.                                                                                   |
| Search      | `root_harness_version_id`, `active_harness_version_id`, `round_number`, `completed_rounds`, `requested_rounds`, `branches`, `beam_width`, `max_candidates`, `max_task_attempts`, `max_provider_calls`. All caps are bounded integers. `branches` is 2 through 6. |
| Financial   | `compute_account_id`, `inference_account_id`, `credential_id`, `accepted_pricing_snapshot_id`, `pricing_consent_revision`. Credential owner must equal campaign owner. Compute and inference accounts cannot be exchanged. Consent is explicit and versioned.    |
| Lifecycle   | `status`, `wait_reason`, `desired_control`, `control_revision`, `checkpoint`, `started_at`, `completed_at`, `last_error_code`, `last_error_message`.                                                                                                             |
| Provenance  | `source = hosted`, optional `archive_ref`, `config_hash`, and initial request digest. An imported archive reference does not confer permission to execute or access its private artifacts.                                                                       |

The planned `maxProviderCalls` cap counts every gateway upstream transmission, including optimizer turns, Pi turns, compaction, and explicit retries. The planned `maxTaskAttempts` cap counts admitted Pi task invocations. Neither is a monetary budget. A display of the old `maxCalls` field must label it as legacy adapter-call accounting.

The first campaign compute allowance is a proposed USD 5 for the entire campaign, or `5000000` USD micro-units. This revises the design's earlier USD 1 proposal so a six-contract round with up to six sibling candidates can fit a conservative illustrative compute envelope. It is a disclosed implementation default, not a new user-specified ceiling. It is not USD 5 per proposal, sibling, task, or model request. Campaign creation cannot raise this allowance. Operator policy may later change the default for new campaigns without changing the platform's total USD 100 ceiling. Actual template resources, rates, and required setup costs must pass preflight.

### 4.2 `HarnessVersion`

`HarnessVersion` is the canonical hosted graph node. Its content and provenance become immutable before evaluation. Its evaluation status is mutable only through fenced worker transactions.

| Field group       | Persistent fields and invariant                                                                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity          | `id`, `owner_scope`, `campaign_id`, `parent_id`, `created_at`, `revision`. Parent and child have the same owner and campaign. Root has a null parent.                                                                         |
| Round             | `round_number`, `sibling_index`, `proposal_set_id`. Nonroot candidates belong to one complete 2-6-sibling proposal set sharing one eligible parent.                                                                           |
| Content           | `content_artifact_id`, `content_hash`, `policy_schema_version`, `prompt_hash`, `skills_manifest_hash`, `allowed_config_hash`. Content includes only approved instruction, skill, and configuration fields.                    |
| Learning          | `hypothesis`, `learned_from_ids`, `diagnosis`, `change`, `prediction`, `proposer_model_id`, `proposal_provider_call_ids`, `evidence_digest_hash`. Learned-from IDs must exist in the allowed evidence set.                    |
| Pinned evaluation | `model_id`, `benchmark_hash`, `verifier_revision`, `runtime_manifest_hash`, `comparison_context_hash`.                                                                                                                        |
| Outcome           | `status`, `total_tasks`, `completed_tasks`, `passed_tasks`, `score_numerator`, `score_denominator`, `comparison_id`, `failure_kind`, `completed_at`. A partial or infrastructure-failed version has no accepted paired score. |

Content hash equality means the same candidate content. Distinct sibling hypotheses alone do not establish distinct changes. A proposal set rejects duplicate normalized content hashes and invalid references before any candidate task environment is created. The optimizer does not receive hidden tests or expected answers while producing these fields.

Proposed `HarnessVersion.status` values are `proposed`, `evaluating`, `baseline`, `accepted`, `rejected`, `failed`, and `cancelled`. `accepted` requires complete independently verified paired results and a strictly positive delta. A valid nonpositive delta is `rejected`. `failed` records an infrastructure, protocol, integrity, or reproducibility failure rather than a fabricated low score.

The recorded score is an exact fraction of passed tasks over required tasks. A DTO may include the derived numeric `score` for visualization. Acceptance compares integer pass counts on the same required task set. It does not depend on rounded display percentages.

### 4.3 Paired comparison identity

A comparison has a UUID, target candidate version, parent version, immutable context hash, required ordered task IDs, and status. It records both fresh parent results and candidate results. A historical parent's old score is evidence for selection, not a replacement for the fresh paired run. A one-task smoke run uses an explicitly separate task-subset manifest, hash, and denominator. It cannot claim completion of the six-contract suite or inherit that suite's score label.

The context hash covers the benchmark manifest and task hashes, grader revision, model ID, Pi and Node versions, prepared environment identifier, network policy, allowed resource limits, and comparison protocol revision. Parent instructions remain the parent's recorded instructions. Candidate instructions remain the candidate's recorded instructions. Runtime or model changes invalidate the comparison instead of silently creating a gain.

Each candidate has its own fresh parent rerun for every task, matching the present runner's semantics. Sharing one parent's task results across siblings is a future experiment-design change and is outside this pilot contract. Parent and candidate runs start from identical clean task repositories. A task never inherits a previous task's solution or runtime state.

If the campaign advances its curriculum, create a `challenge` baseline under an explicit transition record. Preserve the champion's instructions and settings. Scores across benchmark hashes do not produce an improvement edge. The graph can show ancestry and suite transitions without presenting incomparable percentages as a paired gain.

### 4.4 `TaskAttempt`

One attempt is one admitted Pi execution for one public benchmark task and one harness configuration. A retry is a new record with an explicit link to its predecessor. An attempt can include many provider calls and an independently metered verifier environment.

| Field group  | Persistent fields and invariant                                                                                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity     | `id`, `owner_scope`, `campaign_id`, `harness_version_id`, `comparison_id`, `comparison_harness_version_id`, `task_id`, `attempt_number`, `retry_of_id`, `created_at`, `updated_at`, `revision`. |
| Role         | `role = baseline`, `parent`, `candidate`, or `challenge`. A parent rerun references the real parent in `harness_version_id` and the compared child in `comparison_harness_version_id`.          |
| Reproduction | `task_manifest_hash`, `benchmark_hash`, `verifier_revision`, `comparison_context_hash`, `runtime_manifest_hash`, `harness_content_hash`.                                                        |
| Execution    | `status`, `phase`, `job_id`, `lease_fence`, `agent_sandbox_intent_id`, `verifier_sandbox_intent_id`, `provider_process_id`, `last_provider_cursor`, `last_durable_log_offset`.                  |
| Limits       | Admitted timeout, output-byte cap, artifact-byte cap, tool-turn cap, total-provider-call cap, and gateway grant reference.                                                                      |
| Result       | `verdict`, `failure_kind`, `public_check_summary`, `trusted_verifier_summary`, `submitted_artifact_id`, `verifier_result_artifact_id`, `started_at`, `settled_at`, `completed_at`.              |

`verdict` is `pass`, `fail`, or `null`. Null means there is no valid benchmark judgment. Infrastructure errors, lost process state, malformed adapter output, unconfirmed cleanup, and budget waits are separate reasons. The parent and candidate pair requires a valid judgment for every required task before computing a delta.

`agent_settled` and runner completion both establish agent completion. Neither establishes benchmark success. The fresh verifier supplies the verdict. A Pi-reported success or agent-visible smoke-test result remains advisory evidence.

## 5. Durable jobs and external operation records

### 5.1 `Job`

| Field                                                            | Persistent contract                                                                                                               |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `owner_scope`, `campaign_id`                               | Immutable UUID relationships.                                                                                                     |
| `kind`                                                           | `campaign_run`, `campaign_reconcile`, or `campaign_cleanup`. Credential verification remains bounded API work in the first pilot. |
| `state`                                                          | `queued`, `leased`, `running`, `waiting`, `completed`, `cancelled`, or `failed`.                                                  |
| `payload_version`, `payload_json`                                | Small validated payload containing IDs and control parameters. No keys, tokens, prompts, hidden tests, or binary artifacts.       |
| `available_at`, `created_at`, `updated_at`                       | Scheduling metadata.                                                                                                              |
| `lease_owner`, `lease_fence`, `lease_expires_at`, `heartbeat_at` | Fenced worker ownership. `lease_fence` increases on every successful claim or takeover.                                           |
| `attempt_count`, `max_attempts`                                  | Orchestration recovery attempts. Increasing this count does not authorize replay of an external create or provider request.       |
| `checkpoint_json`, `checkpoint_version`                          | IDs and durable progress sufficient to reconcile existing work.                                                                   |
| `last_error_code`, `last_error_message`, `revision`              | Sanitized diagnostic metadata.                                                                                                    |

At most one unfinished `campaign_run` job exists per campaign. A queued job is created in the same transaction as the campaign and admission response. The HTTP handler returns before the worker executes Pi or starts evolution. The worker does not depend on Next.js request lifetime, SSE connectivity, or an in-memory promise.

A worker mutates a campaign, attempt, intent, or job only when the matching job ID, lease owner, current fence, and unexpired lease still hold. Every checkpoint transaction checks that condition. A stale worker cannot commit a final verdict, release a reservation, issue a new grant, or create the next external operation.

Lease loss does not prove an external operation stopped. The next worker enters reconciliation, lists persisted intents and provider-call obligations, and recovers or terminates them before any replacement operation. A stale worker might still have an in-flight network request. The creation-intent and gateway contracts account for that uncertainty.

The proposed initial worker lease is 60 seconds. The active worker heartbeats every 15 seconds. The independent reaper scans every 15 seconds, with bounded work per scan. Database time and persisted expiry decide claimability. A timer callback alone never proves ownership. Each admitted sandbox has a provider-enforced lifetime of at most 600 seconds before a separately budgeted extension. These are initial operator defaults, not provider guarantees or permission to run longer after lease loss.

### 5.2 `SandboxIntent`

Commit an intent before every billable setup, agent, or verifier create. The intent UUID is the provider-discoverable creation identity. Logical task identity and E2B sandbox identity are different fields.

| Field group      | Persistent fields and invariant                                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity         | `id`, `owner_scope`, `campaign_id`, nullable `task_attempt_id`, `purpose`, `logical_slot_key`. `purpose` is `setup`, `agent`, or `verifier`.                                |
| Ownership        | `job_id`, `issued_fence`, `current_fence`, `worker_lease_owner`. Creation binds to one persisted fence and logical slot.                                                    |
| Provider request | `provider = e2b`, `template_build_id`, nullable `snapshot_id`, `resource_profile_id`, `request_hash`, `metadata_version`.                                                   |
| Reservation      | `reservation_id`, `pricing_snapshot_id`, `reserved_lifetime_ms`, `provider_timeout_ms`, `conservative_expires_at`, `estimated_max_usd_micros`.                              |
| Result           | `state`, nullable `provider_sandbox_id`, nullable `provider_process_id`, `create_requested_at`, `create_responded_at`, `last_observed_at`, `stopped_at`, `last_error_code`. |
| Reconciliation   | `provider_metadata_intent_id`, `termination_requested_at`, `uncertainty_reason`, `reconciled_at`, `revision`.                                                               |

Metadata contains the intent UUID, campaign UUID, attempt UUID where present, purpose, and application installation ID. It excludes credentials, public-session tokens, task text, hidden cases, and human identity. The application must verify that the selected E2B API can discover these values before enabling execution.

The first version creates siblings separately from the same prepared immutable template or snapshot. A separate intent and reservation covers every child. Batch fork operations remain deferred until per-child attribution, partial failure, retry behavior, and discovery are verified.

Creation is a non-idempotent provider action unless the selected provider documents and proves a stronger guarantee. The application intent UUID is not a claim that E2B itself deduplicates create requests. Disable automatic SDK or transport retries for ambiguous creates, or use a bounded no-retry request path. An uncertain response retains the entire reservation and blocks a second create for that logical slot. Persist the confirmed sandbox ID, process ID, event cursor, timeout, and reservation association before presenting the task as started. A response accepted by the provider without that durable state remains a recovery obligation.

A lifetime extension creates a separately admitted reservation with its own operation key before the extension request. The attempt's aggregate conservative expiry moves only after the extension is known or conservatively treated as applied. An uncertain extension keeps its reservation. No heartbeat extends a sandbox for free.

### 5.3 `ProviderCall`

One row describes one attempted transmission to Token Factory. Pi tool turns, compaction calls, optimizer calls, and explicit retries all create separate rows. A task's adapter response is not the only metering event.

| Field group  | Persistent fields and invariant                                                                                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity     | `id`, `owner_scope`, `campaign_id`, nullable `task_attempt_id`, `purpose`, `logical_request_id`, `retry_of_id`.                                                                               |
| Authority    | `credential_id`, nullable `gateway_grant_id`, `job_id`, `lease_fence`, exact `model_id`, fixed `provider_origin_id`.                                                                          |
| Bound        | `request_digest`, `pricing_snapshot_id`, `maximum_input_tokens`, `maximum_output_tokens`, `maximum_usd_micros`, `reservation_id`, `request_deadline_at`.                                      |
| Transmission | `state`, `transmission_started_at`, `provider_request_id`, `http_status`, `response_headers_at`, `completed_at`.                                                                              |
| Usage        | Nullable `input_tokens`, `output_tokens`, `cached_input_tokens`, `reasoning_output_tokens`, `usage_source`, `usage_status`, `settled_estimate_usd_micros`. Missing usage is null, never zero. |
| Diagnostic   | `error_code`, sanitized `error_message`, `response_digest`, `terminal_frame_observed`, `revision`.                                                                                            |

Token categories carry provider-specific semantics in the pricing snapshot. Cached and reasoning counts must not be double-counted if already included in the provider's total. A usage decoder rejects impossible or contradictory values. It does not infer free usage because a field is absent.

`purpose` includes `task`, `compaction`, `optimizer`, and `retry`. A non-inference credential-verification models request is logged as a separate audit event, not a fabricated zero-token `ProviderCall`.

## 6. Financial contracts

### 6.1 Separate money sources

The E2B compute account is platform-funded and globally shared. A campaign's Nebius inference account is funded by that campaign owner's supplied credential and self-selected bounded allowance. An E2B promotional credit balance is not a Nebius allowance. A campaign's unused inference allowance cannot purchase E2B runtime.

The accounting service exposes both settled estimates and outstanding obligations. Provider invoices may differ because of billable dimensions, delayed metering, account discounts, or provider limit semantics. The application calls its values estimates and reports their pricing timestamp and uncertainty.

### 6.2 `BudgetAccount`

| Field                                  | Persistent contract                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `owner_scope`                    | UUID and owning scope. Platform accounts use a persistent internal system owner UUID. A browser cannot act as that scope.                         |
| `kind`                                 | `platform_compute`, `campaign_compute`, or `campaign_inference`.                                                                                  |
| `campaign_id`, `credential_id`         | Campaign accounts require their matching campaign. Inference also requires its owned credential. The platform account has neither.                |
| `currency`, `unit`                     | `USD`, `micros`. No mixed currencies or floating-point conversions.                                                                               |
| `hard_limit_usd_micros`                | Absolute account ceiling. Platform value is `100000000`, equal to USD 100.                                                                        |
| `admission_limit_usd_micros`           | Ordinary admission threshold. Platform initial value is `90000000`, equal to USD 90. Campaign compute initial value is `5000000`, equal to USD 5. |
| `settled_estimate_usd_micros`          | Nonnegative sum of reconciled estimated charges and explicit accounting adjustments.                                                              |
| `reserved_usd_micros`                  | Sum of all outstanding reservations, including uncertain operations.                                                                              |
| `unknown_reservation_count`            | Number of obligations whose actual or maximum usage remains unresolved.                                                                           |
| `status`                               | `active`, `blocked`, `closed`.                                                                                                                    |
| `created_at`, `updated_at`, `revision` | Durable metadata. There is no daily or monthly automatic reset.                                                                                   |

The platform's USD 10 reserve is the difference between the USD 100 hard limit and USD 90 ordinary admission limit. It is one part of the same USD 100, not an additional balance. A browser cannot release it. Any operator release is a durable audited policy change that leaves `admission_limit <= hard_limit` and includes all existing settled and reserved obligations.

### 6.3 `BudgetReservation`

| Field                                                               | Persistent contract                                                                                                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`, `owner_scope`, `campaign_id`                                  | Owning private scope and campaign. A compute reservation also references the global platform account through its debit links.                                                              |
| `operation_kind`, `operation_id`, `operation_key`                   | Exactly one external create, extension, build, storage obligation, inference transmission, or an explicitly identified round envelope. The operation key is unique.                        |
| `parent_reservation_id`, `allocated_usd_micros`                     | Optional round-envelope relationship and nonnegative amount already allocated to child operations. An operation cannot belong to two envelopes or exceed its parent's unallocated balance. |
| `amount_usd_micros`                                                 | Conservative maximum estimate admitted before the external side effect.                                                                                                                    |
| `settled_usd_micros`                                                | Nullable reconciled charge estimate.                                                                                                                                                       |
| `state`                                                             | `held`, `uncertain`, `settled`, or `released`.                                                                                                                                             |
| `pricing_snapshot_id`, `bound_json`                                 | Immutable basis of the estimate, including maximum lifetime or token counts.                                                                                                               |
| `created_at`, `updated_at`, `expires_at`, `settled_at`              | Timestamps. Expiry alone does not release an obligation.                                                                                                                                   |
| `release_reason`, `reconciliation_evidence_artifact_id`, `revision` | Auditable disposition.                                                                                                                                                                     |

An auxiliary reservation-account link associates one compute reservation with both its campaign account and the platform account. Inference associates only with its campaign inference account. One reservation amount updates each linked account once. Summing all accounts together would double-count compute and is prohibited in UI totals.

If the implementation reserves a complete compute round envelope, child holds allocate already reserved money in one transaction. The outstanding account total includes unallocated envelope value plus outstanding child obligations. It never sums the full original envelope and all children. Settling a child moves its actual estimated charge into settled totals and releases its unused bound. Unused unallocated envelope value releases when the complete round is checkpointed or cancelled. Uncertain children retain their allocated value even if the round ends. This rule is part of the ledger schema, not a UI subtraction.

An append-only ledger entry records every hold, increase, uncertainty transition, settlement, release, refund estimate, or operator adjustment. Mutable account totals are transactionally maintained summaries of that ledger. A repair check can recompute totals. Deleting a campaign or credential cannot delete these obligations.

### 6.4 Admission equations

For each account linked to a proposed reservation, define `S` as settled estimates, `R` as outstanding held or uncertain reservations, `N` as the new maximum reservation, `A` as admission limit, and `H` as hard limit. Admission requires both `S + R + N <= A` and `S + R + N <= H`. The comparison and all updates occur in one short SQLite write transaction.

Compute admission must pass the campaign account and the platform account in the same transaction. Inference admission must pass the campaign's inference account, request allowance, gateway-grant allowance, active credential state, campaign status, and global call/concurrency policy. Spending from a gateway grant debits the same campaign allowance, never a second independently spendable balance.

The same compute transaction also acquires a platform active-sandbox slot. At most two setup, agent, and verifier environments may be active or uncertain platform-wide. A create whose outcome is uncertain still occupies a slot until absence or expiry is established. Sequential scheduling changes concurrency, not the required number of sibling candidates.

An inference account's limit is chosen explicitly at campaign creation, must be finite and positive, and must fit the operator's current per-campaign maximum. The proposed form default is USD 0.20, or `200000` micro-units, with an initial operator campaign ceiling of USD 0.50, or `500000` micro-units. The browser still submits the selected allowance explicitly. The service also applies a smaller per-request maximum. Browser requests cannot set platform prices, raise operator limits, release reserves, provide a negative allowance, or select arbitrary provider origins. The form does not imply that the user's actual Nebius account balance is known. An owner can explicitly raise the campaign inference allowance or reconfirm current pricing through the dedicated allowance route in section 11.8. Resume alone never grants either consent.

Before the optimizer runs for a new round, the campaign reserves a conservative compute envelope for the full 2-6-sibling set, fresh parent reruns, candidate tasks, and independent verification. It separately admits the bounded optimizer inference request. Nested compute operation reservations consume that envelope rather than adding the same obligation twice. If the selected policy cannot bound a whole round's compute within remaining allowance, the campaign waits before starting that round. Pi inference remains admitted per actual request within the finite campaign inference allowance. The system cannot promise enough model work to finish every task from the models list or that allowance alone. Budget depletion, unexpected uncertainty, or user control can checkpoint the remaining siblings. The graph never reports a one-candidate partial round as the promised sibling experiment.

### 6.5 Pricing and rounding

An immutable pricing snapshot records provider, product or resource profile, model or template applicability, source identifier, observation time, validity policy, currency, billable dimensions, and exact rational rates. Inference rates distinguish uncached input, cached input, output, and any other separately billable category documented by that model. Compute rates distinguish CPU, memory, billable runtime intervals, and applicable build, snapshot, storage, or network charges.

Rates use integer numerator and denominator fields. Cost multiplication uses checked integer arithmetic. Reservations round upward to whole USD micro-units after summing the request's billable categories. Reconciled estimated charges use the snapshot's documented rounding policy. No binary floating-point value participates in admission.

A request without an enforceable output-token maximum cannot be admitted. A request's input bound uses a model-matched tokenizer only when its correctness is established. Otherwise use a documented conservative bound that covers the validated payload and context limit. Unbounded tool arguments, image inputs, arbitrary multimodal content, and unknown billable model features are rejected in the first text-only pilot.

For compute, reserve the complete provider-enforced maximum lifetime, including setup and cleanup time that may be billable. A ten-minute attempt is a maximum lifetime policy, not a guarantee that a six-task paired round fits USD 5. The UI must show an admission failure honestly when the configured resource rate makes the proposed work unaffordable.

Stale, missing, mismatched, or incomplete pricing blocks the corresponding operation with `PRICING_UNAVAILABLE`. A newly discovered valid price snapshot that requires renewed user consent blocks new inference with `PRICING_CONSENT_REQUIRED` until the owner explicitly accepts it. Provider request usage without a valid matching snapshot cannot become a confidently settled zero. Any uncovered charge dimension blocks paid execution until the operator records a valid policy. The snapshot attached to an already transmitted call never changes during later consent or allowance updates.

### 6.6 Unknown outcomes

| Situation                                                                              | Required accounting result                                                                                                                                                                        |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validation fails before a durable reservation or external transmission                 | No provider obligation. Record a safe local rejection if useful.                                                                                                                                  |
| Inference reservation exists but the gateway proves no bytes were transmitted upstream | Release with explicit `not_transmitted` evidence.                                                                                                                                                 |
| Upstream inference connection fails after transmission may have begun                  | Mark `ProviderCall.usage_status = unknown`; retain the full reservation.                                                                                                                          |
| Streaming client disconnects                                                           | Continue bounded accounting where possible. Browser or Pi cancellation does not establish zero usage. Retain the reservation if final usage cannot be recovered.                                  |
| Provider returns a documented nonbillable rejection with sufficient evidence           | Release or settle according to the matching provider policy. HTTP status alone is insufficient.                                                                                                   |
| E2B create response is lost                                                            | Intent becomes `create_uncertain`. Keep its reservation and active slot. Discover by the intent metadata before any replacement.                                                                  |
| E2B terminate response is lost                                                         | Intent becomes `stop_uncertain`. Keep its reservation until confirmed stop or conservative provider-enforced expiry.                                                                              |
| Provider usage arrives late                                                            | Reconcile exactly once using a unique reconciliation key. Preserve the original pricing basis and adjustment record.                                                                              |
| Observed charge estimate exceeds the admitted reservation                              | Record the full estimate, use only available retained reserve under operator policy, block new admission, and raise an operator-visible discrepancy. Never clamp reported spending to the budget. |
| Provider cannot establish ownership, count, expiry, or usage                           | Keep the conservative obligation and block affected admission. Waiting is not completion.                                                                                                         |

A timeout in SQLite is not proof that the provider stopped charging. Only provider-confirmed absence, a confirmed stop time, or a conservatively calculated enforced expiry can settle or release sandbox exposure. A permanently unresolved inference charge can remain reserved until an operator records a justified reconciliation. There is no automatic zero-cost write-off.

Before enabling hosted execution, the operator sets the E2B dashboard spending limit to USD 100 and verifies the account's actual scope, reset period, and enforcement behavior. The application ledger and this provider setting work together. Neither this document nor an application estimate promises an invoice with zero possible overshoot.

## 7. State machines and recovery invariants

### 7.1 Campaign state

| State       | Meaning and permitted next states                                                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`    | Durable job exists and no evaluation has started. May enter `running`, `waiting`, `pausing`, `stopping`, or `failed`.                                                                                 |
| `running`   | The worker has a valid lease and executes admitted work. May enter `waiting`, `pausing`, `stopping`, `completed`, or `failed`.                                                                        |
| `pausing`   | Pause requested. New logical attempts and optimizer calls stop. Already admitted work reaches its explicit checkpoint or bounded termination. May enter `paused`, `waiting`, `stopping`, or `failed`. |
| `paused`    | No new work may be admitted. Evidence and remaining allowance remain. Resume queues a job after all admission checks. May enter `queued` or `stopping`.                                               |
| `waiting`   | The campaign needs a specific external condition or reconciliation. May enter `queued`, `stopping`, or `failed`; it does not silently resume on a browser reconnect.                                  |
| `stopping`  | New calls and environments are denied. Gateway grants are revoked and cleanup runs. May enter `stopped` or remain here with cleanup uncertainty.                                                      |
| `stopped`   | Execution is terminal by user control and all owned environments are confirmed stopped or conservatively expired. No resume of this campaign.                                                         |
| `completed` | Configured search objective or finite search limit reached with no runnable work and no live owned environment. This does not mean every candidate improved.                                          |
| `failed`    | Unrecoverable application, integrity, or configuration failure ended execution after cleanup. The record retains its error and evidence.                                                              |

Budget exhaustion produces `waiting` with a precise reason for the hosted pilot. It does not turn an incomplete round into `completed`. Search saturation is represented by a terminal completion reason only when the configured finite experiment is actually complete. Continuous curriculum search uses `waiting` when a valid next challenge is unavailable.

`waitReason` is one of `compute_budget`, `inference_budget`, `provider_quota`, `provider_auth`, `pricing_unavailable`, `global_capacity`, `reconciliation`, `credential_revoked`, `runtime_unavailable`, `challenge_required`, or `operator_hold`. `waitDetails` is a bounded safe object. Exact provider text is not forwarded.

A valid newly discovered price that needs owner acceptance uses `waitReason = pricing_unavailable`, `waitDetails.requiresPriceConsent = true`, the safe replacement pricing snapshot ID, and `lastErrorCode = PRICING_CONSENT_REQUIRED`. This adds no separate campaign state. The allowance route records consent, and a subsequent explicit resume rechecks readiness.

`desiredControl` is `run`, `pause`, or `stop`. Stop dominates pause and run. A resume cannot override a newer stop revision. Pause acknowledges a request immediately but becomes `paused` only after the worker records the checkpoint. Completed evidence remains readable throughout cleanup.

### 7.2 Attempt state

| State        | Transition contract                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `planned`    | Immutable task and harness identities exist. No paid side effect.                                                           |
| `admitted`   | Required reservations and execution slot exist.                                                                             |
| `preparing`  | Controlled task setup proceeds before a gateway grant reaches the agent.                                                    |
| `starting`   | A committed agent sandbox intent is being realized.                                                                         |
| `running`    | Persisted sandbox and process IDs identify the Pi operation. Durable events advance its log cursor.                         |
| `settling`   | Pi has reached the required terminal event and the supervisor is confirming completion and extracting the canonical output. |
| `verifying`  | A separately admitted fresh verifier evaluates the submitted file under the pinned trusted evaluator.                       |
| `completed`  | A valid `pass` or `fail` verdict and required artifacts exist.                                                              |
| `recovering` | Ownership or process state is being reconciled. No duplicate create is permitted.                                           |
| `failed`     | No valid verdict can be established. `failureKind` explains why.                                                            |
| `cancelled`  | User control or policy prevented completion. Missing verdict stays null.                                                    |

Sandbox cleanup is tracked separately from attempt result state. An attempt can have a valid verdict while its cleanup remains uncertain. That does not free its compute reservation or active slot. Campaign terminalization waits for cleanup obligations, or explicitly exposes a retained reconciliation state.

`failureKind` includes `infrastructure`, `protocol`, `integrity`, `reproducibility`, `resource_limit`, `provider_auth`, and `provider_quota`. A verifier-proven failure of the submitted function is `verdict = fail`, not `failureKind = infrastructure`.

### 7.3 Sandbox intent state

The allowed progression is `prepared` to `create_requested`, then to `active`, `create_uncertain`, or `absent_confirmed`. Active environments can enter `stop_requested`, `stopped_confirmed`, or `stop_uncertain`. Confirmed provider expiry becomes `expired_confirmed`. A known pre-transmission rejection becomes `create_rejected`.

`create_uncertain` may become `active` after discovery, `absent_confirmed` after authoritative absence, or remain uncertain. A discovered duplicate environment does not disappear from accounting. The reaper records every matching provider ID, attributes its exposure, and terminates all environments the platform owns. An auxiliary intent-observation record supports multiple discovered IDs without overwriting evidence.

`create_rejected`, `absent_confirmed`, `stopped_confirmed`, and `expired_confirmed` are lifecycle terminal states. Their accounting can still require a later usage adjustment. A fence change cannot rewrite an old uncertain request as never sent.

### 7.4 Provider-call state

The allowed progression is `reserved` to `transmitting` to `streaming` or `awaiting_response`, then to `completed`, `rejected`, or `uncertain`. A provably untransmitted call may become `cancelled`. Usage status is independently `pending`, `known`, `unknown`, or `reconciled`.

A completed HTTP response without usable billing data can have `state = completed` and `usageStatus = unknown`. Its reservation stays outstanding. A failed task can have known paid inference. A successful task can have unknown paid inference. Task correctness and usage certainty are separate axes.

### 7.5 Lease and callback authority

Only an authenticated worker service context can claim jobs, renew leases, issue grants, capture artifacts, and write verifier results. Browser session cookies do not authorize hosted callbacks or worker state transitions.

The first implementation should prefer the worker's outbound control connection and artifact collection over publicly writable result callbacks. If a callback becomes necessary, its contract requires a short-lived internal token bound to job ID, campaign ID, attempt ID, fence, permitted action, and payload digest. The receiver validates the current job lease and rejects stale fences before mutation. A provider callback never bypasses independent verification or directly marks a candidate accepted.

The callback's idempotency key is unique within the job and action. An identical duplicate returns the recorded outcome. A different payload under the same key returns `409 IDEMPOTENCY_CONFLICT`. Callback tokens have separate audience and signing keys from browser cookies and inference grants.

## 8. Inference gateway contract

### 8.1 Scope and grant

The only initial inference route is `POST /api/inference/v1/chat/completions`. It is a restricted Token Factory compatibility endpoint, not an arbitrary URL proxy. The configured public HTTPS origin must be reachable from E2B. A localhost-only route is not a hosted integration.

A gateway grant is a durable auxiliary record. Its usable bearer token is random and opaque. Store only a keyed token digest. The record contains `id`, `owner_scope`, `campaign_id`, optional `task_attempt_id`, `job_id`, `issued_fence`, `audience`, exact `model_id`, `credential_id`, `allowed_route`, `expires_at`, `max_request_usd_micros`, `remaining_allowance_usd_micros`, `max_calls`, `calls_used`, `status`, and `revision`.

Grant scope is `pi_attempt` for a task or `optimizer` for a bounded worker optimizer operation. An optimizer grant cannot act as a Pi attempt and cannot read task files. A Pi attempt cannot use the optimizer's allowance. Both debit the same owning campaign inference account.

The gateway checks the persisted grant, campaign control state, credential status, expiry, request cap, and valid job fence at every request. Pausing denies new requests after the documented pause checkpoint. Stop, credential revocation, or lease loss revokes grants immediately. An already transmitted upstream call remains a financial obligation.

### 8.2 Request validation

The accepted DTO has exact selected `model`, bounded `messages`, required bounded `max_tokens` or the selected provider's version-matched equivalent, optional supported sampling values, optional streaming flag, and the supported tool-call schema required by the pinned Pi integration. The implementation records the precise provider/Pi compatibility revision before launch.

The gateway rejects unknown model IDs, unsupported modalities, arbitrary base URLs, caller-supplied upstream authorization, unsupported passthrough headers, oversized request bodies, unbounded output, invalid tool schemas, and routes outside its allowlist. It forwards only the fixed configured provider origin and required headers. Redirects cannot send a credential to a different host.

A `GatewayRequest-Key` UUID identifies a logical Pi request within one grant. A normalized request digest binds the key to the exact request. If the pinned Pi transport cannot supply this header, the adapter must supply an equivalent durable request identifier. Lack of that integration must be documented before enabling automatic client retries.

An exact duplicate whose upstream request has not started can reuse the reserved result path. A completed nonstream response may replay only from an explicitly bounded durable response cache. A streamed response is not automatically replayable. A duplicate after upstream transmission or with an uncertain outcome returns `409 REQUEST_OUTCOME_UNKNOWN` or `409 REQUEST_ALREADY_SENT` with a safe operation reference. It never creates a second upstream request silently.

Explicit retry creates a new request key, links `retryOfProviderCallId`, acquires a new reservation, and consumes provider-call limits. A retry is permitted only under configured retry policy. The previous reservation remains until its own usage is known.

### 8.3 Streaming and failure

The compatibility layer forwards bounded provider stream events while persisting safe usage and terminal metadata. It does not persist arbitrary raw headers or authorization values. A stream terminal marker without final usage does not settle the money reservation.

The gateway has bounded upstream deadlines, output-byte limits, concurrency limits, and per-grant rate limits. The gateway records the reservation and `ProviderCall` before transmission. If persistence fails before transmission, it returns an error and makes no upstream call. If final persistence fails after transmission, recovery retains the obligation and marks the operation uncertain.

Provider authentication failure produces a safe `provider_auth` waiting condition. Quota and rate-limit failure produce `provider_quota` with a retry policy based on available safe information. Neither is task failure, benchmark rejection, or evidence that the model cannot solve the task.

## 9. Artifact and evidence contracts

### 9.1 `Artifact`

Artifact bytes live in a durable directory on the persistent host for the pilot. SQLite stores metadata and ownership. Storage keys are generated by the application and never derived from a browser-supplied path.

| Field                                                       | Persistent contract                                                                                                                                                                                                  |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `owner_scope`, `campaign_id`                          | UUID relationships.                                                                                                                                                                                                  |
| `harness_version_id`, `task_attempt_id`, `provider_call_id` | Nullable evidence links. Every nonnull link must match owner and campaign.                                                                                                                                           |
| `kind`                                                      | `harness_bundle`, `proposal_digest`, `proposal_output`, `task_submission`, `task_diff`, `pi_events`, `supervisor_log`, `public_check_output`, `verifier_result`, `reconciliation_evidence`, or `published_snapshot`. |
| `content_type`, `encoding`, `byte_length`, `sha256`         | Verified metadata over the final bytes. Byte length is a bounded safe integer.                                                                                                                                       |
| `storage_key`                                               | Internal opaque relative key under the configured artifact root. Never returned to a browser.                                                                                                                        |
| `state`                                                     | `pending`, `ready`, `quarantined`, `deleted`, or `missing`.                                                                                                                                                          |
| `visibility`                                                | `private`, `internal_only`, or `published_snapshot`. Raw artifacts do not become public by inheriting a campaign flag. Browser ownership never grants `internal_only` access.                                        |
| `redaction_policy_version`, `redaction_status`              | `pending`, `passed`, `failed`, or `not_applicable` under an explicit kind policy.                                                                                                                                    |
| `created_at`, `finalized_at`, `retention_until`, `revision` | Durable lifecycle metadata.                                                                                                                                                                                          |

Artifact persistence writes to a temporary file, computes the digest, enforces byte limits, finalizes bytes, then marks metadata ready. Recovery handles a file finalized before its metadata commit and metadata whose file is missing. A pending or missing artifact cannot satisfy an evaluation's required-evidence invariant.

The submitted solution is only `src/solution.cjs`. Extraction rejects path escape, symlink outputs, unsupported file types, and oversized content. A submitted patch is evidence, but only the canonical file enters the verifier. Agent-edited tests, dependency manifests, or grader configuration do not change the benchmark contract.

The trusted verifier receives the immutable evaluator, hidden tests, and canonical submission in a fresh environment. It receives no inference credential, gateway grant, agent filesystem, or browser session. The API host never evaluates the submitted file directly. Public artifact downloads exclude hidden tests, expected answers, controller tokens, provider credentials, and private operator configuration.

Raw verifier diagnostics can themselves contain hidden inputs or expected values. Keep any such bytes in an internal-only artifact class that browser ownership does not authorize downloading. The `verifier_result` exposed through an `ArtifactDTO`, events, graph, or optimizer evidence is an allowlisted safe projection with verdict, resource outcome, evaluator revision, and permitted diagnostic categories. Redaction is not permission to release hidden cases. Hidden test bundles, expected answers, and raw failure payloads never pass to Pi or the optimizer, including through an owned campaign's evidence route.

### 9.2 `ArtifactDTO`

| Field                                             | Type and meaning                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `id`                                              | Artifact UUID.                                                                                             |
| `campaignId`                                      | Owning campaign UUID.                                                                                      |
| `harnessVersionId`, `taskAttemptId`               | Nullable evidence references.                                                                              |
| `kind`, `state`                                   | Allowlisted enums.                                                                                         |
| `contentType`, `encoding`, `byteLength`, `sha256` | Safe verified content metadata.                                                                            |
| `createdAt`, `finalizedAt`                        | Timestamps.                                                                                                |
| `redactionStatus`                                 | Safe status.                                                                                               |
| `downloadUrl`                                     | Same-origin `/api/hosted/artifacts/[id]` path. It carries no secret or filesystem path.                    |
| `preview`                                         | Optional bounded sanitized text, with `truncated` and explicit encoding. Never inline unbounded log bytes. |
| `availabilityReason`                              | Safe enum when no download is available.                                                                   |

No endpoint trusts a browser-supplied MIME type when rendering an artifact. Serve code and logs as inert downloads or escaped previews. Use `X-Content-Type-Options: nosniff` and appropriate content disposition. Public snapshots contain only allowlisted summaries and separately approved published artifact bytes.

Browser artifact lookups require both the owner predicate and an allowed non-internal visibility. An `internal_only` artifact returns the same `404 NOT_FOUND` as an unknown artifact even to the owning browser. Snapshots, event payloads, and artifact lists omit its ID and storage metadata. Internal verifier and reconciliation service contexts use separate read methods with a purpose-specific audit trail.

## 10. Events, snapshots, and reconnection

### 10.1 `CampaignEvent`

| Field                                     | Persistent contract                                                              |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| `id`, `owner_scope`, `campaign_id`        | UUID relationships.                                                              |
| `sequence`                                | Strictly increasing positive integer within a campaign. Unique with campaign ID. |
| `type`, `payload_version`, `payload_json` | Allowlisted event type and validated bounded payload.                            |
| `record_revision`                         | Revision of the authoritative changed record.                                    |
| `job_id`, `lease_fence`                   | Optional internal provenance. DTOs omit lease-owner identities.                  |
| `created_at`                              | Transaction commit timestamp.                                                    |

Every authoritative state mutation and its event insert commit in one transaction. No event advertises a reservation, attempt result, graph node, or control change that the database has not committed. A sequence is a notification order, not a benchmark result or external-provider cursor.

Proposed event types include `campaign.created`, `campaign.state`, `control.requested`, `job.state`, `round.planned`, `round.checkpoint`, `harness.proposed`, `harness.state`, `attempt.state`, `attempt.progress`, `sandbox.state`, `provider_call.state`, `budget.updated`, `allowance.updated`, `artifact.ready`, `comparison.completed`, `reconciliation.required`, and `error.recorded`. Events carry safe IDs, summaries, and revisions. High-volume Pi token deltas and full logs belong in bounded artifacts, not the authoritative event table.

### 10.2 Snapshot DTO

`CampaignSnapshotDTO` contains the following components at one database read point.

- `campaign`, including lifecycle, pinned configuration, search progress, revision, checkpoint, and wait reason.
- `graph`, containing `HarnessVersionDTO` nodes and ancestry or curriculum-transition edges.
- `comparisons`, containing exact task counts, fresh parent and candidate references, context hashes, and valid paired deltas.
- `taskAttempts`, containing bounded current and recent attempt summaries. Older attempts paginate separately through future contract extensions rather than making a snapshot unbounded.
- `budgets`, containing separate platform-compute visibility summary, campaign compute, and campaign inference estimates, reservations, unknown counts, and pricing timestamps.
- `artifacts`, containing required recent `ArtifactDTO` metadata and references for more evidence.
- `job`, containing safe current state and last progress time, without worker secrets.
- `eventCursor`, `snapshotRevision`, `generatedAt`, and `schemaVersion`.

The event cursor is the greatest committed campaign sequence included in that consistent snapshot. Snapshot construction and sequence selection share one SQLite read transaction. The client fetches the snapshot first, then subscribes after that cursor. Events committed between those steps are delivered from durable storage.

`CampaignEventDTO` contains `id`, `campaignId`, `sequence`, `cursor`, `type`, `payloadVersion`, `recordRevision`, `createdAt`, and sanitized `payload`. Delivery is at least once. The browser deduplicates by campaign ID and sequence and ignores record updates older than a record's current revision. A gap triggers snapshot refresh. A heartbeat is transport liveness, not an experiment event.

### 10.3 `/events` transport

The first release implements `GET /api/hosted/campaigns/[id]/events` as bounded JSON polling with `Accept: application/json`. The proposed polling interval is two seconds, subject to server backoff. Query `after` accepts a cursor. Optional `limit` is bounded by operator policy. A request whose only acceptable event transport is `text/event-stream` returns `406 UNSUPPORTED_TRANSPORT` until SSE is explicitly implemented and verified. An absent `Accept` or a wildcard accepts JSON. An SSE-only request does not silently open a stream or change the job.

Deferred SSE contract: frames would use the cursor as `id`, the contract event type as `event`, and a serialized `CampaignEventDTO` as `data`. `Last-Event-ID` would resume when `after` is absent. If both are present and disagree, the future SSE implementation must return `400 INVALID_CURSOR` before opening a stream. It must periodically check session validity, campaign ownership, and stream duration, send keepalive comments separately, and close expired or overlong streams. Stream cancellation must never cancel the job. These statements are requirements for a later transport and are outside the pilot's acceptance claim.

A cursor is accepted only for its campaign and owner. Wrong-campaign and malformed cursors return `400 INVALID_CURSOR` after the route's owner authorization. A future sequence returns `409 CURSOR_AHEAD`. A cursor older than retained replay history returns `410 CURSOR_EXPIRED` with the owned campaign's snapshot URL. An inaccessible campaign returns `404` before revealing cursor validity.

The pilot retains all authoritative campaign events for the retained life of the campaign. High-volume attempt logs can have a separate bounded retention policy. Event pruning, when introduced, records a replay floor. The API must never silently skip a pruned interval and pretend replay was complete.

### 10.4 Published evidence

Public browsing reads immutable sanitized snapshots selected for publication. A public catalog entry includes a snapshot UUID, publication time, content digest, model and runtime identity, benchmark identity, measured outcome, and a clear `source` value. `hosted_published` and `local_archive` are distinct sources.

The public catalog cannot query raw private campaigns and filter only after serialization. It reads a publication table or publication artifact with allowlisted columns. Credential IDs, owner scopes, raw logs, hidden test content, private hypotheses where not approved, and billable request bodies are excluded by construction. Publication is outside the browser campaign-control actions in this pilot and requires an explicit reviewed workflow.

## 11. HTTP route reference

### 11.1 Shared mutation rules

Browser mutations require a valid signed session, same-origin request validation against the configured trusted origin set, accepted content type, bounded body, and an idempotency key. The deployment defines its public origin and trusted proxy behavior. A legitimate explicitly configured local origin is supported. Do not restore the old blanket origin mismatch that rejects valid local use.

`Idempotency-Key` is a client-generated UUID for owner-authenticated `POST` and effectful `DELETE` operations. The server stores the normalized method, route, owner scope, key, request digest, outcome status, and response reference in the same transaction as its durable effect. Identical replay returns the original durable outcome. Reuse with a different body, route, or method returns `409 IDEMPOTENCY_CONFLICT` within that owner scope.

Session bootstrap precedes an owner scope and is the explicit exception. The browser serializes bootstrap and uses the established cookie for later operations. A repeated bootstrap with a valid cookie returns the same session. A request without a valid cookie may create a new isolated empty session, subject to abuse limits. It cannot replay any paid operation or expose another session's identity. Do not store or return a usable session token through a general idempotency-response cache.

Credential idempotency digests use a keyed digest of secret-bearing bodies. Never store a plaintext body or unkeyed secret hash. API idempotency does not cause automatic replay of a provider call or sandbox create.

Mutable-record controls require `expectedRevision` in the body. An owned stale revision returns `409 REVISION_CONFLICT` with the current revision and snapshot URL. A replay under the original idempotency key returns the original accepted outcome even if the campaign has advanced.

List cursors are opaque and bound to owner scope, stable sort key, filter digest, and schema version. Limits default to 25 and cap at 100 for normal lists. Private UUID ownership is checked before returning field-specific errors about that resource.

### 11.2 Route matrix

| Method and route                             | Authorization                                              | Request DTO                                                                 | Response and side effect                                                                                                                                                                         |
| -------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/hosted/session`                    | Optional existing cookie                                   | None                                                                        | Returns `SessionDTO` or `data.session = null`. Does not create an identity during public browsing.                                                                                               |
| `POST /api/hosted/session`                   | Same-origin bootstrap and rate limit                       | `CreateSessionRequest` with schema version and no owner-supplied identifier | `201 SessionDTO`, sets signed opaque cookie. Existing valid session returns its same identity.                                                                                                   |
| `DELETE /api/hosted/session`                 | Owned active session, same origin                          | `RevokeSessionRequest` with expected revision                               | `202 SessionRevocationDTO`, clears cookie, revokes grants, and requests stop. Cleanup continues without the browser.                                                                             |
| `GET /api/hosted/credentials`                | Active session                                             | Bounded list query                                                          | `CredentialDTO[]` for that owner only.                                                                                                                                                           |
| `POST /api/hosted/credentials`               | Active session, same origin                                | `ConnectCredentialRequest`                                                  | Bounded authentication verification, encrypted storage, then `201 CredentialDTO` on accepted key. Invalid key returns safe validation result without secret echo.                                |
| `DELETE /api/hosted/credentials`             | Active session, same origin                                | `RevokeCredentialRequest` with credential ID and expected revision          | `202 CredentialRevocationDTO`, blocks new requests and requests dependent cleanup.                                                                                                               |
| `GET /api/hosted/models`                     | Active session                                             | Required owned `credentialId`, optional refresh flag under rate limit       | `ModelCatalogDTO` for the configured provider and supported text models. Freshness and authentication time are explicit.                                                                         |
| `GET /api/hosted/catalog`                    | Public for published mode; active session for private mode | `scope=published` by default, or `scope=mine`; cursor and safe filters      | Public immutable summaries or owner-only hosted summaries. Never mixed with raw legacy stores.                                                                                                   |
| `GET /api/hosted/benchmarks`                 | Public metadata                                            | Safe domain filter and cursor                                               | `BenchmarkCatalogDTO` with public task descriptions, public checks, task count, hashes, and availability. No hidden cases, expected answers, verifier private paths, or editable grader payload. |
| `GET /api/hosted/harnesses`                  | Public base manifests, owner for private versions          | `scope=base` or `scope=mine`, optional owned campaign ID                    | `HarnessCatalogDTO` with approved Pi base and version metadata. Private candidates remain owner-scoped.                                                                                          |
| `GET /api/hosted/campaigns`                  | Active session                                             | Cursor and status filter                                                    | Owner's `CampaignSummaryDTO[]`.                                                                                                                                                                  |
| `POST /api/hosted/campaigns`                 | Active session, same origin                                | `CreateCampaignRequest`                                                     | One transaction creates private campaign, accounts, initial job, and event. Returns `202 CampaignAcceptedDTO`. No long-running work in the request.                                              |
| `GET /api/hosted/campaigns/[id]`             | Owner, or published snapshot selector described below      | UUID and optional `snapshotId`                                              | Owner gets `CampaignSnapshotDTO`. Public request requires an exact published snapshot ID associated with that campaign and gets `PublishedCampaignSnapshotDTO`.                                  |
| `POST /api/hosted/campaigns/[id]/control`    | Owner, same origin                                         | `CampaignControlRequest`                                                    | `202 CampaignControlDTO` after durable desired-control and event update.                                                                                                                         |
| `POST /api/hosted/campaigns/[id]/allowances` | Owner, same origin, idempotency key, expected revision     | `CampaignAllowanceRequest`                                                  | `200 CampaignAllowanceDTO` after audited inference allowance or price-consent update. Does not resume the campaign or call a provider.                                                           |
| `GET /api/hosted/campaigns/[id]/events`      | Owner                                                      | Cursor and JSON content negotiation                                         | First release returns bounded JSON event pages. SSE-only negotiation returns `406 UNSUPPORTED_TRANSPORT`. Public snapshots have no live event stream.                                            |
| `GET /api/hosted/artifacts/[id]`             | Owner, or exact published artifact reference               | Optional `metadata=true`; optional publication selector                     | `ArtifactDTO` metadata or inert artifact bytes. Unready bytes return safe availability error.                                                                                                    |
| `POST /api/inference/v1/chat/completions`    | Revocable scoped gateway grant                             | Restricted provider-compatible request                                      | Bounded inference response or stream. Browser cookies alone confer no gateway authority.                                                                                                         |

The public snapshot selector is explicit. For `GET /campaigns/[id]?snapshotId=...`, resolve only the publication record associated with both IDs. Never fall back to the live private record. If the publication or association is absent, return `404`. A public artifact request similarly resolves a preapproved artifact reference from a publication. Omitting that explicit publication context requires the private owner session.

The route matrix adds no browser endpoint for worker claims, internal callbacks, operator budget grants, reserve release, arbitrary template uploads, arbitrary extensions, or bulk result publication. Those need separate internal or reviewed contracts before implementation.

### 11.3 Session DTOs

`SessionDTO` contains `id`, `status`, `createdAt`, `expiresAt`, `revision`, and safe admission policy. It excludes `ownerScope`, token digests, signing values, and cross-session identity data. Safe admission policy includes `maxActiveCampaigns = 1`, allowed model-provider name, current public hosted-enabled status, and whether the browser may submit a campaign.

`SessionRevocationDTO` contains `accepted`, `requestedAt`, `affectedCampaignCount`, and a safe cleanup status. It does not claim that all environments stopped synchronously with the HTTP response.

### 11.4 Credential and model requests

`ConnectCredentialRequest` requires `schemaVersion`, `provider = nebius-token-factory`, bounded `label`, and `apiKey`. The API accepts the key only over configured HTTPS in production. The response, validation errors, diagnostics, request logs, and event payloads never include that field.

`RevokeCredentialRequest` requires `schemaVersion`, `credentialId`, and `expectedRevision`. `CredentialRevocationDTO` contains the masked credential DTO, `requestedAt`, and `affectedCampaignCount`.

`ModelCatalogDTO` contains `credentialId`, `provider`, `checkedAt`, `authenticationVerifiedAt`, `models`, `pricingObservedAt`, `balanceStatus`, `selectionPolicy`, `selectedModelId`, and `warnings`. Each `ModelDTO` contains exact `id`, display name, supported text/tool and structured-output capabilities, context and output limits where established, enabled state, availability state, a pricing snapshot reference, fixed-workload estimated uncached cost, and the reason for exclusion or blocked admission. A successful models list never displays a fabricated balance or inference guarantee.

The required model-selection policy uses fresh `GET /v1/models?verbose=true` discovery against the configured provider origin. Filter for enabled NVIDIA Nemotron models with the text, tool, and JSON or structured-output behavior required by the pinned Pi and optimizer protocols. Rank eligible models by estimated uncached input plus output cost for one explicit versioned fixed-workload profile. Store that profile's token counts, pricing snapshot, candidate costs, exclusion reasons, and selection result. Do not infer capability support from a model's display name alone.

Choose the cheapest eligible model. Prefer Nemotron 3.5 Lightning when compatible candidates have equal estimated cost. `nvidia/Nemotron-3_5-Lightning` is a candidate identifier to verify against the live enabled catalog, not a permanently hardcoded guarantee of price or availability. Pin the selected exact provider ID and accepted initial rates for the comparison lineage. New rates require an explicit versioned price-consent update. No costlier automatic fallback or silent cross-run model change is allowed. If the pinned model becomes unavailable, the campaign waits or an explicitly new evaluation identity is created. Price reconfirmation cannot switch model IDs. A user cannot enter an arbitrary model path or use the models route to make requests to another host.

### 11.5 Benchmark and harness DTOs

`BenchmarkCatalogDTO` contains manifests with `id`, `revision`, `hash`, `manifestHash`, `name`, `domain`, `taskCount`, public task IDs and descriptions, canonical output path, public check description, verifier identity, curriculum compatibility, and hosted availability reason. The first benchmark is honestly identified as `coding-adversarial-v1` function-implementation workspaces. It is not labeled SWE-bench or repository repair.

`HarnessCatalogDTO` separates operator-approved base manifests from private campaign versions. A base entry contains a catalog UUID, stable slug, content hash, exact supported Pi runtime range or pinned version, approved configurable fields, skill manifest, immutable template reference when ready, and availability. A private entry is a bounded `HarnessVersionDTO` with evidence references.

The pilot does not accept arbitrary extension JavaScript, shell setup hooks, environment-variable maps, evaluator modifications, or dependency changes from browser configuration. Approved instruction and skill content remain versioned data. The service validates every allowed field against the selected harness policy schema.

### 11.6 Campaign creation DTO

| Field                          | Type and validation                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                | `1`.                                                                                                                                  |
| `credentialId`                 | Owned verified Credential UUID.                                                                                                       |
| `modelId`                      | Exact eligible Token Factory model ID.                                                                                                |
| `proposerModelId`              | Exact eligible model ID. Initial pilot policy can require it to equal `modelId`. The value is pinned and visible.                     |
| `domain`                       | Allowlisted domain matching the benchmark.                                                                                            |
| `harnessId`, `harnessHash`     | Approved base manifest UUID and immutable content hash.                                                                               |
| `benchmarkId`, `benchmarkHash` | Public supported benchmark ID and immutable hash.                                                                                     |
| `parentHarnessVersionId`       | Optional owned completed eligible parent. Public archive adoption requires a separate sanitized import path, not raw private reuse.   |
| `inferenceAllowanceUsdMicros`  | Explicit positive decimal string. Proposed form default `200000`, operator campaign maximum `500000`.                                 |
| `acceptedPricingSnapshotId`    | Server-issued pricing snapshot UUID for the exact selected eligible model and current supported billable dimensions.                  |
| `maxRequestUsdMicros`          | Positive decimal string no larger than the campaign inference allowance and operator per-request maximum.                             |
| `search`                       | Bounded object with `mode`, `rounds`, `branches` in 2-6, `beamWidth`, `maxCandidates`, `maxTaskAttempts`, and `maxProviderCalls`.     |
| `policyOverrides`              | Only fields allowed by the selected harness policy schema. No arbitrary secrets, commands, URLs, or executable extensions.            |
| `expectedCatalogRevision`      | Catalog revision used by the browser to produce the request. A changed benchmark or harness hash returns a stale-configuration error. |

No `ownerScope`, E2B key, platform budget amount, compute top-up, provider base URL, hidden verifier content, or arbitrary filesystem path is accepted. The server fills the proposed USD 5 campaign compute limit and resolves operator policy itself.

`CampaignAcceptedDTO` contains `campaignId`, `status = queued` or a precisely admitted `waiting` state, `jobId`, `revision`, `createdAt`, `snapshotUrl`, `eventsUrl`, `controlUrl`, and separate accepted compute and inference budget summaries. An accepted durable job is not a promise that the provider will authorize inference or that the experiment will fit its allowance.

Campaign creation returns `409 ACTIVE_CAMPAIGN_EXISTS` when the owner already has a nonterminal active campaign. Paused or waiting campaigns still occupy that owner's campaign slot until stopped, completed, or failed after cleanup. The response can refer to the owner's existing campaign without leaking another session's IDs.

### 11.7 Campaign control DTO

`CampaignControlRequest` contains `schemaVersion`, `action`, `expectedRevision`, and an optional bounded reason. `action` is `pause`, `resume`, or `stop`. Resume rechecks credential ownership and state, pricing, existing uncertainty, remaining allowance, pinned runtime, and policy. It never grants additional money automatically.

`CampaignControlDTO` contains `campaignId`, `action`, `desiredControl`, `status`, `revision`, `controlRevision`, `requestedAt`, `checkpoint`, and `eventCursor`. It states whether the request is pending or already observed by the worker. Pause and stop return acceptance promptly. They do not claim immediate provider termination.

Browser control actions cannot increase a campaign's compute account, increase the global ceiling, or release reserve. The dedicated allowance route below provides explicit owner-authorized inference increases and price reconfirmation. Do not overload `resume` with a hidden top-up field.

### 11.8 Inference allowance and price consent

`POST /api/hosted/campaigns/[id]/allowances` requires the owning session, same-origin validation, `Idempotency-Key`, and optimistic concurrency. Its strict `CampaignAllowanceRequest` contains the following fields.

| Field                       | Type and validation                                                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`             | `1`.                                                                                                                                                                                                                                              |
| `kind`                      | Exactly `inference`. Browser compute grants are rejected.                                                                                                                                                                                         |
| `expectedRevision`          | Current campaign revision. A stale owned campaign returns `409 REVISION_CONFLICT`.                                                                                                                                                                |
| `newLimitUsdMicros`         | Explicit decimal-string total campaign inference limit. Positive, no less than the existing limit, no less than settled estimates plus all held or uncertain inference obligations, and no greater than the current operator maximum of `500000`. |
| `acceptedPricingSnapshotId` | Server-issued fresh pricing snapshot UUID matching the pinned exact model, configured provider, supported billing policy, and current eligible catalog. The caller cannot provide rates or a provider origin.                                     |

The accepted operations are an explicit limit increase, a same-limit update that refreshes price consent, or both together. The endpoint cannot lower an allowance, erase spending, release unknown reservations, reset call counts, restore unused inference to the E2B budget, change the credential, or change the pinned model. The below-obligations check still applies if an accounting discrepancy exceeds the previous allowance. An amount above the operator ceiling requires operator policy review, not a browser bypass.

In one transaction, check the owner and expected campaign revision, validate the pricing snapshot, record the immutable allowance grant, update the inference account limit if increased, set the accepted pricing snapshot and consent revision, append `allowance.updated` and the applicable `budget.updated` event, increment the campaign revision, and persist the idempotency outcome. The grant record contains its UUID, owner scope, campaign, old and new limits, prior and accepted pricing snapshots, previous and new consent revision, requester session ID, creation time, request ID, and action category. Secret-bearing provider data is excluded.

`CampaignAllowanceDTO` contains `campaignId`, `grantId`, `kind = inference`, `previousLimitUsdMicros`, `newLimitUsdMicros`, `acceptedPricingSnapshotId`, `pricingConsentRevision`, `revision`, `updatedAt`, `budget`, `status`, `waitReason`, and `resumeRequired`. It returns `200` only after that transaction commits. Identical replay returns the original grant and revision. A changed request under the same key returns the normal idempotency conflict.

This endpoint does not contact Token Factory, create an E2B environment, settle prior calls at new rates, or resume a paused or waiting campaign. A waiting owner reviews the updated snapshot and sends a separate explicit `resume` control after the allowance or price condition is satisfied. Resume rechecks all remaining waits, including compute capacity, authentication, unknown usage, and runtime availability. An allowance update on a terminal campaign returns `409 STATE_CONFLICT`.

Gateway grants never become spendable twice after an increase. Existing in-flight calls retain their original reservation and pricing snapshot. New requests use only an accepted current snapshot and the same campaign ledger. A required price refresh invalidates stale-price new-request authority until the owner accepts the replacement snapshot. Reissuing a grant must respect the current job fence and the remaining campaign allowance. A same-limit consent update supplies no additional money.

Operator compute grants remain a separate internal service contract. Planned operations are `grantCampaignComputeAllowance`, `setPlatformAdmissionLimit`, and `reconcileBudgetReservation` under an authenticated operator context. Each requires an explicit operation UUID, expected account revision, reason, and audit record. They obey the unchanged USD 100 platform ceiling, preserve outstanding obligations, and cannot lower a limit below those obligations. Releasing part of the USD 10 reserve changes the ordinary admission threshold only within that ceiling. These functions have no browser routes. A later reviewed operator script may invoke them. Invoking an allowance function changes accounting policy and performs no provider charge by itself.

### 11.9 Campaign and budget response DTOs

`CampaignSummaryDTO` contains `id`, `source`, status and wait reason, domain, exact model IDs, benchmark identity, root and active version IDs, completed and requested rounds, measured candidate counts, last progress time, timestamps, and revision. It includes separate cost summaries with explicit uncertainty. It does not include raw prompts, credentials, or private logs.

`HarnessVersionDTO` contains identity and ancestry, content hash, learning fields, status, benchmark and runtime identity, exact task progress counts, derived score or null, comparison summary or null, error category, timestamps, and artifact references. The comparison summary states `method = paired`, fresh parent and candidate pass counts, denominator, delta, context hash, and reason. Infrastructure-incomplete comparisons have null delta.

`BudgetSummaryDTO` contains `currency = USD`, `unit = micros`, `limitUsdMicros`, `admissionLimitUsdMicros`, `settledEstimateUsdMicros`, `reservedUsdMicros`, `availableForAdmissionUsdMicros`, `unknownReservationCount`, `estimateStatus`, `pricingObservedAt`, and `asOf`. `estimateStatus` is `known_estimate`, `contains_unknown_usage`, `reconciliation_required`, or `pricing_unavailable`.

`availableForAdmissionUsdMicros` cannot be negative in the normal DTO. If a discrepancy makes obligations exceed policy, show `0`, set reconciliation status, and include a separate positive `overLimitUsdMicros` amount. Never hide the overage by reducing settled estimates. The platform summary discloses aggregate shared capacity only, with no other owner's campaign or credential metadata.

## 12. Error reference

| HTTP status | Code                        | Contract                                                                                                                                                |
| ----------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`       | `INVALID_REQUEST`           | Malformed JSON, unknown fields, invalid units, invalid enum, or unsupported content. Field errors are bounded and secret-free.                          |
| `400`       | `INVALID_CURSOR`            | Invalid cursor after the caller's resource access has been established.                                                                                 |
| `401`       | `GATEWAY_AUTH_REQUIRED`     | Missing or invalid gateway bearer authority. Does not reveal campaign identity.                                                                         |
| `403`       | `ORIGIN_REJECTED`           | Browser mutation origin fails the configured trusted-origin policy.                                                                                     |
| `403`       | `GATEWAY_SCOPE_DENIED`      | Valid grant lacks requested model, route, attempt, or job authority.                                                                                    |
| `404`       | `NOT_FOUND`                 | Unknown, expired-session, or wrong-owner private resource. Same shape for inaccessible private IDs.                                                     |
| `409`       | `REVISION_CONFLICT`         | An owned mutable record changed. Return current safe revision.                                                                                          |
| `409`       | `IDEMPOTENCY_CONFLICT`      | Same owner and key used for a different normalized request.                                                                                             |
| `409`       | `ACTIVE_CAMPAIGN_EXISTS`    | Owner already occupies the one-active-campaign slot.                                                                                                    |
| `409`       | `STATE_CONFLICT`            | Requested transition is invalid, such as resuming a stopped campaign.                                                                                   |
| `409`       | `CATALOG_STALE`             | Pinned benchmark, harness, runtime, or model capability revision changed before admission.                                                              |
| `409`       | `PRICING_CONSENT_REQUIRED`  | Valid new model pricing requires explicit owner consent. The owned response identifies the safe current pricing snapshot and allowance route.           |
| `409`       | `CURSOR_AHEAD`              | Cursor is ahead of the owned campaign's committed sequence.                                                                                             |
| `409`       | `REQUEST_ALREADY_SENT`      | Logical gateway request already transmitted and cannot safely be replayed.                                                                              |
| `409`       | `REQUEST_OUTCOME_UNKNOWN`   | Existing external operation needs reconciliation before retry.                                                                                          |
| `410`       | `CURSOR_EXPIRED`            | Replay floor passed the requested cursor. Fetch the safe owned snapshot URL.                                                                            |
| `406`       | `UNSUPPORTED_TRANSPORT`     | Campaign event request requires a transport not implemented in this release, including SSE-only negotiation. JSON polling remains available.            |
| `413`       | `PAYLOAD_TOO_LARGE`         | Body, message context, tool schema, or artifact exceeds policy.                                                                                         |
| `415`       | `UNSUPPORTED_MEDIA_TYPE`    | Unsupported browser or gateway request content type.                                                                                                    |
| `422`       | `CREDENTIAL_INVALID`        | Submitted credential failed bounded verification. No provider body or secret echoed.                                                                    |
| `422`       | `MODEL_UNSUPPORTED`         | Model or required tool protocol unsupported under current policy.                                                                                       |
| `422`       | `CONFIGURATION_UNSUPPORTED` | Unsupported benchmark, harness policy, runtime, or incompatible pairing.                                                                                |
| `422`       | `ALLOWANCE_INVALID`         | Requested limit decreases the current limit, falls below settled plus held obligations, exceeds operator policy, or uses an unsupported allowance kind. |
| `429`       | `RATE_LIMITED`              | Session, IP, credential fingerprint, grant, or endpoint rate limit.                                                                                     |
| `429`       | `GLOBAL_CAPACITY`           | No platform environment slot. Existing campaign can enter waiting.                                                                                      |
| `429`       | `BUDGET_NOT_AVAILABLE`      | Campaign or platform admission equation fails. Separate compute and inference reason.                                                                   |
| `502`       | `PROVIDER_PROTOCOL_ERROR`   | Invalid provider response. Financial uncertainty remains recorded if transmission occurred.                                                             |
| `503`       | `HOSTED_DISABLED`           | Operator configuration or release gate disables paid hosted work.                                                                                       |
| `503`       | `PRICING_UNAVAILABLE`       | A safe maximum billable estimate cannot be established.                                                                                                 |
| `503`       | `RECONCILIATION_REQUIRED`   | Unknown ownership or usage blocks admission.                                                                                                            |
| `503`       | `PROVIDER_UNAVAILABLE`      | Bounded provider failure with safe retry information.                                                                                                   |
| `503`       | `STORAGE_UNAVAILABLE`       | Durable persistence unavailable. No new external side effect without prior reservation.                                                                 |

The worker maps provider quota, authentication, capacity, and budget failures into visible campaign waiting conditions. It does not turn every upstream response into an HTTP retry loop. Unexpected errors return a generic safe message and a request ID while preserving detailed redacted diagnostics internally.

## 13. SQLite schema and index plan

### 13.1 Database operating contract

One persistent CPU host runs the Next.js process, the separate worker, and the artifact directory. Both processes use the same SQLite database through the storage interface. Use foreign keys, WAL mode where supported by the chosen local filesystem, a bounded busy timeout, and short write transactions. Do not hold a transaction open while calling E2B, Token Factory, Pi, or the verifier.

Migrations run under a single migration lock before either process admits work. Store schema version, applied migration IDs, and a database installation UUID. Refuse incompatible schema versions. Backups include SQLite's consistent snapshot, artifact bytes, and encryption-key identifiers. Secrets remain in the operator's secret store. Restoring a backup requires provider reconciliation before new sandbox admission because restored data can lag real external operations.

Use explicit checked integer values rather than relying on SQLite affinity to validate money or enums. JSON fields have schema versions and bounded byte limits. UUID columns are text with canonical-format validation at the boundary. Each table's state checks and foreign keys enforce valid relationships where SQLite can express them. Cross-row financial and state invariants live in one transaction with tests.

### 13.2 Table inventory

| Table                   | Entity or purpose                          | Keys, foreign keys, and checks                                                                                                                                |
| ----------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions`              | `Session`                                  | PK `id`; unique `owner_scope`; unique `token_digest`; valid state; expiry after creation.                                                                     |
| `credentials`           | `Credential`                               | PK `id`; unique composite `owner_scope, id`; owning session scope; encryption metadata required while usable; valid provider and state.                       |
| `campaigns`             | `Campaign`                                 | PK `id`; unique composite `owner_scope, id`; composite owned credential reference; valid state and revision; branches 2-6; pinned config hash.                |
| `harness_versions`      | `HarnessVersion`                           | PK `id`; unique composite `owner_scope, campaign_id, id`; owned campaign and parent references; required immutable content hash; valid status.                |
| `proposal_sets`         | Complete sibling plans                     | UUID PK; owned campaign; unique campaign and round; one parent; planned sibling count 2-6; state and evidence digest.                                         |
| `proposal_set_members`  | Sibling membership                         | PK proposal-set ID and sibling index; unique version ID; no duplicate content hash within the set; same owned campaign.                                       |
| `comparisons`           | Fresh paired context                       | UUID PK; owned candidate and parent references; context hash; required-task manifest; exact counts; nullable delta until complete.                            |
| `task_attempts`         | `TaskAttempt`                              | PK `id`; owned campaign and version references; unique logical slot and attempt number; explicit retry link; role and verdict checks.                         |
| `jobs`                  | `Job`                                      | PK `id`; owned campaign; state, fence, lease, and payload checks; one unfinished run job per campaign.                                                        |
| `sandbox_intents`       | `SandboxIntent`                            | PK `id`; unique logical operation key; owned campaign, attempt, job, and reservation references; immutable create request identity.                           |
| `sandbox_observations`  | Provider discoveries and cleanup evidence  | UUID PK; owned intent; provider sandbox ID and observation time; preserves multiple matches and stop evidence.                                                |
| `provider_calls`        | `ProviderCall`                             | PK `id`; owned credential, campaign, attempt, grant, and reservation references; unique grant and logical request ID; nullable usage checks.                  |
| `gateway_grants`        | Revocable inference authority              | UUID PK; unique token digest; owned job/campaign/attempt references; exact model, route, expiry, and nonnegative allowance.                                   |
| `budget_accounts`       | `BudgetAccount`                            | PK `id`; unique account kind and relevant owner/campaign binding; USD/micros only; nonnegative amounts; admission limit no greater than hard limit.           |
| `budget_reservations`   | `BudgetReservation`                        | PK `id`; unique operation key; owned campaign and price snapshot; nonnegative amount; valid disposition.                                                      |
| `reservation_accounts`  | Linked compute or inference debits         | PK reservation ID and account ID; amount equals reservation amount; no duplicate application to an account.                                                   |
| `budget_ledger_entries` | Append-only financial audit                | UUID PK; unique operation/account/entry key; account and reservation references; signed integer delta with category; immutable creation time.                 |
| `allowance_grants`      | Append-only allowance and consent audit    | UUID PK; owned campaign and account; old and new limits; prior and accepted pricing snapshot references; consent revision; requester session and request ID.  |
| `pricing_snapshots`     | Immutable exact pricing                    | UUID PK; unique content hash; provider and billable dimension; observed time; rational nonnegative rates; supported currency.                                 |
| `campaign_events`       | `CampaignEvent`                            | UUID PK; unique campaign and sequence; owned campaign; type and payload version; bounded payload.                                                             |
| `artifacts`             | `Artifact`                                 | UUID PK; unique storage key; owned evidence links; nonnegative length; final digest required when ready.                                                      |
| `publications`          | Sanitized public snapshots                 | UUID PK; immutable campaign reference, sanitized snapshot artifact, publication time, schema and redaction policy; no raw owner response.                     |
| `publication_artifacts` | Allowlisted public evidence references     | PK publication ID and artifact ID; published content digest and safe metadata; no automatic traversal to private artifacts.                                   |
| `idempotency_records`   | Browser and internal deduplication         | UUID PK; unique owner and key; stored method and route checked on replay; keyed request digest where secret-bearing; effect reference and replayable outcome. |
| `operator_audit_events` | Configuration and reconciliation decisions | UUID PK; internal owner; actor reference, policy revision, safe action and reason; no secrets.                                                                |

Composite keys include owner scope even when a global UUID PK exists. This makes a cross-owner reference fail at the database boundary and keeps private repository methods explicit. Platform compute links use a dedicated validated service transaction because their account intentionally has a system owner rather than the campaign owner.

An active-campaign partial unique index covers owner scope while status is `queued`, `running`, `pausing`, `paused`, `waiting`, or `stopping`. The invariant includes cleanup-pending work. An unfinished-run-job partial unique index covers campaign ID while run state is queued, leased, running, or waiting. A stopped or failed campaign cannot free its slot while its lifecycle still carries an unconfirmed owned environment.

### 13.3 Required query indexes

| Index columns                                                                            | Query supported                                                                                        |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `sessions(token_digest)` unique                                                          | Cookie lookup.                                                                                         |
| `sessions(status, expires_at)`                                                           | Expiry and revocation sweep.                                                                           |
| `credentials(owner_scope, created_at, id)`                                               | Owned credential list.                                                                                 |
| `credentials(fingerprint, status)`                                                       | Internal per-credential admission limits without exposing identity.                                    |
| `campaigns(owner_scope, updated_at, id)`                                                 | Owned campaign list with stable pagination.                                                            |
| `campaigns(owner_scope, status)`                                                         | Active-owner checks and controls.                                                                      |
| `harness_versions(owner_scope, campaign_id, round_number, sibling_index)`                | Graph and round read.                                                                                  |
| `harness_versions(owner_scope, campaign_id, parent_id)`                                  | Ancestry traversal.                                                                                    |
| `comparisons(owner_scope, campaign_id, candidate_version_id)` unique                     | Paired result lookup.                                                                                  |
| `task_attempts(owner_scope, campaign_id, comparison_id, task_id, role, attempt_number)`  | Pair completeness and retry history.                                                                   |
| `task_attempts(owner_scope, campaign_id, status, updated_at)`                            | Live attempt summaries and recovery.                                                                   |
| `jobs(state, available_at, lease_expires_at, id)`                                        | Bounded worker claim scan. Internal service scope only.                                                |
| `jobs(owner_scope, campaign_id, created_at, id)`                                         | Owned job summaries.                                                                                   |
| `sandbox_intents(state, conservative_expires_at, id)`                                    | Internal reaper scan.                                                                                  |
| `sandbox_intents(owner_scope, campaign_id, task_attempt_id, purpose)`                    | Owned attempt lifecycle.                                                                               |
| `sandbox_intents(provider_sandbox_id)`                                                   | Provider discovery association. Do not make it unique if duplicate observations need separate records. |
| `sandbox_observations(intent_id, observed_at)`                                           | Reconciliation history.                                                                                |
| `provider_calls(owner_scope, campaign_id, task_attempt_id, transmission_started_at, id)` | Call and usage history.                                                                                |
| `provider_calls(usage_status, completed_at, id)`                                         | Internal unknown-usage reconciliation.                                                                 |
| `gateway_grants(token_digest)` unique                                                    | Gateway authority lookup.                                                                              |
| `gateway_grants(owner_scope, campaign_id, status, expires_at)`                           | Campaign grant revocation.                                                                             |
| `budget_accounts(kind, campaign_id)` unique where relevant                               | Durable account lookup.                                                                                |
| `budget_reservations(owner_scope, campaign_id, state, created_at)`                       | Campaign obligations and recovery.                                                                     |
| `budget_ledger_entries(account_id, created_at, id)`                                      | Ledger recomputation and audit.                                                                        |
| `allowance_grants(owner_scope, campaign_id, created_at, id)`                             | Owned allowance and price-consent history.                                                             |
| `campaign_events(owner_scope, campaign_id, sequence)` unique                             | Authorized snapshot and replay reads.                                                                  |
| `artifacts(owner_scope, campaign_id, task_attempt_id, created_at, id)`                   | Evidence lookup and pagination.                                                                        |
| `publications(published_at, id)`                                                         | Public catalog pagination.                                                                             |
| `idempotency_records(owner_scope, key)` unique                                           | Atomic mutation deduplication. Stored method and route must also match the replay.                     |

The implementation measures query plans on representative campaign sizes before adding further indexes. Write-heavy token logs do not share the authoritative event table. No browser-facing search query omits owner scope to exploit an index.

### 13.4 Atomic write sets

The following records must change together in one transaction.

1. Session bootstrap creates session identity and safe audit metadata before setting the usable cookie. It follows the bootstrap exception in section 11.1.
2. Campaign admission creates campaign, account bindings, run job, first event, and idempotency outcome.
3. Compute admission checks account totals and concurrency, creates the reservation, links both compute accounts, acquires the slot, creates the sandbox intent, and records its event.
4. Gateway admission checks grant and campaign authority, creates the provider call and reservation, updates account/grant counters, and records its event before upstream transmission.
5. Settlement inserts a unique ledger entry, changes reservation state, updates linked account totals, and records the new budget event.
6. Attempt completion commits the trusted verifier result references, attempt verdict, graph progress, and event under the active fence.
7. Comparison completion checks all exact task pairs, sets the candidate status, stores exact counts and delta, and records the graph event.
8. Control mutation updates desired control and control revision, enqueues necessary wakeup or cleanup work, records the event, and saves the idempotency outcome.
9. Lease takeover increments the fence and moves unresolved operations into recovery before authorizing further execution.
10. Inference allowance or price-consent mutation checks owner, revision, and obligations, inserts the immutable grant, updates account and consent, appends events, and persists idempotency outcome. It does not change desired control or enqueue a resume.

No atomic write set includes an awaited provider network request. Durable prepared state comes first, external operation second, reconciliation transaction third.

## 14. Compatibility with local evidence

Keep existing local JSON evidence and the existing archive identity intact. A compatibility reader can map a hosted `HarnessVersion` and completed trusted task judgments into the existing graph's display needs, but it must include `source = hosted`, stable UUIDs, and hosted evidence links. It must not serialize encrypted credentials, grants, job payloads, or private hosted campaigns through the legacy global API.

The current `TaskResult.costUsd`, node `score`, and campaign usage fields are historical display values. When a compatibility DTO needs decimal USD, derive it from integer micro-units for display only, label it an estimate, and retain unknown usage. It cannot become the input to hosted admission or overwrite null usage with zero.

The existing `NodeRecord` conflates evaluation lifecycle and acceptance labels. Hosted persistence keeps the richer attempt, lifecycle, cleanup, usage-certainty, and comparison records. The graph adapter can render `baseline`, `accepted`, `rejected`, and `failed` without collapsing a waiting campaign, unknown cost, or unreconciled sandbox into a success state.

The independent evaluator remains fixed for same-suite comparisons. The hosted workspace adapter changes how Pi produces the submission, not the hidden acceptance tests or the comparison rule. Public smoke checks, proposal text, or agent-authored tests never become the trusted grader.

## 15. Contract acceptance assertions

These are proposed implementation checks. Writing this document does not claim that any assertion currently passes.

### 15.1 Identity and authorization

- Two sessions with different owner scopes cannot read, list, mutate, stream, or download each other's campaigns, versions, attempts, credentials, jobs, or artifacts, even with known valid UUIDs.
- Unknown and wrong-owner private IDs return the same `404` envelope. They do not reveal existence through error details or cursor validation.
- Private SQL reads, updates, and deletes include explicit owner scope. Cross-owner child references fail composite constraints.
- Session cookies contain no Nebius key. A database dump contains no usable browser, gateway, or Nebius plaintext credential.
- A browser cookie cannot submit verifier results, renew worker leases, invoke internal callbacks, issue gateway grants, or release operator reserve.
- Production same-origin checks permit the configured application origin and reject an untrusted origin. Explicit local development configuration works without weakening production rules.

### 15.2 Money and concurrency

- Concurrent reservations from two processes cannot make settled estimates plus outstanding obligations exceed either account's admission limit.
- A platform with USD 89.99 of obligations rejects a new USD 0.02 ordinary reservation. It does not consume the USD 10 reserve silently.
- A campaign with USD 4.99 of compute obligations rejects a new USD 0.02 reservation under the proposed USD 5 initial campaign policy.
- Setup, agent, verifier, storage, snapshot, build, and network dimensions that are billable have valid admitted bounds or execution is disabled.
- The third platform environment is denied while two environments are active or uncertain. A verifier counts as an environment.
- A campaign inference request cannot spend beyond its request maximum, gateway allowance, campaign allowance, or model output bound.
- An operator reserve release cannot raise the overall platform hard limit above USD 100.
- An owner inference allowance increase cannot exceed `500000` micro-units, decrease the prior limit, or fall below settled plus outstanding obligations. Same-limit price consent adds no money and never starts provider work.
- A price change blocks new inference until the owner accepts a valid server-issued snapshot. Historical reservations and settled calls retain their original pricing snapshots.
- Replaying an allowance request creates one immutable grant. Updating allowance or price consent never resumes a waiting campaign automatically.
- A restart does not reset settled usage, reservations, unknown usage, concurrency slots, or campaign limits.
- Formatting USD for display cannot alter integer-ledger decisions. Malformed decimal strings and arithmetic overflow fail before a provider call.
- Repeated settlement with the same reconciliation key does not debit twice. An adjustment keeps the original estimate and audit trail.

### 15.3 External operation recovery

- A process crash after persisting an intent but before create permits safe reconciliation without a duplicate create.
- A lost create response leaves the intent uncertain, the reservation held, and the slot occupied until metadata discovery or conservative expiry resolves it.
- A stale worker cannot create a new intent, commit a result, release a reservation, or obtain new gateway authority after lease takeover.
- A lost termination response preserves exposure until a confirmed stop or enforced expiry. HTTP request completion alone does not release it.
- A restored database backup enters provider reconciliation before new admission.
- No SDK retry policy silently duplicates an uncertain sandbox create or inference transmission.
- An ambiguous lifetime extension retains its additional reservation and conservative expiry.

### 15.4 Evaluation and evidence

- Each admitted round contains 2-6 distinct sibling changes sharing one eligible parent. A low budget does not rewrite a round as a single candidate.
- Each candidate's paired comparison has fresh parent and candidate judgments for every required task under the same context hash.
- Hidden tests and expected answers never enter Pi's task workspace, optimizer context, public events, published snapshots, or downloadable public artifacts.
- A submitted canonical file is independently verified in a fresh environment without inference credentials or inherited agent state.
- Edited public tests, dependencies, grader files, symlinks, and path escapes cannot change accepted submission content or the trusted contract.
- `agent_settled`, runner exit, model prose, and public smoke-test success cannot independently produce a pass verdict.
- Infrastructure failure has null benchmark verdict and null paired delta. It cannot manufacture an improvement by lowering the parent score.
- A challenge baseline preserves the champion configuration and records the new suite. Scores across suite hashes are never labeled paired improvement.
- Rejected, failed, and interrupted evidence remains inspectable with safe artifacts and uncertainty labels.

### 15.5 API, events, and artifacts

- Exact mutation replay produces one durable effect and the original response. Different content under the same key produces an idempotency conflict.
- Campaign creation responds with a durable job reference before long-running work. Closing the browser leaves the worker's job intact.
- Snapshot cursor and snapshot state come from one consistent read. Reconnection replays all later committed events without a gap.
- First-release campaign events use bounded JSON polling at the proposed two-second interval. SSE-only negotiation returns `406 UNSUPPORTED_TRANSPORT` and creates no stream.
- Duplicate events do not duplicate graph nodes or task counts. Out-of-order revisions do not overwrite newer state.
- Expired, wrong-campaign, malformed, and future cursors follow the documented errors without revealing an inaccessible campaign.
- A missing artifact file cannot appear ready. Oversized output is bounded and explicitly marked truncated or failed.
- Public catalog and snapshot reads cannot traverse to a live private record, credential, raw log, or private artifact.
- Stop denies new gateway requests, revokes grants, schedules cleanup, and remains visibly pending while provider termination is uncertain.

## 16. Implementation decisions required before enabling paid work

The contracts above select a single persistent host, SQLite, UUID entity IDs, owner-scoped private queries, integer monetary units, a durable worker, scoped gateway authority, and separate sanitized publication. They leave these provider and deployment details to verified configuration.

| Decision                                      | Required evidence before enablement                                                                                                                                  |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite library and migration runner           | Chosen supported Node integration, foreign-key behavior, transaction semantics, WAL compatibility, and packaging on the target host.                                 |
| Public HTTPS origin and reverse proxy         | Gateway reachable from E2B, trusted-origin and proxy behavior tested, production cookies secure.                                                                     |
| Exact Nemotron model and Pi protocol revision | Supported tool calls, streaming and usage fields, tokenizer or conservative input bound, output cap, and every billable price dimension established.                 |
| E2B template and runtime identity             | Immutable template/build ID, actual Pi and Node versions, verified resource rates, finite provider timeout, discoverable intent metadata, and no blind create retry. |
| Credential encryption and signing keys        | Separate configured keys or domains, rotation identifiers, startup checks, and secret exclusion. No actual secret belongs in this document.                          |
| Provider account spending controls            | Actual USD 100 E2B limit scope and enforcement verified, current entitlement and credits understood, no assumption that promotional credit is available.             |
| Bounded inference policy                      | Operator campaign maximum, per-request maximum, token/output limits, rate limits, and explicit retry policy.                                                         |
| Backup and recovery                           | Consistent database/artifact backup, key-identifier recovery, and provider reconciliation after restore.                                                             |
| Publication policy                            | Allowlisted schema and redaction checks that produce a reviewable immutable snapshot.                                                                                |

Missing evidence keeps hosted paid execution disabled or the affected campaign waiting. It does not block public browsing of clearly identified existing evidence. No production code, schema migration, package dependency, provider request, template build, or live test is implemented by this contract document.
