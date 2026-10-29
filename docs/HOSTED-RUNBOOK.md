# Hosted pilot runbook

## Token Factory provider

The project now has verified sandbox permissions. Configure `LOOPBENCH_EXECUTION_PROVIDER=tokenfactory`, `NEBIUS_API_KEY`, `NEBIUS_PROJECT_ID` and, for permanent hosting, `LOOPBENCH_TOKEN_RUNNER_MANIFEST` in the private worker/reaper environment. The web process needs the approved manifest for readiness and does not need the controller key. Browser inference keys remain encrypted, owner-scoped BYOK connections.

`npm run hosted:token-runtime` imports the pinned official Node image and prepares Pi once. Retain its private operation journal and resulting image UUID. `npm run hosted:token-probe` verifies actual command/file I/O with guest networking disabled and confirms cleanup. `npm run hosted:token-pilot` starts the operator's real campaign; `-- --resume` continues it. Ordinary browser-created experiments run through `npm run hosted:worker`. Run `npm run hosted:reaper` separately for both providers.

`npm run hosted:token-probe -- --stress` uses a separate private operator test session and performs 30 exact file round trips of 275000 bytes. It makes no inference calls. A failed subprocess write records the destination, exit code and bounded stderr privately; file contents and credentials are not included. An infrastructure failure remains unscored and waits for explicit recovery.

Only runtime preparation enables Token Factory guest networking. Agent and verifier operations are disposable and have no guest NIC. The host relays scoped inference over the control API. Never treat an operation `cost` field as USD without confirmed units. Status reports Token Factory usage separately from the E2B money ledger.

HTTP 425 on status/result reads means readiness is pending. Bounded GET polling honors `Retry-After`. The subprocess-start contract also explicitly defines 425 as rejection before exec is accepted, so that specific response can be retried within its readiness deadline. An ambiguous 504, transport failure, instance creation or inference POST is never blindly replayed. The reaper retains uncertain intents until ownership and a terminal provider state are confirmed.

Public pages follow only newer explicitly published copies of the same public campaign. Turn off follow mode to inspect the original immutable snapshot. Fresh-parent task counts are published separately from harness graph nodes.

The user lifted the previous project validation cap. That authorization does not silently enlarge unrelated browser visitors' allowances. Permanent Linux deployment remains pending.

## Earlier E2B pilot and deployment

The local live demo has executed real Nebius/Nemotron inference and Pi 1.4.0 on Node v24.15.0 in E2B, using the verified template `x9swjt4humgif3wctzqj`. Its public HTTPS graph, node selection and Tree/Stats controls have been checked in the in-app browser. The latest publication has seven records: one failed baseline attempt, one scored baseline and five measured sibling comparisons. Two siblings improved from 0/6 freshly rerun parents to 1/6 candidates. Their 1/6 scores do not exceed the original baseline's 1/6. Earlier rejected comparisons remain unchanged. See [Validation evidence](VALIDATION.md).

That demo runs on the local Windows host through a temporary public HTTPS tunnel. The permanent Linux/systemd/Caddy deployment assets described below have not been deployed. Provider compatibility is supported by the actual runtime and inference probes; neither deterministic tests nor the completed comparisons establish a measured harness improvement.

For a permanent deployment, run one Linux CPU host with a release-pinned Node 24 LTS patch, local persistent disk, the web application, one worker and one reaper. Node 25 is supported for local checks; the sandbox manifest pins its own exact Node 24 version. The web service listens on loopback and Caddy exposes HTTPS. E2B runs agent and verifier environments. Nebius inference is funded by the user's connected key. Hosting, domain and backups have separate costs.

## Prepare a private release

Use `/opt/loopbench/releases/<release>` for code and `/opt/loopbench/current` for the selected release. Include `hosted/migrations`, `benchmarks`, `core`, `sandbox/pi`, `scripts`, `node_modules` and the built Next application in the release: migration and verifier files are read at runtime. Run `npm ci`, `npm run typecheck`, `npm test` and `npm run build` during release preparation. Keep the lockfile and the exact host Node patch with the release. Do not use a network filesystem for SQLite.

Create a dedicated `loopbench` service user. Make `/var/lib/loopbench` and `/var/lib/loopbench/private` owned by that user with mode `0700`. Keep `/etc/loopbench` root-managed and readable by the service group only. Filled environment files and the vault keyring are secrets. Keep them out of source control, application artifacts, backups of the database and chat. The service units expect `/usr/bin/node`; adjust that path to the actual pinned runtime.

