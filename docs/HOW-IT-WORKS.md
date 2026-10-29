# How it works

LoopBench evolves agent configurations using real evaluations. An autonomous campaign diagnoses prior mistakes, proposes competing harness changes and evaluates their branches over multiple rounds. A single run asks an adapter to solve every task, executes the returned code and persists the results. A child compares a new configuration against a fresh rerun of its parent. The browser draws the resulting lineage and learning evidence. See [EVOLUTION.md](EVOLUTION.md) for the full search loop.

The hosted workflow starts at `/setup`: connect a Nebius key, review the live compatible Nemotron catalog, then create a Pi experiment with explicit inference consent. A durable backend worker runs clean E2B task environments through the metered Token Factory gateway. Separate trusted verification measures actual submissions. The private experiment page polls saved progress and displays the horizontal lineage; only explicitly published snapshots enter the public catalog. See the [hosted architecture](ARCHITECTURE-HOSTED.md), [browser workflow](HOSTED-UX.md), [runbook](HOSTED-RUNBOOK.md) and [actual results](VALIDATION.md). The commands below describe the separate local CLI.

## First run

Install dependencies and start the viewer in one terminal:

```powershell
npm ci
npm run dev
```

Open `http://127.0.0.1:3000`. A new installation has no experiments. The viewer should explain how to make the first run rather than show a prepared history.

In another terminal, inspect available adapters and benchmarks:

```powershell
npm run cli -- adapters
npm run cli -- benchmark list
```

The built-in adapter needs an installed and configured Codex CLI. Choose a model that this installation can actually use. `MODEL` below is a placeholder, not a recommended or prevalidated model ID.

```powershell
npm run cli -- run --adapter codex-cli --domain coding --model MODEL --harness codex-cli --benchmark coding-adversarial-v1 --hypothesis "Measure the current adversarial coding baseline"
```

The command prints progress events to stderr and the final node as JSON to stdout. Copy the returned node `id`. The web server sees the same run directory and its next poll shows the new tree.

Start an autonomous campaign from that baseline. The CLI defaults to continuous mode; this command states it explicitly and leaves sibling width adaptive:

```powershell
npm run cli -- evolve --continuous --adapter codex-cli --domain coding --model MODEL --harness codex-cli --benchmark coding-adversarial-v1 --parent BASELINE_UUID --beam-width 2 --max-calls 80
npm run cli -- campaigns
npm run cli -- campaign CAMPAIGN_ID
```

For a manual experiment instead, keep the same configuration flags and use `run --parent BASELINE_UUID --hypothesis "A testable claim" --instructions "Complete replacement harness instructions"`. Neither mode guarantees improvement. Continuous mode completes a 2-6-sibling round even on a perfect baseline, then advances to a verified new challenge and measures the unchanged harness there. Finite mode retains its saturation stop. Never damage a baseline or invent failures to make the tree look better.

## What happens inside a campaign

