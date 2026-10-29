# UML and execution models

Proposed hosted domain, lifecycle and deployment diagrams are in [HOSTED-UML.md](HOSTED-UML.md). The diagrams below describe the current local implementation.

These diagrams describe the local implementation. The records are TypeScript data structures; the module boxes name functions rather than classes that the code does not contain.

## Data relationships

```mermaid
classDiagram
    class RunConfig {
        +string adapterId
        +string domain
        +string model
        +string harness
        +string benchmarkId
        +string benchmarkHash
        +string benchmarkPath
        +string lineageId
        +Map settings
    }
    class NodeRecord {
        +string id
        +string treeId
        +string parentId
        +string hypothesis
        +string harnessHash
        +string event
        +string createdAt
        +string completedAt
        +NodeStatus status
        +number score
        +string error
    }
    class NodeCurriculum {
        +number level
        +string benchmarkId
        +string benchmarkHash
    }
    class TaskResult {
        +string taskId
        +boolean passed
        +number durationMs
        +string output
        +string error
        +number inputTokens
        +number outputTokens
        +number costUsd
    }
    class Learning {
        +string[] learnedFrom
        +string diagnosis
        +string change
        +string prediction
        +string proposer
        +number round
    }
    class PairedComparison {
        +number parentScore
        +number candidateScore
        +number delta
        +string method
        +string reason
    }
    class TreeSummary {
        +string id
        +string domain
        +string model
        +string harness
        +string benchmarkId
        +string benchmarkHash
        +number totalTasks
        +string updatedAt
    }
    class AdapterManifest {
        +string id
        +string name
        +string command
        +string[] args
        +string protocol
        +number timeoutMs
    }
    class Benchmark {
        +string id
        +string name
        +string domain
        +string hash
    }
    TreeSummary "1" o-- "1..*" NodeRecord : groups
    NodeRecord "1" *-- "1" RunConfig
    NodeRecord "1" *-- "0..*" TaskResult : candidateTasks
    NodeRecord "1" *-- "0..1" PairedComparison
    NodeRecord "1" *-- "0..1" Learning
    NodeRecord "1" *-- "0..1" NodeCurriculum
    Learning --> NodeRecord : learnedFrom IDs
    PairedComparison "1" *-- "1..*" TaskResult : freshParentTasks
    NodeRecord "0..1" <-- "0..*" NodeRecord : parentId
    RunConfig --> AdapterManifest : adapterId
    RunConfig --> Benchmark : id and hash
```

`parentId`, `completedAt`, `score`, `error`, `comparison` and usage fields can be null where the shared schema permits it. `benchmarkPath`, `lineageId`, `learning`, `event` and `curriculum` are optional for historical compatibility. `event` is `evaluation` or `challenge`. A challenge checkpoint is a `baseline` with a structural parent, unchanged instructions and no paired comparison. Its benchmark hash differs from the prior level. Continuous lineage identity retains the same tree across those revisions; adopting an existing finite tree does not copy or rewrite its history. Association arrows describe identity references, not automatic database foreign keys. Tree grouping is derived from node files each time it is read. Benchmark hash covers definition, evaluator source and controller source digests.

## Campaign records