Copy `.env.hosted.example` into private `/etc/loopbench/web.env` and `/etc/loopbench/worker.env` files. Generate independent random signing and fingerprint secrets of at least 32 bytes. The web file does not need `E2B_API_KEY`; only worker/reaper environments receive the controller key. Current context initialization requires the backend signing and vault configuration in all processes. No `NEXT_PUBLIC_` environment variable carries a secret. The Nebius key is submitted through the HTTPS setup page, then encrypted in SQLite; there is no platform fallback inference key.

The keyring file has this shape, with real externally generated 32-byte base64 keys:

```json
{
  "activeKeyId": "vault-2026-01",
  "keys": { "vault-2026-01": "BASE64_32_BYTE_KEY_FROM_SECRET_STORE" }
}
```

Add an approved `runner-manifest.json` outside the repository and set `LOOPBENCH_RUNNER_MANIFEST` to its absolute path. The example in `sandbox/pi/runner-manifest.example.json` is deliberately unusable. Record immutable agent and verifier template IDs, Pi version, exact Node version, actual CPU/memory profile, supervisor SHA-256 and request-identity extension SHA-256 after verifying the built templates. Changing either runtime file invalidates the manifest. Set the combined E2B per-second rate only after verifying the actual profile and all applicable charge dimensions. An unknown extra billable dimension blocks the pilot.

## Verify spending controls and local readiness

The durable platform compute hard ceiling is USD 100 (`100000000` micro-USD), with ordinary admission at USD 90 and USD 10 retained inside that same ceiling. Campaign compute starts at USD 5 total. At most two setup, agent or verifier slots can be held or uncertain. Sandbox reservations cover the maximum admitted lifetime of 600 seconds. Uncertain creation, termination or inference keeps its reservation; a timeout never proves zero cost.

The explicit inference default is USD 0.20 per campaign, with an operator maximum of USD 0.50 and a USD 0.05 per-request cap. A user's planned USD 5 Nebius top-up is not a confirmed balance and is separate from these allowances and the platform compute limit. A model list proves authentication at a time, not positive balance or future inference access.

Bootstrap is limited to 100 new sessions per hour per deployment, with existing valid sessions reused. When `LOOPBENCH_TRUSTED_PROXY_HEADERS=1`, the supplied Caddy rule overwrites `X-Forwarded-For` and an additional 30-new-sessions-per-hour IP limit applies. Keep the application bound to loopback and do not trust forwarded headers when it is directly exposed. Only operator-keyed IP digests are persisted, with bounded retention. Key connection is limited to five per 15 minutes per session and credential fingerprint. Catalog requests are limited to ten per 15 minutes per session and credential fingerprint. These pilot limits are durable across application restarts.

Set the provider's E2B account/project control to USD 100 and inspect its actual scope, reset period and enforcement behavior. Save a fresh operator record using `deploy/e2b-limit-evidence.example.json` and set `LOOPBENCH_E2B_LIMIT_EVIDENCE` to its absolute path. Replace every placeholder, use a new audit UUID and the actual UTC verification time. The gate accepts records no older than seven days. This record documents the provider check; it cannot guarantee an invoice with no overshoot. The SQLite ledger is cumulative and never resets with the provider's billing cycle.

With the private service environment loaded, run:

```sh
node --import tsx scripts/hosted-preflight.ts
node --import tsx scripts/hosted-status.ts
```

Preflight performs local configuration, migrations, SQLite durability/integrity, account uncertainty, public HTTPS syntax, approved manifest, actual runtime-file hashes and six-task benchmark checks. It sends no network request and creates no sandbox. Its `remoteVerification: not_performed` field is deliberate. An empty or missing live configuration returns a failing report, without printing secret values.

## Bring up the application