1. Persist the campaign options, invocation allowance, benchmark revision and existing parent ID. Continuous mode adopts the existing tree identity or creates a new lineage. Existing nodes remain unchanged. If no parent was supplied, measure and record a new baseline first.
2. Read the matching tree. Consider only valid completed nodes on the current benchmark hash. Rank them by measured score, then recency; the first `beamWidth` nodes are the eligible parent set. Scores from other challenge levels do not enter this ranking.
3. Build an evidence digest containing public task specifications, prior instructions, model outputs, named failure diagnostics, comparisons and lessons. In continuous mode, the request contains a bounded window of relevant parents, nearby ancestry and recent experiments plus compact summaries of archived failures and strategies. Its JSON is limited to 120,000 characters. Complete records remain on disk. Test inputs and expected answers are excluded from the request.
4. Choose a sibling count from 2 through 6. New continuous campaigns adapt it using measured failure evidence; finite campaigns default to two. An explicit `--branches N` fixes that count in either mode. Reserve and save one proposer invocation before calling the dedicated proposer adapter. The default is `codex-proposer` with the configured model. `--proposer-adapter` and `--proposer-model` can select another registered implementation.
5. Validate exactly the selected number of proposals, always 2-6. All siblings must select the same eligible parent and have distinct complete instruction replacements. `learnedFrom` must contain known node IDs and the parent. If visible measured mistakes exist, every proposal must reference at least one relevant mistake node. It does not need to list every historical node. Repeating a prior instruction change from that parent is refused.
6. Persist the proposals, then execute siblings sequentially through the ordinary paired runner. Each generated node carries diagnosis, change, prediction, learning references, proposer identity and round.
7. Build the next round's digest from the updated tree, including unsuccessful siblings. Select another beam and repeat. Continuous mode has no round or total-candidate ceiling; the adaptive or explicitly fixed sibling count and `beam-width` control each proposal batch and parent frontier, not lifetime graph depth or node count.
8. When a current-benchmark node scores one and a complete sibling round has run on that suite, generate and verify the next curriculum suite. A perfect root or challenge checkpoint cannot skip the 2-6 competing experiments. First evaluate the unchanged champion as an explicit challenge baseline with its original node as parent. Only subsequent fresh paired comparisons on that new suite can establish improvement.

The adaptive rule starts at two siblings and adds one for each distinct failed task ID found in the current beam frontier or latest completed round on the current benchmark, capped at six. It includes failed tasks from fresh paired-parent evidence. Scores and failures from other benchmark hashes do not set the width. An explicit `--branches N` disables adaptation and fixes N within 2-6.

The durable campaign stores its exact proposer digest and digest hash, raw response or error, validated proposals, candidate IDs, selection reason and call ledger. A model diagnosis remains a hypothesis until the functional evaluation contradicts or supports it. An accepted instruction change does not modify model weights.

Each six-task child needs twelve adapter invocations because the original parent configuration reruns before the candidate on every task. A round with B siblings needs `1 proposer + B × 12 evaluations`, from 25 calls for two siblings to 73 for six. Fixing `--branches 3` uses 37 calls per round. A new baseline or unchanged-champion challenge checkpoint needs six more. New curriculum cases increase functional checks inside those six tasks, not adapter-call counts.

The engine reserves each invocation before it starts, including failed attempts. Codex or another executable can perform internal requests or tool use; `max-calls` is not a provider-request or dollar cap. There are no implicit retries. A next sibling round that cannot fit the remaining invocation allowance does not start partially. Continuous mode saves `waiting_budget`, with its campaign and lineage intact. Grant another allowance explicitly:

```powershell
npm run cli -- evolve --resume CAMPAIGN_ID --grant-calls 80
npm run cli -- pause CAMPAIGN_ID
npm run cli -- resume CAMPAIGN_ID
npm run cli -- stop CAMPAIGN_ID
```

`evolve --pause CAMPAIGN_ID` and `evolve --stop CAMPAIGN_ID` are equivalent control forms. Pause and stop requests take effect after the current node finishes. Unstarted sibling proposals remain saved so resume can finish that admitted round. They preserve history and unused allowance; explicit resume continues a continuous campaign. If no independently checked next suite is available, the campaign saves `waiting_challenge`, not completed evolution.

After a worker crash, every existing lock is refused. Confirm that the worker stopped, then explicitly remove only its stale `.loopbench/campaigns/CAMPAIGN_ID.json.lock` file before resuming. The engine never replaces a lock automatically. Interrupted reserved attempts stay spent and are marked failed; an incomplete active node stays failed. Resume continues unattempted work. An interrupted or invalid proposer is retained without automatic retry, and can require a new campaign from a completed node.

For an explicitly finite software check, use `--finite --rounds 2 --branches 2 --beam-width 2 --max-candidates 4 --max-calls 50` from an existing six-task baseline. This finite mode can finish as `completed`, `budget_exhausted` or `saturated`. Those ceilings are ignored by continuous execution.