```mermaid
classDiagram
    class EvolutionCampaign {
        +string id
        +CampaignStatus status
        +string rootId
        +string lineageId
        +string[] candidateIds
        +number round
        +number completedRounds
        +number totalRounds
        +number branches
        +number beamWidth
        +number maxCandidates
        +number maxCalls
        +number callsUsed
        +string benchmarkHash
        +string activeNodeId
        +string selectionReason
        +string error
    }
    class EvolutionOptions {
        +boolean continuous
        +boolean adaptiveBranches
        +number branches
        +number beamWidth
        +number rounds
        +number maxCandidates
        +number maxCalls
    }
    class CampaignCurriculum {
        +number level
        +string benchmarkPath
        +string benchmarkId
        +string benchmarkHash
        +string baseBenchmarkPath
        +string baselineNodeId
        +string transitionParentId
    }
    class BudgetGrant {
        +number additionalCalls
        +number maxCalls
        +string grantedAt
    }
    class CampaignProposal {
        +string parentId
        +string hypothesis
        +string instructions
        +string[] learnedFrom
        +string diagnosis
        +string change
        +string prediction
        +number round
        +string nodeId
    }
    class CampaignCall {
        +string id
        +CallKind kind
        +number round
        +string nodeId
        +string taskId
        +CallStatus status
        +string startedAt
        +string completedAt
        +number inputTokens
        +number outputTokens
        +number costUsd
        +string error
    }
    class ProposerRun {
        +number round
        +string digest
        +string digestHash
        +string output
        +string error
    }
    class CampaignUsage {
        +number inputTokens
        +number outputTokens
        +number costUsd
        +number unknownCostCalls
    }
    EvolutionCampaign "1" *-- "1" EvolutionOptions
    EvolutionCampaign "1" *-- "0..1" CampaignCurriculum
    EvolutionCampaign "1" *-- "0..*" BudgetGrant
    EvolutionCampaign "1" *-- "0..*" CampaignProposal
    EvolutionCampaign "1" *-- "0..*" CampaignCall
    EvolutionCampaign "1" *-- "0..*" ProposerRun
    EvolutionCampaign "1" *-- "1" CampaignUsage
    CampaignProposal --> NodeRecord : parent and result
    CampaignCall --> NodeRecord : measured attempt
    EvolutionCampaign --> NodeRecord : root and candidates
```

Campaign options preserve the configured adapter/model/harness, benchmark source, settings and limits. A proposal's `nodeId` is null until its evaluation starts. A call's `nodeId` is null for proposal inference. Calls use kinds `proposal | baseline | parent | candidate | challenge` and statuses `reserved | completed | failed`. Campaign usage is a subtotal of reported values with an explicit count of unknown-cost calls. It is not a provider invoice.

Continuous mode ignores the finite `rounds` and `maxCandidates` ceilings. `options.adaptiveBranches` enables a width of 2-6 based on measured failures. New continuous campaigns enable it when no explicit branch count is supplied; finite campaigns default to a fixed two siblings. An explicit `--branches N` fixes the count within that range. `campaign.branches` stores the current width; `beamWidth` bounds the eligible parent frontier. The adaptive count is `min(6, 2 + distinct failed task IDs)` from the current beam and latest completed round on the same benchmark, including paired-parent failures. Once proposals are saved, that round keeps its width across resumption. `budgetGrants` records each explicit addition to the invocation allowance. Campaign curriculum references the current suite and the unchanged-champion checkpoint required before branching on a new level.

## Continuous learning sequence

