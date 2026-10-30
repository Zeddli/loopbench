# Filming and submission runbook

Use this guide after noon on 30 October 2026, Asia/Kuala_Lumpur. Read [current validation](LIVE-VALIDATION-2026-10-30.md) before recording. Deployment is set aside; the controller and web server still run on this laptop, which must remain awake and connected.

## Current evidence to film

Lead with sixteen-call quality campaign `876e9ddd-3458-45ed-a4f0-310f815c9525`. It completed two rounds and paused at the configured bound. Accepted child `e7ca9a1c-767f-49bf-afc8-884fde335e4b` passed **2/6 against a freshly rerun parent at 1/6**, a +16.7pp paired delta. Its original baseline passed 0/6 under the same sixteen-call condition. This is a real, modest measured gain, not mastery of the six-task benchmark or proof of general improvement.

Rejected siblings remain visible in the result card below. The same campaign is now running round three with explicitly approved generated-source review. Two valid round-three hypotheses are saved and the first fresh-parent evaluation is underway. No round-three candidate score is established yet.

Eight-call campaign `884365e7-7f19-4eff-baa3-3ed8e53c1e38` is paused after two rounds. Its best 1/6 candidate only ties its original baseline; its grandchild was rejected. Keep the eight-call and sixteen-call score curves separate.

The eight-call run also supplies actual quarantine/continuation evidence: a round-two parent heap exhaustion remained unscored, with no fabricated candidate. The controller moved to the next sibling, which completed its comparison. Keep that receipt and all failed/rejected attempts visible. Older E2B outcomes are historical and belong to their own campaign.

The eight-call public-tree pointer is `.loopbench/hosted/token-validation-published-live.json`; the active sixteen-call quality pointer is `.loopbench/hosted/token-quality-published-live.json`. Read its `url` and open that path on `http://127.0.0.1:3000`; the page follows newer explicitly published checkpoints of the same campaign. To print the current local URL without starting work:

```powershell
$published = Get-Content .loopbench/hosted/token-validation-published-live.json -Raw | ConvertFrom-Json
"http://127.0.0.1:3000$($published.url)"
```

For the primary quality tree, substitute `token-quality-published-live.json` in the read-only command above. Keep two browser tabs ready: the quality tree for the completed 2/6 gain and current progress, and the eight-call tree for resource-quarantine evidence. Select nodes, switch Tree/Stats and use Full record to show task results, measured comparisons and provenance. Published snapshots contain reviewed evidence; pending hypotheses are not measured graph nodes.

## Keep the existing run working

If the local web server is absent, set the local origins explicitly before starting it. The private environment file still contains an expired tunnel origin, so bare `npm run dev` would give local mutations the wrong origin.

```powershell
$env:LOOPBENCH_PUBLIC_ORIGIN = "http://127.0.0.1:3000"
$env:LOOPBENCH_GATEWAY_ORIGIN = "http://127.0.0.1:3000"
npm run dev
```

Keep local use in development mode. Production intentionally requires HTTPS; do not weaken that policy. Existing private configuration supplies the credentials. Do not print `.env.local`, session files, keys or raw private logs on camera.

| Process | Purpose |
| --- | --- |
| Existing Token Factory pilot | Drives the selected operator campaign and publishes its checkpoints. Leave its current process running. |
| `npm run hosted:worker` | Generic worker for browser-created private BYOK campaigns. Keep the configured worker running; do not start duplicate workers for the recording. |
| `npm run hosted:reaper` | Reconciles owned operations and cleanup. Keep it running while work settles. |

The quality campaign allowance was explicitly increased from USD 0.40 to USD 0.50; the eight-call validation campaign remains at USD 0.40. These are campaign allowances, not known account balances or guaranteed final invoices. An optimizer request with an unknown timeout outcome retains its reservation. Compute and inference accounting remain separate; unknown usage is not zero cost.

To show Pi starting in the film, use the actual saved `token.pilot.started` event and the running terminal's progress. Do not replay the start command merely to recreate that scene.

For later reproduction, the actual bounded start command is:

```powershell
npm run hosted:token-pilot -- --validation --max-siblings 2 --rounds 2
```

**Do not run that start command while its owner already has an active campaign.** Both current profiles already have saved work; do not launch another paid experiment for filming. If the saved eight-call campaign is waiting or paused, inspect its reason and remaining allowance before `npm run hosted:token-pilot -- --validation --resume --rounds 2`. The quality profile is already resumed with `--quality --resume --rounds 3`; leave that process running. For later continuation, use the same saved owner only after it becomes waiting or paused and deliberately choose the new round bound. Resume keeps the saved model and call bound, adds no money and erases no failures. Stopped campaigns cannot resume.

For the product setup scene, open `/setup` and show the masked existing connection. Open `/experiments/new` to show the actual eligible model catalog and its cheapest-compatible selection, currently Nemotron Lightning. Stop before Start experiment during this recording unless the current run has settled and another paid experiment is deliberately intended.

## Two-to-three-minute storyboard