## What happens inside a run

1. Parse CLI arguments and reject missing fields. Settings are string values supplied with repeated `--setting KEY=VALUE` options; `--instructions` becomes `settings.instructions`.
2. Parse the benchmark, check unique task IDs and hash its definition together with evaluator and benchmark-controller source digests. Reject a domain that differs from the benchmark's domain. Record the resolved source path for later continuation commands.
3. Resolve the adapter manifest and, for a child, load the requested parent. The parent must be a completed scored run in the same lineage and benchmark revision. The engine alone can create an explicit cross-revision challenge checkpoint.
4. Write a new `running` node before task execution. This gives the viewer an honest record of an in-progress attempt.
5. For each benchmark task, create a temporary working directory. For a child, run the parent configuration first, then the candidate configuration on that task. The parent's manifest, hashed entrypoint files and recorded runtime information must match its stored fingerprint.
6. Send a protocol request to the adapter. Parse its response; never accept a score supplied by the adapter.
7. Pass the returned JavaScript to the evaluator. Each task passes only when all its cases match expected JSON values. Persist candidate task progress after each task.
8. Compute `score = passed task count / total task count`. A root becomes `baseline`. An ordinary child becomes `accepted` only for a positive difference from the newly measured parent score; otherwise it becomes `rejected`. A challenge checkpoint uses `event="challenge"`, status `baseline` and no paired delta, because it measures a changed suite with unchanged instructions.
9. Store completion time, comparison and any failure. Subsequent attempts create new nodes; completed evidence cannot be edited through the runner.

Adapter/process errors after initial persistence fail the run. Preflight failures, including a missing Codex executable during version fingerprinting, can refuse the request before a node exists. Invalid code, incorrect output, input mutation on protected tasks and one-second VM timeouts are task failures when the evaluator returns a valid result. Evaluator startup failures, nonzero exits, invalid result protocols and the fifteen-second outer process timeout fail the evaluation instead of counting as incorrect algorithm answers. A failed run can contain completed tasks from before the error. It remains visible, with no invented final score.

## Benchmark contract

Two built-in suites are available:

| Benchmark | Purpose | Coverage |
| --- | --- | --- |
| `coding-functions-v1` | Three-task smoke check | Stable deduplication, chunking and balanced brackets |
| `coding-adversarial-v1` | Six-task mistake-learning evaluation with 64 named cases | Strict CSV, atomic JSON Pointer patches, exact decimal sums, weighted LRU, time-zone interval unions and dependency layers |

The adversarial suite's task IDs are `strict-csv`, `json-pointer-patch`, `exact-money-sum`, `weighted-lru`, `timezone-interval-union` and `dependency-layers`. Named cases make a violated contract actionable to the next proposer. Reference implementations in the tests verify that the defined contracts are solvable; they are test evidence, not model-generated improvements.

| Task | Named cases | Contract exercised |
| --- | --- | --- |
| `strict-csv` | 12 | Quoting, delimiters, records and strict parsing behavior |
| `json-pointer-patch` | 12 | Escaped pointers and atomic patch semantics |
| `exact-money-sum` | 14 | Exact decimal arithmetic and normalized output |
| `weighted-lru` | 8 | Weighted capacity, recency and eviction |
| `timezone-interval-union` | 10 | Offset-aware intervals and merging |
| `dependency-layers` | 8 | Dependency ordering and graph edge cases |

All six adversarial tasks declare `nonMutating`. Read their full prompts and cases in `benchmarks/coding-adversarial-v1.json` for the exact contracts rather than inferring them from this summary.

The adapter receives prompts; cases are not in its request. Cases are public in the repository, so these are held back from the task request, not secret from a determined local process. A task passes only when every case passes. Scores remain fractions of tasks, not fractions of the 64 cases.