1. Configure DNS and the real domain in `deploy/Caddyfile`; point both canonical public and gateway origins at the actual HTTPS origin. Install the three systemd units after adjusting paths. Keep `LOOPBENCH_HOSTED_ENABLED=false` while preparing secrets and manifests.
2. Set the enabled flag in the private service configuration when local preflight passes and the operator is ready to admit work. Start the web service and Caddy. Verify a trusted TLS certificate and that the gateway route is reachable from the external network. A request without a scoped token should be rejected without contacting Nebius. Confirm private responses use `Cache-Control: no-store` and that legacy global routes do not expose local data in hosted mode.
3. Start the reaper before the worker. Review existing provider resources and persisted uncertain obligations before new admission. The worker unit runs local preflight before starting; a failed gate stops worker startup. The reaper remains available for cleanup even when new admission is blocked.
4. Open the HTTPS setup page, connect the user's Nebius key, review live eligible Nemotron models, select the cheapest compatible model and approve the explicit inference allowance. Authentication or catalog presence is not a successful inference run.
5. Run the smallest explicitly bounded smoke through the actual worker and gateway. A one-task subset must carry its own task identity and denominator. Confirm Pi tool events, a fresh verifier result, provider call IDs and usage, durable accounting and confirmed cleanup. Then run a full six-task baseline and at least two actual competing siblings before claiming full paired evolution. Record failures and unknown costs honestly.

An environment check does not authorize a template build, purchase, deployment or paid smoke by itself. These steps describe the operator workflow for an approved environment. Browser refreshes and disconnects do not own the worker's lifetime.

## Pause, stop and change allowances

Pause denies new logical work and checkpoints admitted work. Resume performs readiness checks and does not grant money. Stop revokes gateway authority immediately, then remains `stopping` until owned environments are confirmed stopped or conservatively expired. Key revocation erases live ciphertext, revokes grants and requests cleanup. Keep the reaper running while draining.

The browser can explicitly approve inference allowance and price consent through the owned allowance API. It cannot increase platform-funded compute. An operator can grant a concrete campaign compute limit with a current campaign revision, exact micro-USD value, unique operation UUID and recorded reason:

```sh
node --import tsx scripts/hosted-grant-compute.ts \
  --campaign CAMPAIGN_UUID --revision CURRENT_REVISION \
  --limit-micros 6000000 --operation NEW_OPERATION_UUID \
  --reason "Reviewed remaining sibling-round compute obligations"
```

This grant does not resume the campaign, release the platform reserve or enlarge the USD 100 platform ceiling. Review settled plus held obligations in status before granting. Account estimates above their admitted bound are recorded in full and block further admission; they are never clamped to hide a discrepancy.

## Recover a host or interrupted worker

Keep database files, WAL and artifact bytes private. SQLite uses WAL, foreign keys, `synchronous=FULL` and a five-second busy timeout. Use SQLite's consistent online backup facility or a stopped-writer snapshot that includes the full durable state; copying only a live database file can lose WAL commits. Current artifacts are stored as bounded private database blobs, so a consistent database snapshot includes those bytes. Back up generated private curriculum files separately. Store encrypted backups in another failure domain and custody the keyring separately.

Before restore, close admission and stop worker claims. Restore to a separate data directory, run integrity checks and preserve the previous deployment's cumulative budget evidence. Disable restored credentials, apply newer revocation tombstones, revoke restored grants and invalidate leases. Reconcile all owned provider environments and later provider usage before admitting work. A rollback must never erase spending or make a deleted key usable. These restore actions require operator execution; this release does not claim an automated restore rehearsal.

On normal shutdown, send SIGTERM to the worker and leave the reaper active until cleanup is confirmed. Review `node --import tsx scripts/hosted-status.ts`, logs and provider resources. If a kill response is lost, retain the reservation and slot. Do not delete evidence or manually zero an account to force a restart. Disk-full, integrity failures, unresolved liveness and unknown usage keep admission closed.

## Export verified lessons locally

The lesson exporter produces a private, redacted JSONL dataset from complete paired evaluations with matching independent verifier artifacts. It checks owned campaign/version/attempt relationships, benchmark and runtime identity, actual grader evidence and complete task counts. Inference logs alone cannot label a pass. Rows include reusable diagnosis/change/prediction, measured counts and evidence IDs/digests. They omit raw logs, task inputs, expected answers and submissions.

```sh
node --import tsx scripts/hosted-export-lessons.ts \
  --campaign CAMPAIGN_UUID --consent \
  --output /var/lib/loopbench/private/lessons-EXPORT_UUID.jsonl
```

The path must be absolute and new; files use private permissions. A sidecar manifest records deterministic dataset SHA-256 and provenance. Empty or unverified histories do not become a synthetic dataset. The script performs no Data Lab upload, changes no Zero Data Retention setting and does not claim model-weight training. A later Data Lab import needs the account's documented capability and explicit export choice. Measure a controlled same-model lesson ablation before claiming improved outcomes.