| Time | Screen and narration |
| --- | --- |
| 0:00-0:20 | Public archive and an actual measured tree. "LoopBench tests competing harness changes and keeps the evidence, including failures." Identify this older tree as historical. |
| 0:20-0:45 | Select a node, show Stats, then Full record and task results. Explain that acceptance uses a fresh parent/candidate comparison on identical tests. A historical score is not substituted for the fresh parent. |
| 0:45-1:05 | Masked key connection and real eligible model catalog. Explain that NVIDIA Nemotron inference comes from Nebius Token Factory. Do not reveal a key or invent prices. |
| 1:05-1:30 | Quality baseline 0/6, genuine sibling hypotheses and completed round-two measurements, followed by separately labelled round-three progress. Explain the separate Token Factory Sandboxes runtime: Pi 1.4.0 on Node v24.15.0, offline guest operations, a metered inference relay and an independent verifier. |
| 1:30-2:10 | Select accepted `e7ca9a1c…`: candidate 2/6 versus fresh parent 1/6, above the quality baseline 0/6. Show its lesson and task evidence. Then select rejected sibling `3455a857…` at 0/6 versus 2/6. Describe the gain as one local paired result, with four tasks still failing. |
| 2:10-2:40 | Show the actual result and learning record. Fill the result card below only after verification. Switch to the separately labelled eight-call tree: show its actual parent quarantine and following completed sibling. Its unscored receipt is retained; no fake candidate or low parent score manufactures a gain. |
| 2:40-2:55 | State the remaining limits: function-level tasks, one paired sample, local controller and no guaranteed monotonic improvement. End on the working evidence page. |

The trusted request-identity extension now caps Pi bash tools at 15 seconds so a hanging public check returns control to the agent. Its SHA-256 is `44b9be684c22b1734ceef218a5cae0da0744afb78e577698374fdf078935d601`. The runtime image remains `91a517fc-84ca-4fa3-84ec-a8329786194c`. The current campaign began under this new policy boundary; older runtime evidence is archived in `.loopbench/hosted/runtime-archives/2026-10-30-before-bash-timeout`.

Approved optimizer review uses owned, hash-checked submission excerpts of at most 8,000 characters and public behavioral contracts, without hidden cases or expected answers. The optimizer view strips only the known agent-facing JavaScript-output boilerplate suffix; benchmark definitions and agent README contracts remain unchanged. This guides reusable procedures, not task solutions pasted into the harness. Failures remain retained; whitespace-only duplicates are rejected and reference IDs stay bounded.

Only the optimizer enables reasoning, with up to 16,384 output tokens. Its upstream timeout is now 180 seconds and grant lifetime 210 seconds. Pi/probe upstream timeouts remain 110 seconds; parent/candidate settings are unchanged. Other roles retain the 8,192 cap and reasoning stays disabled. One real 4,053-token answer was invalid solution-like harness content, and a later body read timed out with its unknown reservation retained. The following two valid round-three proposals are not benchmark scores; the 2/6 gain comes from completed verification.

## Verified results and fields still to fill

| Recording/submission field | Value to verify |
| --- | --- |
| Current public tree URL and observed time | Fill from the latest published pointer. |
| Baselines | Eight-call campaign 1/6; separate sixteen-call quality campaign 0/6. |
| Eight-call measured pair | `708a76b8…`: 0/6 parent, 1/6 candidate, +16.7pp. `a132cb47…`: 0/6 parent, 0/6 candidate, rejected tie. |
| Primary quality gain | `e7ca9a1c…`: 2/6 candidate versus 1/6 fresh parent, +16.7pp, accepted; original same-condition baseline 0/6. |
| Retained quality regression | `3455a857…`: 0/6 candidate versus 2/6 fresh parent, -33.3pp, rejected. Earlier `f6b44bec…` lost 1/6 versus 2/6. |
| Live quarantine and continuation | Eight-call round two: ordinal-zero parent quarantined, unscored; ordinal-one child `ee4219b7…` completed 1/6 versus 2/6 and was rejected. |
| Best completed candidate scores | Quality sixteen-call campaign 2/6; eight-call campaign 1/6. These are separate conditions. |
| Improvement claim | Modest same-sixteen-call gain from baseline 0/6 to an accepted 2/6 candidate, with fresh paired parent 1/6. No benchmark mastery or statistical confidence claim. |
| Round-three outcome | Two valid proposals saved; first fresh-parent evaluation underway. Candidate outcomes pending. |
| Public video, repository and submission URLs | Fill after publishing and checking access while signed out. |

Keep the video under three minutes. Include setup instructions, MIT license and a clear account of what LoopBench adds to its Petri reference. Link the current validation report and distinguish actual inference from the completed v11 suite: 218 tests passed with zero failures, cancellations or skips. Current focused optimizer/evidence/gateway checks passed 17 tests and typecheck passed. V9 was stopped after a Windows test cleanup hang. Build v6 passed, with all 27 output traces free of private environment/state and runner-manifest references. Verify every submitted URL. No fake branches, scores, usage or cost estimates belong in the recording. See [HACKATHON.md](HACKATHON.md) for event references and [HOSTED-RUNBOOK.md](HOSTED-RUNBOOK.md) for operations beyond this filming session.
