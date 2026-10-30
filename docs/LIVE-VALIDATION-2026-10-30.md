# Live validation, 30 October 2026

Read-only database/log snapshot, Asia/Kuala_Lumpur. **The sixteen-call campaign has a real, modest gain: accepted candidate 2/6 versus fresh parent 1/6, above its original same-condition baseline 0/6.** This is one local paired batch, not benchmark mastery or statistical confidence.

## Actual model and verifier results

| Evidence | Observed result |
| --- | --- |
| Quality campaign `876e9ddd-3458-45ed-a4f0-310f815c9525` | Completed two rounds, then resumed toward round three. Two round-three proposals are validated and saved; the first fresh-parent evaluation is running. Model is `nvidia/Nemotron-3_5-Lightning`, with sixteen calls per task. |
| Accepted child `e7ca9a1c-767f-49bf-afc8-884fde335e4b` | Candidate 2/6 versus fresh parent 1/6, +16.7 percentage points; original baseline `7049f75d…` was 0/6. No final round-three result is claimed. |
| Retained quality regressions | `f6b44bec…`: rejected 1/6 versus 2/6. `3455a857…`: rejected 0/6 versus 2/6. The first child tied 0/6 versus 0/6. |
| Eight-call campaign `884365e7…` | Paused after two rounds. Baseline 1/6; accepted `708a76b8…` scored 1/6 versus 0/6, only tying that baseline. Grandchild `ee4219b7…` lost 1/6 versus 2/6. Keep the conditions separate. |
| Live quarantine and continuation | Eight-call round-two ordinal-zero parent heap exhaustion stayed quarantined and unscored, without a fabricated candidate. The next sibling continued and completed. |

Older campaigns `73ef63e0…` and `ccf6df0a…`, including unscored candidate `2064c14a…`, remain stopped and preserved.

The V2 probe reused submission hash `6b0c185b8a6740dee6e4bc3273f53a33b33c888ff09f22e0761c5224fc3fc929` in operation `01a18acd-43b4-737c-b26f-662fc180a5a4`. It reproduced 64 MB heap exhaustion, exit 134, with healthy controls before/after, zero inference and confirmed cleanup. Pinned image `91a517fc-84ca-4fa3-84ec-a8329786194c` runs Pi 1.4.0 / Node v24.15.0.

Grader hash remains `75a898450c0751c122d44a7133b73b993a0d4d0a579677d49970940c4b53be4f`; benchmark hash is `5346182318cc8cfcb60355b3d6129bfb2f201ab828ba321d46497ae46faad8b0`. No private test values or submission code appear here.

## Current policy and preserved failures

Commit `1fe9e56` handles HTTP 200 subprocess snapshots that are still running, with `exit_code` and `signal` both -1. Bounded GET polling waits for terminal results without replaying execution POSTs, matching the [official contract](https://docs.tokenfactory.nebius.com/api-reference/sandboxes/operation/result-of-one-subprocess-reconstructed-from-its-events). Resource quarantine retains unscored failures and advances pending hypotheses without manufacturing low parent scores.

Pi bash tools have a trusted 15-second cap. Extension SHA-256 is `44b9be684c22b1734ceef218a5cae0da0744afb78e577698374fdf078935d601`; older runtime evidence remains archived under `.loopbench/hosted/runtime-archives/2026-10-30-before-bash-timeout`.

Approved optimizer review uses owned, hash-matched model submissions of at most 8,000 characters. Truncation is marked and credential-like contents excluded. Public behavioral contracts exclude hidden cases/answers. Only the known agent-facing JavaScript-output boilerplate suffix is removed from the optimizer's view; benchmark definitions and agent README contracts remain unchanged. Parent binding, bounded reference IDs and distinct procedures are checked.

Optimizer reasoning allows 16,384 output tokens. Its upstream timeout is now 180 seconds and grant lifetime 210 seconds; Pi/probe upstream timeouts remain 110 seconds and comparison settings are unchanged. One real 4,053-token answer was invalid solution-like harness content; another call timed out while reading its body. That uncertain reservation remains retained. Later valid proposals establish generation, not a new measured gain.

Quality inference allowance was explicitly raised from 400,000 to 500,000 micro-USD. The eight-call campaign remains at 400,000. These are campaign allowances, not known account balances; unresolved usage is not zero cost.

## Completed checks and limits

| Check | Evidence |
| --- | --- |
| Completed full suite | V11: 218 passed, zero failures, cancellations or skips, 171,406 ms. V9 was stopped after a Windows Pi test-cleanup hang and remains unclaimed. |
| Current focused checks | 17 optimizer/evidence/gateway tests passed; typecheck passed. Two bounded cleanup-fixture tests also passed. |
| Build and tracing | Build v6 passed. All 27 production traces contain zero private environment, `.loopbench` or runner-manifest references. |
| Local artifact access | Owner 200 with verified hash; foreign/internal/unauthenticated 404. Zero paid calls for those checks. |

Local development is at `http://127.0.0.1:3000`. Separate publication pointers are `token-quality-published-live.json` and `token-validation-published-live.json` under `.loopbench/hosted`. The old tunnel expired; public hosting remains unverified. See [DEMO-RUNBOOK.md](DEMO-RUNBOOK.md) for local-origin overrides and filming.
