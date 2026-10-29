# Pi and Token Factory research

Research date: 27 October 2026. This is a proposal for discussion, not an approved implementation plan. No application code, Pi installation or provider configuration was changed, and no inference or sandbox operations were requested during this research.

## Direction selected by the user

Use the already installed Pi coding-agent harness. Nemotron should improve a harness that itself uses Nemotron. Token Factory should contribute to the actual experimentation and learning workflow.

Decision update: the user selected E2B because Nebius Sandboxes beta access is unavailable. LoopBench supplies the E2B compute, capped at USD 100 total for the demo; users supply their Nebius inference credentials. The current proposed architecture and budget policy are in [the E2B/Pi design](../superpowers/specs/2026-10-27-e2b-pi-design.md). The earlier Nebius Sandboxes recommendation below is retained as research history and is superseded by this decision.

## Verified Pi findings

The installed package is `@earendil-works/pi-coding-agent` version 1.4.0. Its shipped documentation describes interactive, print, JSON and RPC modes using the same underlying agent and tools. RPC provides bidirectional control and streamed events; `agent_settled`, rather than prompt acceptance or an intermediate `agent_end`, identifies completion of automatic work. JSON-mode process exit alone does not establish task success. See [versioned CLI integration documentation](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/cli-integration.md).

Pi extensions can observe and modify context, tool calls and provider requests. The installed documentation exposes `before_provider_request`, `after_provider_response`, `tool_call`, `tool_result` and compaction/session events. This supports measured evolution of prompts, skill bundles, tool policies, context handling and verification behavior. Extensions execute with Pi's process permissions, so unrestricted self-modification would also change the experiment's trust boundary. See [versioned extension documentation](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/extensions.md).

Configuration observation: the inspected user settings default to OpenAI, while the cached NVIDIA Nemotron entries point to `https://integrate.api.nvidia.com/v1`. This does not establish the model selected in an existing interactive session, or whether another environment overrides these files. It does mean the inspected configuration does not demonstrate Nebius-hosted inference. Experiment launches must explicitly pin the model and Token Factory endpoint. No authentication values were printed or copied.

## Proposed system

### 1. A versioned Pi harness artifact

Each evolution node would identify an immutable package containing its prompt additions, skills, approved extension/configuration changes, active tools, compaction policy and verification policy. Record Pi version, model ID, benchmark revision and artifact digest. Keep the base Nemotron model fixed within an experiment so a model swap cannot be counted as harness improvement. Do not modify the user's global Pi installation or session.

The optimizer would propose 2-6 distinct sibling artifacts from actual observed failures. An artifact can change how Pi reads errors, selects tools, preserves relevant context or verifies its work. The experiment must test general behavior on multiple tasks, including held-out tasks, rather than rewarding a patch memorized for one benchmark case.

### 2. A controlled inference path through Token Factory

Proposed inference flow: Pi executor and Nemotron optimizer -> LoopBench-controlled request accounting -> Token Factory -> selected NVIDIA Nemotron model.

A gateway or version-matched Pi extension would attribute every provider request to campaign, harness version, task and role. It must count tool-loop calls, compaction and retries, rather than treating one Pi process as one model request. Retain streaming behavior and record returned usage, response identifiers, request latency and cache usage when available. Do not assume a Pi cost estimate is the provider invoice.

