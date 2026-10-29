# Hosted operations plan

Original operations design, 27 October 2026. The hosted pilot is now implemented and has executed real Pi/Nemotron work in E2B. Use the [current runbook](HOSTED-RUNBOOK.md) and [validation evidence](VALIDATION.md) for the configured demo, measured results and approved limits. The remaining sections preserve the original release-planning proposals. Permanent Linux hosting, restore rehearsal and Data Lab cloud import remain unverified.

The controlling design is [Hosted Pi evolution with E2B and Nebius Token Factory](superpowers/specs/2026-10-27-e2b-pi-design.md). The local CLI remains available separately. Hosted Pi/Nemotron evidence and historical local Codex evidence retain their original runtime identities.

The first hosted release should be a small, supervised pilot. It needs durable ownership, spend accounting and cleanup before it needs higher throughput. All operational defaults below are proposals for review. The USD 100 cumulative platform E2B compute ceiling comes from the selected direction. The USD 90 admission threshold, USD 10 reserve, USD 5 initial campaign allowance, two-sandbox concurrency limit and ten-minute sandbox timeout are proposed ways to operate within it.

The user's planned USD 5 top-up concerns Nebius inference; it is not a confirmed account balance. It does not change the USD 100 platform E2B ceiling or authorize spending USD 5 on a campaign. The proposed USD 5 campaign compute allowance is a separate E2B setting. Keep balances, platform compute allowances and user-approved inference allowances distinct in the operator view and release evidence.

## Deployment boundary

Use one persistent Linux CPU host with Node.js 24 LTS and a release-pinned runtime patch version. Run the Next.js application, an evolution worker and a reaper as separate supervised Node processes. A reverse proxy such as Caddy terminates public HTTPS and forwards to the application on loopback. E2B supplies isolated task execution. Nebius Token Factory supplies Nemotron inference. No GPU host is needed.

The host provider, DNS name and instance size remain deployment choices. A preliminary sizing target is 2 vCPU, 4 GiB RAM and 40 GiB of persistent disk, subject to deterministic load and disk-growth checks. Do not purchase an instance from this document. Host, domain and backup charges need an explicit deployment estimate and funding decision. E2B credits do not pay those charges or Nebius inference.

| Process             | Planned responsibility                                                                                                          | Restart rule                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| HTTPS reverse proxy | TLS, routing, bounded request bodies and stream-compatible proxy timeouts                                                       | Restart independently; private services remain on loopback                            |
| Next.js application | Session ownership, credential connection, private job APIs, published evidence, event reads and scoped inference gateway        | A request ends independently of a job; restart never recreates a sandbox              |
| Evolution worker    | Claim durable work, propose siblings, reserve compute, create task sandboxes, collect artifacts and dispatch fresh verification | Recover a lease and existing operation before creating further work                   |
| Reaper              | Reconcile uncertain creates, stale leases, expirations and incomplete termination                                               | Run before worker admission and remain available while workers drain                  |
| Backup scheduler    | Produce consistent database and artifact backups, verify completion and record manifests                                        | Failure alerts the operator and can close admission when recovery guarantees are lost |

These are proposed service roles, not existing service units or npm scripts. Start with one worker process and one reaper. Separate processes still compete for the same transactional concurrency and budget records. A process-local counter is insufficient. The deployment must prevent a second host from opening the same SQLite database on shared network storage.

Place the application release outside its data directory. A proposed layout is `/opt/loopbench/releases` for immutable releases and `/var/lib/loopbench` for the database, artifacts and archive. Keep the keyring outside that tree, for example in a root-managed secret file readable only by the service that needs it. Put encrypted backups on a separate failure domain. Use a dedicated service account and restrictive directory permissions. Artifacts must never become a public static directory.

The worker and reaper receive the platform E2B credential. The browser never receives it. The gateway decrypts Nebius credentials only for an admitted request. Neither task sandboxes nor the optimizer need the raw Nebius key. They use the gateway. Restrict secret distribution by process even when processes share a host.

## Proposed configuration contract

The following names are a proposed configuration interface. They are not supported settings until implementation and verification establish that interface. Actual secrets belong in host secret configuration and never in this document, source control or chat. No secret uses a `NEXT_PUBLIC_` name.