The requested output is a CommonJS function such as `module.exports = function(values) { ... }`. The evaluator accepts a surrounding JavaScript code fence, creates a fresh VM context, loads the function, invokes it on copied arguments, and compares JSON values. Tasks declaring `nonMutating` also check that inputs remain unchanged. Named cases identify failed contract categories. Test quality bounds what a pass means.

Continuous mode extends the adversarial suite through `core/curriculum.ts` and independent trusted algorithms in `core/curriculum-oracles.ts`. Each level introduces 48 fresh cases across the six contracts. It always retains the 64 base cases, level-one anchors, the latest eight complete levels and every identified historical failing check. Inputs gain complexity up to per-case safety bounds; deterministic fresh seeds continue beyond those bounds. The generator validates base and pinned expected values against its oracles and writes immutable, content-identified JSON. It never asks a model to generate expected answers. Unsupported task contracts enter `waiting_challenge` until a trusted extension exists.

These suites measure specific function contracts. They are not SWE-bench, a broad coding leaderboard, a repository engineering evaluation, or a measure of general agent intelligence. Add larger, versioned tasks and independent holdouts before making those claims.

## Read the comparison correctly

Suppose the stored parent originally passed 2/3 tasks. In a child comparison, its fresh rerun passes 1/3 and the candidate passes 2/3. The comparison is `+33.3pp` against the fresh 1/3 result. The stored parent's original 2/3 remains unchanged. Both values are useful; substituting the historical score would misstate what the paired run measured.

One paired sample does not estimate variance or prove general improvement. It does not establish independent verification, causal certainty, statistical significance, or a production-ready release. The current acceptance label means only that this candidate passed more tasks in this local paired batch.

## Register another harness

Create a manifest for a program you control:

```json
{
  "id": "my-agent",
  "name": "My agent",
  "description": "Local task protocol adapter",
  "protocol": "loopbench.task.v1",
  "command": "node",
  "args": ["./my-agent.mjs"],
  "timeoutMs": 120000
}
```

Register it with `npm run cli -- adapter add ./adapter.json`. Relative program arguments resolve against the manifest's directory. The registered program is trusted local executable code. It must read one JSON object from stdin and write one JSON object to stdout:

```json
{
  "protocol": "loopbench.task.v1",
  "task": { "id": "task-id", "prompt": "Solve the task" },
  "config": { "model": "chosen-model", "harness": "my-agent", "settings": {} },
  "instructions": ""
}
```

```json
{
  "output": "module.exports = function(values) { return [...new Set(values)]; };",
  "inputTokens": 120,
  "outputTokens": 32
}
```

The numbers above illustrate the protocol only; they are not measured usage. Token fields and `costUsd` are optional. Omitted values become `null` in records. Emit diagnostics on stderr, keep credentials in environment variables, and do not print keys. Run `adapters` again to confirm registration. Select the new adapter explicitly in the next `run` command.

## Inspect and continue

`npm run cli -- inspect NODE_ID` returns the full record. `list` and `digest` return the compact catalog. The `evolve` command builds a richer campaign-specific digest, invokes the proposer and evaluates competing branches; simply opening the viewer or reading `digest` does not start inference.

To continue a line, choose a completed scored node and use `evolve --parent` or a manual `run --parent`. Rejected nodes remain available as evidence and can be parents if they are otherwise valid evaluations. Running and failed nodes cannot be parents. Ordinary finite tree identity changes with benchmark content or evaluator/controller bytes. Continuous campaigns retain one lineage across verified curriculum revisions, while prohibiting ordinary paired comparisons across benchmark hashes. Challenge nodes explicitly connect those revisions without claiming improvement. Historical records remain readable; the UI suppresses continuation when their benchmark revision is unavailable. New configurations retain `benchmarkPath` so a custom benchmark can be found again.

Set `$env:LOOPBENCH_HOME = 'D:\my-experiments'` in both terminals to use another store. A missing directory is created on the first write. Back up completed run files if you need durable evidence across machines.