```mermaid
sequenceDiagram
    actor Operator
    participant Engine as Evolution engine
    participant Campaign as Durable campaign
    participant Curriculum as Trusted curriculum and oracles
    participant Proposer as Model proposer adapter
    participant Runner as Evaluation runner
    participant Nodes as Immutable node history
    Operator->>Engine: evolve --continuous with adaptive width, beam and allowance
    Engine->>Campaign: save options and lineage, acquire exclusive lock
    opt No supplied baseline
        Engine->>Runner: measure baseline with reserved calls
        Runner->>Nodes: persist baseline task evidence
    end
    loop Until explicit control, resource wait or failure
        Engine->>Campaign: read pause or stop request
        Engine->>Nodes: read lineage and current-benchmark frontier
        alt Current benchmark has a perfect champion and completed sibling round
            Engine->>Curriculum: next level with permanent base cases and failure pins
            Curriculum->>Curriculum: compute and validate expected answers without model inference
            Curriculum-->>Engine: immutable fresh suite or verified-extension error
            alt Verified next suite exists
                Engine->>Campaign: save pending challenge transition
                Engine->>Runner: unchanged champion on new suite, with prior champion as parent
                Runner->>Campaign: reserve challenge calls
                Runner->>Nodes: challenge event, baseline status, level and suite hash
                Note over Engine,Nodes: No cross-level improvement claim or paired delta
            else Trusted extension unavailable
                Engine->>Campaign: waiting_challenge
            end
        else Current suite needs its next sibling round
            Engine->>Engine: select beam and adapt width from failed tasks, or use fixed 2-6 count
            Engine->>Engine: build bounded evidence plus archived lessons
            alt Allowance covers complete sibling round
                Engine->>Campaign: save digest and reserve proposer call
                Engine->>Proposer: public contracts, actual evidence and exact 2-6-sibling schema
                Proposer-->>Engine: actual proposal JSON and optional usage
                Engine->>Engine: validate shared parent, distinct changes and real learning references
                Engine->>Campaign: save proposals
                loop Each sibling, sequentially
                    Engine->>Runner: parent and candidate on same current benchmark
                    Runner->>Campaign: reserve parent and candidate calls before invocation
                    Runner->>Nodes: fresh paired evidence and measured verdict
                    Runner-->>Engine: measured result or retained failure
                end
                Engine->>Campaign: persist completed round, retain frontier
            else Allowance cannot cover next work
                Engine->>Campaign: waiting_budget
            end
        end
    end
    Engine->>Campaign: persist checkpoint and release lock
    Engine-->>Operator: durable campaign record
    Operator->>Engine: evolve --resume ID --grant-calls N
    Engine->>Campaign: record grant, continue same campaign and lineage
```

The proposer receives public prompts and bounded evidence rather than test cases or expected answers. Continuous requests retain eligible parents, nearby ancestry and recent experiments, plus compact summaries of archived failures and strategies, within 120,000 serialized characters. Full records stay on disk. `learnedFrom` includes the shared parent and only visible real evidence IDs; when measured mistakes are visible, each proposal cites at least one relevant mistake. It need not enumerate every historical record. Structural parentage and learning references are separate relations. This loop changes harness instructions, not model weights or arbitrary repository source.

The curriculum starts with 64 adversarial cases and introduces 48 fresh cases per level. It keeps all base cases, level-one anchors, the latest eight complete levels and every identified historical failing check. Generator/oracle source, base benchmark, seed, level and pins determine the immutable artifact identity. Per-case complexity bounds contain evaluation work; fresh deterministic inputs continue at later levels. Unsupported task contracts wait for a trusted extension.

## Run sequence

```mermaid
sequenceDiagram
    actor User
    participant CLI
    participant Runner
    participant Store
    participant Adapter
    participant Evaluator
    participant Browser
    User->>CLI: run with model, hypothesis and optional parent
    CLI->>Runner: parsed options
    Runner->>Runner: load benchmark, hash, validate parent and adapter
    Runner->>Store: save running node
    loop Each task
        opt Child comparison
            Runner->>Adapter: task with original parent config
            Adapter-->>Runner: code and optional usage
            Runner->>Evaluator: parent code and test cases
            Evaluator-->>Runner: pass or fail
        end
        Runner->>Adapter: task with candidate config
        Adapter-->>Runner: code and optional usage
        Runner->>Evaluator: candidate code and test cases
        Evaluator-->>Runner: pass or fail
        Runner->>Store: save task progress
        Browser->>Store: read through GET API
        Store-->>Browser: current running node
    end
    Runner->>Runner: baseline or paired score verdict
    Runner->>Store: save completed record
    Runner-->>CLI: full node
    CLI-->>User: JSON result
    Browser->>Store: next GET poll
    Store-->>Browser: final evidence
```

Adapter/process failure can interrupt the loop. The runner then stores `failed` with an error and any candidate tasks already completed. It does not skip the error and silently compare incomplete batches. A returned VM execution error is a task failure; evaluator startup, outer timeout, abnormal exit or invalid protocol is an evaluation failure. Campaign call controls record reservations and usage around the adapter independently of the evaluator result.