Token Factory exposes response rate-limit headers. Use those for bounded admission and scheduling. Quota or infrastructure errors are separate from benchmark failures. Source: [rate limits](https://docs.tokenfactory.nebius.com/ai-models-inference/rate-limits).

### 3. Sandboxes as the experiment execution layer

Prepare a repository and its dependencies once, then record an immutable baseline image UUID. Start each task attempt from that task's same prepared image, inject the selected Pi harness artifact, run Pi and independently evaluate its resulting patch. Keep outputs, diffs, test results, operation IDs and usable result-image UUIDs.

Sandbox filesystem branches are execution artifacts. LoopBench's harness evolution graph is the relationship between harness versions. These are related but distinct: one harness node normally has multiple task attempts, each with its own sandbox operation and possibly a result image. An arbitrary solved-task filesystem is not the starting repository for the next benchmark task.

Sandboxes preserve filesystem state, not live Pi process memory. Resume or fork of Pi conversation state requires separately retained session files and an explicit policy. Agent-visible tasks must not contain the hidden acceptance tests or answer material.

Sources: [checkpoint semantics](https://docs.tokenfactory.nebius.com/sandboxes/concepts/images-checkpoints-and-branches), [SWE-agent workloads](https://docs.tokenfactory.nebius.com/sandboxes/swe-agents).

Sandboxes is currently in beta and requires access. The docs describe account-effective concurrency and resource limits, but do not establish the price or trial-credit coverage for this account. Start with a small sample and low concurrency only after those are confirmed. Raw operation resource `cost` is not invoice evidence unless its units and aggregation have been confirmed. Sources: [overview](https://docs.tokenfactory.nebius.com/sandboxes/overview), [limits and usage](https://docs.tokenfactory.nebius.com/sandboxes/operate/limits-retention-and-usage).

### 4. Data Lab as a reusable experiment dataset

Token Factory Data Lab can import inference logs when Zero Data Retention was not enabled, filter/transform datasets and accept uploaded JSONL. LoopBench would associate provider completions with its own verified task outcomes, then upload or derive datasets containing failure categories, harness digests, task revisions and outcomes. Provider logs alone do not include the external benchmark verdict.

Nemotron would retrieve relevant failure examples and propose a reusable lesson or skill. A controlled ablation would compare the harness with and without that lesson, followed by a held-out evaluation. Only measured transferable improvements become promoted harness artifacts. Preserve rejected lessons as evidence.

This is harness and skill learning, not a claim that Nemotron's weights have been trained. The documented fine-tuning model catalog currently does not list Nemotron; do not promise self-service Nemotron fine-tuning or speculate about its price.

Sources: [Data Lab overview](https://docs.tokenfactory.nebius.com/data-lab/overview), [inference-log imports and ZDR](https://docs.tokenfactory.nebius.com/data-lab/chat-completions), [dataset inputs](https://docs.tokenfactory.nebius.com/data-lab/datasets), [fine-tuning model catalog](https://docs.tokenfactory.nebius.com/post-training/models).

### 5. Measured inference efficiency

Token Factory automatically reuses matching prompt prefixes on a best-effort basis. Keep stable tool definitions and instructions before dynamic task/context material. Record actual cached tokens; do not promise cache savings. Evolving early prompt text can invalidate a prefix and is an experimental tradeoff. Cache locality and cold/warm state must not be confused with a better harness.

Compare verified task success, regressions, tokens, provider calls, estimated spend and elapsed time. Efficiency claims require equivalent task/model conditions and repeated checks where randomness matters. Native Token Factory observability metrics are documented as dedicated-endpoint-only, so serverless trials need LoopBench's own request telemetry.

Sources: [cached tokens](https://docs.tokenfactory.nebius.com/cached-tokens), [observability availability](https://docs.tokenfactory.nebius.com/ai-models-inference/observability).

## Approaches considered

| Approach | Benefit | Constraint |
| --- | --- | --- |
| Pi + Token Factory inference + local isolated evaluation | Smallest initial integration; supports full agent tool loops | Environment provisioning and isolation remain local |
| Pi + Token Factory inference + Nebius Sandboxes | Strongest fit for reproducible branching execution | Beta access, actual workload limits and pricing must be confirmed |
| The above plus Data Lab failure datasets | Adds a reusable evidence-to-skill learning cycle | Requires deliberate data handling and external verdict association |

Recommendation: design for the second approach, then add Data Lab for reusable lessons. Keep a local execution backend available if beta access is unavailable. With $1 of inference trial credit, perform a deliberately small pilot rather than promising an unbounded live run. Confirm sandbox billing independently.

## Paste-ready Sandboxes access request

I am building LoopBench for the Nebius x NVIDIA Global AI Hackathon. It is an evaluation and self-improvement platform for the Pi coding-agent harness, powered by NVIDIA Nemotron through Nebius Token Factory.

I would like Sandboxes beta access to run reproducible, isolated coding-agent experiments. LoopBench will prepare a task repository and dependencies once, record an immutable starting image, and evaluate 2-6 competing Pi harness versions from that same task environment. Candidate versions change reusable skills, tool-use policies, context management and verification behavior in response to measured failures.

For each attempt, I plan to retain the Pi execution trace, code diff, independent test results, inference usage and sandbox operation/image identifiers. LoopBench will compare results, preserve failed experiments, and use the evidence to propose the next harness generation. Held-out checks will distinguish transferable improvements from task-specific fixes.

The initial workload will be a small set of JavaScript/TypeScript repository-repair tasks with low concurrency and bounded execution time. I am also interested in the documented SWE-agent environment catalog for later evaluations.

Could you enable beta access and confirm account limits, sandbox pricing or available trial/hackathon credits, and the recommended way to run Pi against Token Factory while retaining artifacts and controlling network access? I currently have $1 of Token Factory inference trial credit and want to plan the execution budget separately and conservatively.