| Name                                | Purpose and planned validation                                                                                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOOPBENCH_HOSTED_ENABLED`          | Default off; admission remains closed until deployment gates pass                                                                                                            |
| `LOOPBENCH_PUBLIC_ORIGIN`           | Canonical browser HTTPS origin and allowed mutation origin                                                                                                                   |
| `LOOPBENCH_GATEWAY_ORIGIN`          | Public HTTPS origin reachable from E2B; gateway route and audience must match it                                                                                             |
| `LOOPBENCH_HOSTED_DB_PATH`          | Absolute path to the private hosted SQLite database on local persistent disk                                                                                                 |
| `LOOPBENCH_ARTIFACT_ROOT`           | Absolute private artifact directory on persistent disk                                                                                                                       |
| `LOOPBENCH_ARCHIVE_ROOT`            | Separate immutable local-history archive; no private hosted records enter this catalog                                                                                       |
| `E2B_API_KEY`                       | Platform credential for the selected E2B project; worker and reaper only                                                                                                     |
| `LOOPBENCH_E2B_TEMPLATE_ID`         | Resolved immutable template/build identity, verified against the release manifest                                                                                            |
| `LOOPBENCH_NEBIUS_BASE_URL`         | Operator-approved Token Factory HTTPS endpoint; never supplied by a user or arbitrary proxy request                                                                          |
| `LOOPBENCH_NEBIUS_MODEL_ID`         | Cheapest compatible Nemotron selected from the live eligible catalog and verified prices; initial candidate `nvidia/Nemotron-3_5-Lightning` only if available and compatible |
| `LOOPBENCH_VAULT_KEY_ID`            | Active encryption-key version, kept with ciphertext metadata                                                                                                                 |
| `LOOPBENCH_VAULT_KEYRING_FILE`      | Private secret-file path containing active and retiring vault keys; outside database/artifact backups                                                                        |
| `LOOPBENCH_SESSION_SIGNING_KEY`     | Backend signing secret for opaque demo sessions                                                                                                                              |
| `LOOPBENCH_GATEWAY_SIGNING_KEY`     | Separate backend signing secret for task-scoped gateway tokens                                                                                                               |
| `LOOPBENCH_COMPUTE_CEILING_USD`     | Proposed setting fixed at 100 for this cumulative demo; no user override or monthly reset                                                                                    |
| `LOOPBENCH_COMPUTE_ADMISSION_USD`   | Proposed ordinary admission threshold of 90, leaving 10 for uncertainty and reconciliation                                                                                   |
| `LOOPBENCH_CAMPAIGN_COMPUTE_USD`    | Proposed initial per-campaign allowance of 5; an allowance cannot increase the global ceiling                                                                                |
| `LOOPBENCH_MAX_SANDBOXES`           | Proposed value 2 across execution, verification, setup and uncertain active environments                                                                                     |
| `LOOPBENCH_SANDBOX_TTL_SECONDS`     | Proposed maximum admitted sandbox lifetime of 600 seconds                                                                                                                    |
| `LOOPBENCH_JOB_LEASE_SECONDS`       | Proposed lease duration of 60 seconds                                                                                                                                        |
| `LOOPBENCH_JOB_HEARTBEAT_SECONDS`   | Proposed heartbeat interval of 15 seconds                                                                                                                                    |
| `LOOPBENCH_REAPER_INTERVAL_SECONDS` | Proposed reconciliation interval of 15 seconds, with rate-limit backoff                                                                                                      |

Rate limits, inference allowances, artifact size limits, retention and backup destinations also need validated operator configuration. They must not acquire silent unlimited defaults. Record the effective non-secret configuration digest with each release and campaign. Keep monetary accounting in integer micro-USD internally and decimal-string micro-USD at JSON boundaries. Display rounded dollars without using those rounded values for admission.

The proposed inference allowance remains USD 0.20 per campaign, with a proposed operator ceiling of USD 0.50 per campaign. Both are configuration proposals. Neither the planned USD 5 Nebius top-up nor either proposed default grants spending permission. A live campaign needs an explicitly recorded inference allowance. Any increase requires a new explicit allowance; account top-ups must not increase it automatically.

Missing vault keys, unknown template identity, stale or missing pricing, an unverified public gateway, an unsafe network policy or an unreconciled budget must prevent new execution. Published browsing can remain available when it is safe to read its separate sanitized catalog.

## Durable database and artifacts

SQLite is suitable for this one-host pilot because all application processes share a local disk. WAL requires processes on the same host and is unsuitable for this design on a network filesystem. Use WAL with short write transactions, foreign-key enforcement and an explicitly selected durability setting. The proposed setting is `synchronous=FULL` because lost ledger commits could authorize additional spending. Record the SQLite runtime version and selected driver's support status in the release manifest. [SQLite WAL documentation](https://www.sqlite.org/wal.html)

Set a proposed five-second busy timeout on every connection and verify the effective value. A busy timeout is a contention policy, not a concurrency invariant. Budget admission, lease acquisition, creation intents and ledger settlement must use transactions and uniqueness constraints. Never hold a write transaction open across an E2B call, inference stream or artifact transfer. Exhausting the bounded database wait returns a retryable local failure without initiating a provider operation. [SQLite busy timeout documentation](https://www.sqlite.org/pragma.html#pragma_busy_timeout)

The database owns session IDs, credential versions and revocations, campaigns, immutable harness identities, task attempts, ordered events, leases, creation intents, sandbox lifetimes, concurrency slots, compute reservations and inference reservations. A worker lease includes a fencing generation. Every state-changing result must still match the current generation. Lease expiry permits reconciliation, not automatic recreation of an ambiguous sandbox.

Monitor WAL size and checkpoint duration. Bound event batches and close event-read transactions promptly so browser clients cannot retain long database snapshots. A busy database should delay work; it must not silently fall back to an in-memory queue, JSON ledger or second database. Disk-full and database-integrity failures close admission immediately.

Keep bulky logs, extracted submissions, diffs, evaluator results, harness bundles and publication snapshots in the private artifact directory. Use generated IDs and content digests rather than untrusted filenames. Write into a bounded staging area, verify size and digest, atomically finalize the artifact, then commit its database reference. A crash can leave an unreferenced file, which later garbage collection can quarantine. A committed result must never point to an unverified partial file. Keep evidence unavailable or incomplete if extraction fails; do not substitute a successful claimed result.

Raw Pi logs and submissions are untrusted input. Sanitize display output, avoid following symlinks and reject path escapes. Extract only the permitted canonical `src/solution.cjs` submission. Agent changes to tests, dependency manifests, grader files or harness configuration cannot alter the verification contract. Hidden expected answers and verifier inputs are private even if a result is later published.

Proposed retention for review is seven days for bounded raw task streams, thirty days for private extracted artifacts, and thirty days for encrypted rolling backups. Retain the compact budget ledger, ownership tombstones and provenance needed to explain published evidence. Do not garbage-collect referenced evidence or unsettled operations. Confirm retention and deletion wording before collecting user data. The pilot must stop accepting artifacts when free-disk thresholds are crossed instead of deleting evidence opportunistically.

## Backup, restore and release migration

Use SQLite's online backup facility or an equivalent verified consistent snapshot. Copying only the live `.sqlite` file while WAL writes continue is not an acceptable backup procedure. Include a manifest of schema version, release version, artifact digests and ledger position. Immutable artifacts allow the backup to copy exactly those referenced by that database snapshot without changing them. Verify referenced files and encrypt backups before transfer. [SQLite online backup documentation](https://www.sqlite.org/backup.html)

Proposed targets are an hourly backup during the supervised demo, a backup immediately before migration, a one-hour recovery point and a two-hour recovery time. These are targets to prove in a restore rehearsal. They are not current guarantees. Maintain separate recovery custody for the vault keyring. A database backup without its decryption keys cannot restore connected credentials; keeping plaintext keys beside that backup defeats the separation.

Restore procedure:

1. Close admission and stop worker claims. Keep an isolated reaper or operator connection available for E2B reconciliation.
2. Restore a verified database and its referenced immutable artifacts into a separate data directory. Verify database integrity, schema compatibility, manifests and file digests before changing the active path.
3. Disable every restored credential and require its session owner to reconnect before future inference. Apply revocation/deletion history and credential tombstones newer than the snapshot. Revoke restored gateway-token generations and invalidate restored worker leases. A backup must not reactivate a deleted credential or give two workers the same lease.
4. List provider environments for this deployment/project, including all result pages. Compare creation metadata with the restored ledger. Treat provider activity after the snapshot as unresolved liabilities, even when its row is absent from the restored database.
5. Retain a conservative reservation for every unmatched or uncertain operation. Reconcile provider usage and previous ledger exports before restoring admission. A rollback must never reset the cumulative USD 100 total.
6. Restore browsing first, then the gateway, reaper and worker. Reopen admission only after the operator records reconciliation and the doctor checks pass.

Back up before applying a versioned schema migration. Stop writers for migrations that require an exclusive change and record the migration's completion atomically. Prefer additive migrations during the pilot. An old binary must refuse an incompatible schema. If reverting application code is insufficient, restore the compatible snapshot using the procedure above and reconcile all later spending before execution resumes.

## Public gateway and credential lifecycle

E2B must reach `LOOPBENCH_GATEWAY_ORIGIN` over public HTTPS with a trusted certificate. A host bound only to `127.0.0.1` cannot provide that path. Local development will need an explicitly configured public endpoint for integration. Do not expose the existing local JSON viewer or arbitrary development routes merely to make a gateway reachable.

Browser mutations use the signed session and same-origin checks appropriate to the configured deployment. The gateway uses its own scoped authorization token and must not depend on browser cookies or reject legitimate E2B requests for lacking a browser `Origin`. Restrict tokens to campaign, task, role, selected model, credential version, request allowance and expiry. Check revocation and remaining allowance on every request. Cap expiry at the admitted sandbox lifetime. A browser-session token cannot be used as a gateway token.

The gateway permits only selected inference routes on the configured Token Factory host. It validates requested models and token bounds, reserves the maximum estimated request charge before forwarding and reconciles returned usage. It rejects arbitrary hosts, redirects and proxy routes. Record provider request IDs, usage, cached-token fields when returned, timings and timestamped pricing. Strip authorization headers and credential-bearing provider error content from stored diagnostics. Unknown usage is unknown, never zero.

Select the cheapest compatible Nemotron using the connected credential's live eligible model catalog and a timestamped official pricing snapshot. Compare both uncached input and output prices against the bounded workload rather than ranking by input price alone. Require verified Pi tool calling and the structured JSON behavior needed by the proposer. Catalog presence alone does not establish either capability. The initial candidate is `nvidia/Nemotron-3_5-Lightning` if it is available, passes those checks and remains the cheapest compatible choice. Prefer it when compatible prices tie. This is a conditional selection policy, not a claim that its current account availability, price or compatibility was tested while writing this document.

Reserve each request at uncached input prices plus its maximum bounded output cost, including billable reasoning output where applicable. Treat cache discounts as reconciled savings only when provider usage establishes them. Pin the actual selected model for Pi execution and harness improvement within a comparison. If it becomes unavailable, fails compatibility or lacks verified pricing, checkpoint with a visible waiting reason. Never fall back to a Super or Ultra variant automatically, or change the model midway through a paired comparison. A different model needs explicit selection, a fresh allowance check and a separately identified comparison.

Connecting a BYOK Nebius key creates a private encrypted credential record owned by the current demo session. Keep the input transient in the browser and send it only over HTTPS. Never put the raw key in URLs, browser local storage, logs, Pi sessions or graph records. Use authenticated encryption with unique nonces and versioned key identifiers. A proposed envelope scheme gives each credential a data key wrapped by an external vault key. Queue payloads contain only credential references. Authentication verification through the model catalog does not prove inference credit, model availability under load or a successful billable response. Allow a separately budgeted live request only in the release pilot.

| Action                                                 | Required planned behavior                                                                                                                                                                                      |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User replaces a key                                    | Verify the replacement without exposing it; commit a new credential version; revoke old gateway grants; checkpoint affected work for explicit resume. No fallback to the old key                               |
| User disconnects or deletes a credential               | Deny new inference immediately, revoke associated grants, stop affected active attempts and clear the live ciphertext/wrapped key after ownership checks. Preserve minimal non-secret audit and spend evidence |
| Provider revokes the key or reports insufficient funds | Move affected work to a visible waiting state; preserve pending siblings and reservations; no background paid retry                                                                                            |
| Operator rotates vault encryption keys                 | Add a versioned key, rewrap credential data keys transactionally, verify recoverability and update backup-recovery custody before retiring the old key                                                         |
| Operator rotates gateway signing keys                  | Revoke old grants and generations, stop or checkpoint affected attempts, then issue fresh grants only through admitted work                                                                                    |
| Operator rotates the platform E2B key                  | Close admission, keep an authorized cleanup path, reconcile owned sandboxes, install the replacement and prove listing/cleanup before revoking the old credential                                              |
| Suspected secret exposure                              | Stop admissions, revoke the affected grants and relevant provider key, preserve sanitized incident evidence and inspect usage before reopening                                                                 |

Deleting a saved Nebius key disconnects LoopBench. It does not revoke that key at Nebius or revoke its use in another application. The user or authorized operator must use the provider's key-management controls for provider-side revocation. An already forwarded inference request cannot be unsent; retain its reservation until usage is known. Ciphertext may remain in WAL pages and retained backups until their scheduled expiry. Do not promise immediate physical erasure. A restore must honor deletion tombstones before any credential can be used.

Keep revocation/deletion history outside the application rollback snapshot path and back it up separately with access controls. Record tombstones durably before acknowledging completed deletion. A missing or incomplete history cannot authorize credential reuse. The conservative pilot restore policy disables all restored credentials and requires owner reconnection even when history is available. Lost demo-session cookies do not prove ownership of earlier jobs or keys. Do not allow an unauthenticated claim-by-job-ID recovery path.

## Template, network and verification controls

Start from E2B's official `pi` template. The published guide establishes that this template exists and can be extended; it does not establish the Pi or Node version inside this account's resolved build. Resolve an immutable template/build identity, record actual Pi and Node versions, dependency lock digest, benchmark source/evaluator digests and network policy. Derive a secret-free template only when dependencies or pins require it. Preserve the user's existing local Pi installation. [Official E2B Pi guide](https://docs.e2b.dev/agents/pi)

Pin the selected E2B SDK, Pi protocol and host runtime versions in the release manifest. Compare actual versions at launch with that manifest. A moving `pi` alias is not enough for a reproducibility claim. Fail the attempt as infrastructure/version mismatch if the required identity cannot be established. Never snapshot injected user credentials, gateway tokens, solved task state or Pi process memory into a reusable base. Any approved reusable snapshot must be created before credentials and task-specific live state exist. [E2B snapshot semantics](https://docs.e2b.dev/sandbox/snapshots)

Prepare task workspaces and dependencies before evaluated execution. Hide E2B controller and sandbox-access tokens from Pi and generated code. During a Pi attempt, deny all outbound traffic and allow only the exact LoopBench gateway hostname and individually documented required first-party artifact endpoints. Do not allow direct Token Factory access, arbitrary package registries, wildcard customer domains or general internet access. Domain rules filter HTTP(S); verify denied non-HTTP traffic, DNS behavior, direct-IP paths and host-level cloud metadata/private-network access rather than assuming hostname filtering covers them. The first pilot should need only the gateway. [E2B network rules](https://docs.e2b.dev/network/internet-access)

Use a fixed supervisor to supply structured task input and control. Do not interpolate model/user text into shell commands. Run the version-matched Pi event protocol, persist bounded durable output and require both authoritative Pi settlement and runner completion before extracting a submission. Reconnecting to a background command does not replay its original stdout/stderr stream automatically, so the runner must keep recoverable output files and event cursors. [E2B background command recovery](https://docs.e2b.dev/commands/background)

Each benchmark task attempt starts clean. Each parent's paired rerun starts clean too. A harness node can have many task and verifier sandboxes; sandbox ancestry is not the harness-evolution graph. Start sibling harnesses individually from the same prepared template/task input in the first release. Defer batch fork optimization until independent child metadata, reservation and partial-failure recovery have live evidence.

After extraction, stop the execution sandbox when its evidence is safely captured. Create a fresh verifier sandbox using another admitted concurrency slot and reservation. Send it the immutable evaluator, hidden cases and canonical submitted file. It receives no inference credential, gateway token or agent-edited test tree. The API host never executes submitted code. Verify the six existing `coding-adversarial-v1` function contracts honestly as small implementation workspaces. A one-task live smoke check establishes plumbing only; it cannot establish a six-task improvement.

## Compute admission and provider verification

The ledger is cumulative across all sessions, campaigns, worker/reaper processes, deployments and restarts. It has no calendar reset, deletion reset or automatic top-up. Compute reserved for task execution, verifier sandboxes, setup, approved builds and other applicable billable resources counts against the same policy. Price storage/network/build charges where they apply before admission. Keep user Nebius inference accounting separate from platform E2B compute accounting.

Ordinary admission requires settled compute estimates plus all outstanding reservations plus the proposed reservation to stay within USD 90 and within the campaign allowance. Maintain the separate USD 100 overall ceiling. The remaining USD 10 is held for uncertainty and reconciliation. Only an audited operator action may release part of that reserve, while retaining the overall ceiling. Do not present a lower revised estimate as cash refunded by the provider.

Before creating an environment, reserve its worst-case configured CPU/RAM cost for the full admitted lifetime using a timestamped verified price snapshot. Reserve a global slot at the same time. Unknown create outcomes retain their full reservations and slots. Verification and setup count toward the two active-environment limit. An operator's manual sandbox in the same project must be discovered and included, or the dedicated project must exclude such work.

Ten minutes is the proposed provider-enforced lifetime of each admitted sandbox, not an unlimited campaign deadline. Timeout changes require a new transaction against both ledgers before the provider receives an extension. Do not auto-resume, auto-pause/restore or extend a sandbox through a convenience reconnect API without checking its actual lifetime behavior. An expired sandbox may end a task with incomplete evidence; it cannot become a passing result.

The initial USD 5 campaign allowance is a proposal intended to accommodate a first generation with wider branching. It is not a price quote or a promise that a generation fits. Preflight the six-task baseline, every fresh parent rerun, every candidate attempt and their fresh verifiers using the actual template resources and prices. A six-sibling generation with a baseline and per-sibling parent reruns has 78 task attempts and up to 156 execution/verifier environments. Schedule them within two global slots. If the reservation cannot fit, show a resource waiting state or let the operator approve a different campaign allowance within the global cap. Do not reduce the required 2-6 siblings to one or call an incomplete round complete.

Before enabling hosted execution, the operator must inspect the actual E2B account and record:

- Selected workspace/project, credential scope, current accumulated usage, remaining promotional credit if any, and who can create additional billable resources.
- A dashboard spending limit set to USD 100, its actual account/project scope, reset period, metering delay, threshold behavior and treatment of already running sandboxes.
- Actual CPU/RAM pricing, applicable additional charges, plan fees, minimums, runtime and concurrency limits, and API rate limits for create/list/terminate/reconnect.
- How a stopped/expired environment becomes visible in provider usage and how long authoritative reconciliation can take.
- Whether unrelated activity shares that limit. A provider monthly budget cannot by itself enforce LoopBench's cumulative lifetime ledger.

E2B documents per-second running-compute billing and dashboard spending limits. It does not, on that page, establish that this account's limit is a zero-overshoot cumulative USD 100 hard stop. Confirm that behavior through account evidence or provider support before claiming an invoice guarantee. Promotional credit is an account entitlement, not the platform's spending policy. [E2B billing and limits](https://docs.e2b.dev/billing)

If the operator cannot verify applicable prices or spending-limit behavior, the hosted feature remains disabled for public execution. Record that limitation plainly. The application ledger and operational reserve reduce risk; they do not manufacture a provider billing guarantee.

## Crash recovery, uncertain operations and shutdown

The first side effect of a sandbox attempt must be a committed creation intent. It contains a unique creation-intent UUID, deployment/campaign/attempt/role IDs, lease generation, template identity, expected resource shape, expiry and reservation. Attach the discoverable identity as provider metadata. A database uniqueness constraint prevents two owners from starting the same logical intent.

Only after that commit may the worker call E2B create. On a confirmed response, persist the sandbox ID, supervisor process ID, event cursor and deadline before considering the attempt started. If launching the supervisor has an ambiguous outcome, reconcile its process and durable log identity. Do not launch a second Pi process with the same allowance because a response timed out.

If create returns no authoritative result, mark the intent uncertain. Never blindly retry the non-idempotent create request. The reaper searches all relevant provider result pages by deployment and creation metadata. A matching sandbox can be adopted only under a current fenced lease or terminated under the recorded cleanup policy. Multiple matches are an incident: stop admission, account for every match and terminate attributable duplicates. Missing metadata or a failed listing is not proof that no sandbox exists.

Inspect retry behavior in the pinned SDK and its transport. Current E2B documentation describes automatic SDK retries for some rate-limited requests, so release requires evidence that ambiguous create outcomes cannot trigger an uncontrolled duplicate create. Use a bounded no-retry creation transport if the selected SDK cannot express that policy. Never imply that a database UUID alone makes an external API idempotent. [E2B API retry behavior](https://docs.e2b.dev/billing)

The reaper runs every proposed fifteen seconds, with bounded jitter/backoff for provider limits. A worker heartbeats every fifteen seconds against a sixty-second lease. Lease loss immediately prevents its future state transitions and gateway grants. A new owner reconciles before continuing. Track provider deadlines with conservative clock-skew margins and verify host clock synchronization. If ownership, expiry or complete listing cannot be established, retain the liability and block further admission.

On stop, expiry or failed recovery, revoke gateway grants first, then request termination for every owned environment and record each outcome. A lost termination response remains `termination_uncertain`. Release its concurrency slot and unused compute reservation only when provider stop is confirmed or a conservative, established maximum expiry has elapsed. Any earlier compute remains settled or conservatively reserved pending usage reconciliation. A failed cleanup must never appear as a finished clean campaign.

Proposed graceful deployment sequence:

1. Close new admission and stop worker claims. Continue browser reads, gateway service and reaper reconciliation.
2. For routine maintenance, let already reserved work reach a checkpoint within its existing lifetime. Do not extend a sandbox to make deployment convenient.
3. If a fast shutdown is required, revoke grants, request cancellation and terminate active sandboxes. Use a proposed ninety-second process shutdown window; persist unresolved cleanup before exit.
4. Keep the reaper running until all known operations are stopped, conservatively expired or explicitly retained as unresolved liabilities. A machine crash still relies on finite provider TTLs and restart reconciliation.
5. Start the new gateway and reaper, reconcile, then start worker claims. Open public admission last.

A user pause finishes or checkpoints the current admitted unit and saves pending siblings. A user stop cancels further work, revokes grants and initiates cleanup. Neither operation erases failed or rejected artifacts. Browser closure is neither pause nor stop; durable worker ownership continues within the admitted allowance.

## Failure matrix

| Failure                                                   | Planned campaign/operator result                                                    | Accounting and recovery                                                                 |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Browser closes or event stream disconnects                | Job continues; browser later reads ordered events after its cursor                  | No duplicate job or new provider request from reconnect                                 |
| API restarts                                              | Worker retains ownership; gateway requests may fail visibly                         | Interrupted inference keeps an unknown reservation until reconciliation                 |
| Worker crashes                                            | Current lease expires; reaper/new owner reconcile                                   | Existing sandbox/process is found before any replacement                                |
| Create response is lost                                   | Creation intent becomes uncertain; new admission may block                          | Retain full lifetime reservation and slot; metadata lookup or conservative expiry       |
| More than one sandbox matches an intent                   | Incident; close admission and clean all attributable duplicates                     | Retain all discovered liabilities; review SDK retries and provider usage                |
| List/metadata API is unavailable                          | Recovery waits with a visible infrastructure reason                                 | Never conclude zero active sandboxes from a failed request                              |
| Termination response is lost                              | Cleanup remains uncertain                                                           | Hold slot and remaining liability until stopped or conservatively expired               |
| Sandbox TTL expires                                       | Task is incomplete unless authoritative artifacts and results were already captured | Reconcile actual usage; no unbudgeted automatic restart                                 |
| Pi exits without terminal protocol evidence               | Infrastructure/protocol failure, not a benchmark score                              | Preserve log and attempt; fresh explicit retry requires a new admission                 |
| Canonical artifact is missing, oversized or a symlink     | Submission extraction fails                                                         | Preserve bounded diagnostics; do not execute another path                               |
| Fresh verifier fails to start or returns invalid protocol | Evaluation infrastructure failure                                                   | No score or favorable parent delta; reserve/settle its real compute                     |
| Nebius 401/403, funds or quota error                      | Visible waiting state, pending siblings retained                                    | Revoke affected grants and stop background retries; usage stays unknown when unreported |
| Nebius stream disconnects after forwarding                | Inference outcome uncertain                                                         | Retain maximum reserved request cost pending usable usage evidence                      |
| Compute admission threshold is reached                    | No new creates or extensions                                                        | Existing work may finish only within prior reservations                                 |
| SQLite is busy beyond timeout                             | Retryable local failure before provider side effect                                 | Preserve transactions and leases; no alternate ledger                                   |
| Disk is full or artifact transfer fails                   | Close admission; evidence marked incomplete                                         | Keep cleanup path active and preserve spent/unknown liabilities                         |
| Database or vault is unavailable                          | Fail execution closed; allow only safe published reads                              | Reaper uses recorded recovery procedure; no plaintext fallback                          |
| Host restarts after snapshot restore                      | Restore/reconciliation mode                                                         | Apply tombstones, find provider activity since snapshot and retain cumulative spend     |
| Public gateway/DNS/TLS fails                              | Task reports infrastructure failure or waits at checkpoint                          | Stop new admission; preserve reservations and terminate unusable attempts               |

Provider/infrastructure failures must stay distinct from failed benchmark assertions. A parent infrastructure failure cannot lower its score and manufacture an accepted improvement.

## Diagnostics and operator runbooks

Implement a future read-only hosted doctor and an operator status view before public admission. Their names and invocation remain implementation work. They must never create a sandbox or send a paid inference request unless a separately selected live-pilot mode is explicitly authorized. Exclude keys, authorization headers, token values, raw prompts and secret-file contents from output.

The doctor should report release/schema versions, effective non-secret configuration, durable path permissions, free disk, last successful backup and restore rehearsal, SQLite mode/busy timeout/integrity, active leases and reaper heartbeat, oldest unresolved intent, sandbox counts by role/state, settled/reserved/remaining compute, unknown inference usage, pricing age and gateway TLS/DNS reachability. Provider-list diagnostics must clearly distinguish an empty successful result from an incomplete or failed listing.

Alert the operator when the reaper misses two intervals, a lease expires with an active operation, cleanup/creation uncertainty persists, backups miss their target, WAL/disk grows beyond configured thresholds, or provider usage differs materially from the ledger. These alerts require reconciliation, not silent retries. Restrict the status view to the operator. Public clients see only their owned job's sanitized state and explicitly published snapshots.

### Start or reopen hosted execution

1. Confirm the selected release, immutable template, evaluated benchmark/evaluator digests and pinned pricing snapshot.
2. Verify the actual E2B spending-limit record and the cumulative restored ledger. Confirm no unrelated provider workload can escape that ledger.
3. Start the gateway and reaper with admission closed. Run read-only diagnostics, reconcile existing environments, and verify backup freshness.
4. Start the worker. Enable admission only after all gates pass. Record the operator decision and effective configuration digest.

### Suspected runaway spend or lost worker

1. Close admission and all timeout extensions. Revoke affected gateway grants.
2. List every environment in the configured deployment/project and compare metadata, deadlines and reservations. Keep a record of incomplete pagination or API failures.
3. Terminate owned environments with bounded requests. Reconcile each response and TTL independently. Do not mass-delete environments in an unrelated project or account.
4. Compare timestamped provider usage with the ledger, retain uncertain amounts and investigate any duplicate creation. Reopen only after ownership, budget and cleanup are explained.

### Quota, funds or credential failure

1. Show the precise sanitized waiting reason to the session owner. Preserve the unstarted siblings and failed attempt.
2. Stop further provider requests for that credential and close its gateway grants. Finish cleanup for its task sandboxes.
3. The owner replaces/re-enables the credential or the operator verifies provider access. Resume is an explicit action with fresh admission; it does not erase spent requests.

### Data or disk incident

1. Close admission and preserve the last known-good backup. Stop writers if database integrity is uncertain.
2. Keep a controlled cleanup connection available. Capture non-secret ledger and provider state before replacing storage.
3. Restore into a new data directory and follow the restore procedure. Never free a budget reservation by deleting a corrupt record.

### Roll back a release

1. Drain admission and checkpoint or terminate owned work. Save a consistent database/artifact manifest and ledger export.
2. Return to the previous immutable application release only if it accepts the current schema. Otherwise use the pre-migration snapshot and restore reconciliation.
3. Keep new credentials disabled until revocation history is applied. Preserve newer evidence as a quarantined archive when an older binary cannot read it.
4. Verify the doctor, public/private access boundary and provider cleanup before reopening. Turning hosted execution off should leave safe published evidence browsable.

## Moving local JSON history safely

The existing `.loopbench` records belong to the local operator and have no hosted session owner. Treat them as an immutable archive. Make a read-only copy, inventory source files and digests, and validate records without rewriting their observed outcomes or timestamps. Keep active local campaign locks and processes outside the migration. Do not silently resume a local campaign under a hosted user's Nebius key.

Explicitly assign the imported archive to an operator/archive owner. Imported records are private until that owner deliberately publishes a sanitized snapshot. Publication needs a recorded decision and source digest. Exclude keys, raw credential-bearing output, local absolute paths, private task material and hidden verifier data. Do not convert all old records into public evidence merely because the old local viewer exposed one global catalog.

Hosted private jobs live in the new database and artifact store. The old global tree/campaign GET endpoints must either remain loopback-only for local mode or read only the explicitly published sanitized archive in hosted mode. They must never scan hosted private storage. New private APIs enforce session ownership for jobs, artifacts and event cursors, including guessed IDs and cross-session pagination. Test those boundaries before connecting any real credential.

Keep the archive's original tree/node IDs and source digests, with a source namespace that prevents collisions with new hosted records. Label evidence by actual execution backend. Local Codex history cannot become a Pi/Nebius success through import. Any future continuation must create new hosted ownership and execution records while retaining the original evidence unchanged.

## Release gates and bounded live pilot

No public execution until the following gates have written evidence:

| Gate                  | Required evidence                                                                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage and ownership | Concurrent reservation/lease checks, cross-session denial, archive/public boundary checks and no secrets in artifacts/events                                                                    |
| Recovery              | Crashes before/after create, lost response, uncertain termination, stale fencing generation, interrupted inference, incomplete provider listing and restore after later spend                   |
| Sandbox control       | Actual provider metadata discovery, pinned identity, finite timeout, deny-all network checks, fresh verifier isolation and confirmed cleanup                                                    |
| Pi semantics          | Version-matched terminal event parsing, durable log recovery, canonical extraction and no success inferred from exit alone                                                                      |
| Billing               | Account-specific prices, limits, spending-limit behavior, remaining credit, separate Nebius balance/approved inference allowance and provider/ledger reconciliation                             |
| Model selection       | Live eligible catalog, input/output price comparison, uncached reservation and verified Pi tool/proposer JSON support for the actual selected Nemotron model; no automatic Super/Ultra fallback |
| Operations            | Tested backup/restore, rollback rehearsal, doctor output, reaper alerts and secret rotation/deletion behavior                                                                                   |
| Product evidence      | Real 2-6 sibling proposals, honest task outcomes, failed/rejected artifacts retained, browser reconnect and separate compute/inference reporting                                                |

First run deterministic mocked-provider and local fixture checks. Planned future verification includes the repository's `npm run typecheck`, `npm test` and `npm run build`, plus dedicated hosted recovery checks that do not exist yet. None of those commands was run for this documentation task. Fixtures remain outside the production catalog. Passing them does not prove a live provider integration.

After the operator explicitly authorizes paid validation, propose one live-pilot campaign with an explicit lower USD 1 E2B allowance and an independently approved Nebius allowance within the connected user's funds. Keep the proposed USD 0.20 inference default and USD 0.50 operator ceiling unless a new allowance is explicitly recorded. The user's planned USD 5 Nebius top-up does not establish available funds or authorize exhausting an account balance. The compute override replaces the proposed ordinary USD 5 E2B campaign default for the one-task smoke only. The USD 1 is a maximum proposed reservation, not a promise the pilot fits. Preflight prices and worst-case work first. Include a small cleanup/reconciliation allowance inside that pilot limit and retain the platform's separate USD 10 operational reserve.

The live pilot should verify one prepared task, real Pi tool use against the chosen Nemotron model through the gateway, two distinct measured sibling harness artifacts, a fresh paired parent rerun for each sibling, fresh independent verifier results, artifact/event recovery, browser reconnection and confirmation that every pilot environment stopped. Exercise at least one controlled recovery path only if its worst-case reservation fits. Keep the two-sandbox concurrency and ten-minute timeout constraints throughout.

If the pilot cannot fit its allowance, checkpoint it with an honest result and do not extend the allowance automatically. A failed pilot retains all costs and evidence. A one-task smoke pilot cannot justify publishing a full-suite improvement. The next release gate is a budgeted complete six-task paired comparison with at least two siblings on an unchanged benchmark/model/evaluator revision. Only actual positive deltas can count as accepted improvements.

Record the full pilot manifest, actual provider/model/template identities, task/submission digests, outcome, request usage, settled and unknown cost, and cleanup evidence. Do not add successful demo trees by hand. Data Lab export, trace-to-verdict dataset association, repository-repair benchmarks and Nemotron weight training are not completed integrations. Data Lab is future work and is not a prerequisite for this first pilot.

## Five-day implementation proposal

This is a five-working-day target for a narrow supervised pilot after the plan is approved. It is not a promise of public production readiness. Existing local evaluation and graph behavior should be reused. Recovery or provider-account uncertainty can move the live pilot beyond day five; the safe deliverable is then deterministic evidence and a clearly blocked release gate.

| Task group               | Work and independent review boundary                                                                                                             | Depends on                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| A. Durable hosted state  | Schema, session ownership, event ordering, vault references, integer-money ledger, transactional lease and reservation contracts                 | Reviewed architecture and data contract                                                         |
| B. Gateway and vault     | BYOK lifecycle, exact provider routes/models, request reservations, streaming accounting, grant revocation and secret exclusion                  | A interfaces; can proceed against deterministic provider fixtures                               |
| C. E2B lifecycle adapter | Pinned create/list/connect/terminate behavior, metadata, no ambiguous create retry, timeout/network policy and durable command recovery          | A creation-intent contract; can proceed against a fake provider                                 |
| D. Task/verifier adapter | Immutable workspaces, Pi protocol parser, canonical extraction and isolated existing evaluator                                                   | Manifest contract and selected Pi protocol; can proceed with local fixture events               |
| E. Worker and reaper     | Durable campaign execution, all 2-6 siblings, parent reruns, fresh verification, restart/stop/pause and reconciliation                           | A, B, C and D contracts; integration follows their focused checks                               |
| F. Browser and archive   | Credential/job controls, owned events/artifacts, cost/waiting states, existing horizontal graph, explicit publication and local archive boundary | A/B API contracts; can use isolated fixture data outside production catalog                     |
| G. Host operations       | Release packaging, HTTPS, secret custody, persistent paths, backups/restore, process supervision, diagnostics and rollback                       | Configuration/schema contracts; account and host choices can be reviewed alongside other groups |
| H. Release evidence      | Adversarial recovery checks, spend/limit review, bounded live pilot and honest published results                                                 | A through G deterministic gates; live operations require separate authorization                 |

| Day | Realistic target                                                                                                                        | Exit evidence                                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | Finalize contracts; implement A; prepare fixture interfaces for B/C/D and archive inventory for F                                       | Durable owner/lease/budget invariants and explicit migration/publication decisions                              |
| 2   | Implement B, C and D as separate bounded modules; begin G account/HTTPS/backup planning                                                 | Deterministic provider, Pi-event, artifact and credential lifecycle checks; unresolved provider facts listed    |
| 3   | Integrate E with single worker/reaper; build F against owned records; configure G on the selected host after authorization              | Crash/restart, pause/stop, fresh verifier, two-slot admission and browser reconnect checks                      |
| 4   | Rehearse backup/restore and rollback; attack failure paths; review SDK retry and egress behavior; complete account limits/pricing gates | No unaccounted create/termination path, no private legacy catalog leakage, operator doctor and cleanup evidence |
| 5   | Run H deterministic release checks; conduct the bounded live pilot only when authorized and gates pass                                  | Real costs/results/cleanup recorded, or an explicit blocked release report with retained evidence               |

The task groups identify separable ownership and review work. They do not require concurrent agents or multiple writers to the same database/schema files. Agree on interfaces first, then integrate in dependency order. Defer multi-host PostgreSQL, batch forks, Data Lab, rich repository-repair suites, account login and unrestricted generated Pi extensions until the supervised pilot can explain every sandbox, every credential grant and every dollar reserved.