## Node state machine

```mermaid
stateDiagram-v2
    [*] --> Validation
    Validation --> Refused: invalid options, unknown adapter, wrong parent
    Validation --> running: initial node persisted
    running --> running: next task result persisted
    running --> baseline: root or unchanged-champion challenge completed
    running --> accepted: child score greater than fresh parent
    running --> rejected: child score equal to or below fresh parent
    running --> failed: adapter or orchestration error
    Refused --> [*]
    baseline --> [*]
    accepted --> [*]
    rejected --> [*]
    failed --> [*]
```

Validation and Refused are orchestration states, not `NodeRecord.status` values. A refused request may create no node. The persisted enum is exactly `running | baseline | accepted | rejected | failed`. A process crash may leave `running` on disk; there is no recovery daemon that invents a terminal state.

## Continuous campaign state machine

```mermaid
stateDiagram-v2
    [*] --> running: campaign persisted
    running --> running: reserve calls and persist measured progress
    running --> running: completed sibling round then verified challenge checkpoint
    running --> waiting_budget: allowance cannot cover next work
    waiting_budget --> running: explicit resume with sufficient grant
    running --> waiting_challenge: trusted fresh benchmark unavailable
    waiting_challenge --> running: explicit resume after extension is available
    running --> paused: pause request at persisted boundary
    paused --> running: explicit resume
    running --> stopped: explicit stop at persisted boundary
    stopped --> running: explicit operator resume
    running --> failed: invalid proposer or orchestration failure
    failed --> running: explicit resume checks retained work
    running --> Interrupted: worker ends before checkpoint
    Interrupted --> running: confirm termination, remove stale lock, resume
```

Continuous evolution has no terminal generation or lifetime candidate count. A budget wait, unavailable challenge, pause or stop preserves its lineage and ledger; none asserts that the harness has finished evolving. Explicit resume of a failed campaign checks retained state, but does not retry an invalid/interrupted proposer or silently replace failed evidence. Some failures therefore require a new campaign from a completed node.

Interrupted is an operational condition; the file remains `running`. Every existing lock is refused. After explicit stale-lock cleanup, resume marks interrupted reserved calls failed and spent, marks an incomplete active node failed, and continues only unattempted work. The ledger invariant is `callsUsed = calls.length ≤ maxCalls`. Grants increase `maxCalls` and remain recorded. Calls include proposal, baseline, challenge and both paired comparison sides. Opaque adapters may make internal provider requests or tool calls, so this is not a billing guarantee.

## Legacy finite campaign states

```mermaid
stateDiagram-v2
    [*] --> running
    running --> completed: requested rounds or whole candidate limit reached
    running --> saturated: perfect current suite after completed sibling round
    running --> budget_exhausted: next full round cannot fit allowance
    running --> failed: proposer or orchestration error
    completed --> [*]
    saturated --> [*]
    budget_exhausted --> [*]
    failed --> [*]
```

These finite states apply when `--continuous` is absent. They support bounded checks. A still-running finite campaign can recover after explicit stale-lock cleanup; terminal finite campaigns stay terminal on resume.

## Viewer state machine

```mermaid
stateDiagram-v2
    [*] --> InitialRead
    InitialRead --> Empty: no persisted trees
    InitialRead --> Showing: valid records
    InitialRead --> Error: read failure
    Empty --> Showing: poll finds a run
    Showing --> Showing: poll reconciles records and selected ID
    Showing --> Stale: failed poll
    Stale --> Showing: successful retry
    Showing --> Hidden: document hidden
    Hidden --> Showing: document visible and fresh read
```

The viewer's selection and active tabs are local presentation state. Only runner writes can change a node's recorded status. Copying a command or selecting a graph node has no execution side effect.
