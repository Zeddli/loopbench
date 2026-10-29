# Technology stack

Token Factory Sandboxes execution uses its official REST v1 operation/subprocess API through `hosted/tokenfactory-client.ts`, with no additional SDK dependency. The worker runs Pi in an approved Node 24 image, disables guest networking, relays inference through a root-owned loopback service and uses independent verifier operations. E2B remains a separately pinned provider. See [Token Factory execution](TOKEN-FACTORY-SANDBOXES.md) for its lifecycle and accounting.

## Hosted implementation

The official E2B JavaScript SDK is installed and pinned to `2.61.0`. Hosted modules use Node SQLite and crypto without an ORM. The [implementation plan](superpowers/plans/2026-10-27-hosted-pi-e2b-implementation.md) records dependencies and verification requirements. Remote Pi/runtime compatibility and deployment readiness are checked independently of package installation.

| Technology or service                            | Planned role                                                      | Constraint                                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Persistent Linux CPU host plus TLS proxy         | Next.js API, worker/reaper and public inference gateway           | Persistent disk required; hosting charges are separate from E2B and Nebius                     |
| Node 24 LTS plus `node:sqlite`                   | Single-host jobs, ownership, events and monetary reservations     | Verify/pin a supported runtime patch and API; no shared multi-host SQLite file                 |
| Official `e2b` JavaScript SDK                    | Isolated Pi attempts and fresh verifiers                          | Pin the implementation version and verify create retry, metadata, timeout and network behavior |
| Official E2B `pi` template, optionally derived   | Pre-installed agent and repeatable task workspace                 | Record actual build/Pi/Node versions; a moving alias is not an evaluation identity             |
| Pi JSON/RPC                                      | Tool events, control and settled execution                        | Version-matched event parser; global local Pi setup remains untouched                          |
| Token Factory model catalog and chat completions | Cheapest compatible NVIDIA Nemotron for executor/optimizer        | User-owned encrypted key, scoped gateway and verified tool/JSON support                        |
| Node crypto and external keyring                 | Encrypted credentials and scoped grants                           | Keys stay outside browser persistence, agent workspaces and reusable snapshots                 |
| Private persistent artifact directory            | Immutable submissions, safe diagnostics and publication snapshots | Not a public static directory; hidden verifier material remains internal-only                  |
| Token Factory Data Lab, follow-on milestone      | Trace/verdict lesson datasets and controlled skill ablations      | Demonstrate actual export before claiming integration; no model-weight training claim          |

Select the cheapest currently compatible Nemotron, rather than assuming a model from its name. The documented initial price-tie preference is `nvidia/Nemotron-3_5-Lightning`; exact availability/rates come from the connected account. The user's planned USD 5 Nebius top-up concerns inference, is not a confirmed balance, and is separate from the platform's USD 100 E2B ceiling.

## Currently installed local stack

Versions here describe this repository's package declarations, not Petri's dependencies and not a claim to use the newest release. `package-lock.json` records the installed resolution. Use `npm ci` when the lockfile is present.

| Technology           | Declared version                                    | Role and reason                                                                                                                                                                                                |
| -------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Next.js              | `16.4.3`                                            | App Router pages and read-only API routes in one local process. Server code can read the run directory directly.                                                                                               |
| React / React DOM    | `19.2.4`                                            | Selection, filters, periodic refresh and record views.                                                                                                                                                         |
| Geist                | `^1.8.2`                                            | Bundled local sans and mono fonts, loaded by the root layout without depending on a remote font request.                                                                                                       |
| TypeScript           | `^5.9.3`                                            | Shared run types across CLI, store and browser. Strict compiler settings catch mismatched records before execution.                                                                                            |
| Zod                  | `^4.3.6`                                            | Runtime parsing at benchmark, adapter and stored-record boundaries. JSON input has no TypeScript guarantees.                                                                                                   |
| tsx                  | `^4.21.0`                                           | Runs the TypeScript CLI and Node test files without a separate CLI compilation step.                                                                                                                           |
| Prettier             | `^3.9.10`                                           | Repository formatting during development.                                                                                                                                                                      |
| Node.js              | Node 24+ recommended; current workspace is `25.6.0` | Filesystem, crypto, subprocesses, test runner and the permission-flagged JavaScript evaluator. Use a runtime with the `--permission` flag; the current workspace version is the directly observed environment. |
| Native SVG and CSS   | Browser built-ins                                   | Precise left-to-right graph geometry, keyboard-selectable nodes, theme tokens and responsive layout without a graph framework.                                                                                 |
| JSON files           | Versioned schemas                                   | Inspectable local evidence and adapter manifests; no database setup for a local lab.                                                                                                                           |
| Codex CLI            | External installation                               | Runs an actual configured model using the user's existing CLI setup. Its version and availability are machine-specific.                                                                                        |
| Nebius Token Factory | Optional HTTP adapter                               | A path to runtime inference with an NVIDIA open-source model. It requires a configured account, model ID and an explicitly opted-in budget.                                                                    |

## Why this is smaller than the concept note

The concept note proposed PostgreSQL, Docker workers, separate proposer/critic roles and signed attestations. The current implementation includes an actual model proposer, continuous branching search with adaptive 2-6-sibling rounds, retained failure lessons, paired execution and verified challenge progression. It keeps those records in local JSON. A database would add deployment work without improving the current single-machine measurements. A separate adversarial critic, signed attestations and arbitrary repository patch execution remain additional work.

There is no ORM, workflow engine, message broker, graph-layout package, charting package, wallet SDK or consensus network in the current dependency set. This keeps the local program runnable with npm and an installed adapter. Those are architectural choices for this build, not claims that they suit a production multi-tenant service.

## Dependency and process boundaries

The web bundle imports presentation code and shared data types. Node filesystem and subprocess operations stay in server/CLI modules. `core/evolution.ts` controls the proposer/runner feedback loop and persistent frontier; `core/campaigns.ts` persists reservations, explicit grants and control requests and locks each campaign to one local worker. `core/curriculum.ts` and `core/curriculum-oracles.ts` generate immutable fresh suites with independent expected answers, anchors and permanent regression pins. This path performs no model inference. Continuous context uses bounded recent evidence and compact archived lessons so prompts do not grow with the raw history. Adapters are standalone executables, so a Python, Rust, JavaScript or shell-based harness can participate if it implements `loopbench.task.v1`.

The generic protocol is the extension point. A new task adapter translates model/harness work into an `output` string and available usage. It should not calculate its own benchmark pass rate. LoopBench evaluates the function separately from the adapter's claimed reasoning. A proposer adapter returns an output string containing the required proposal JSON; the evolution engine validates it before any candidate is measured. The optional Nebius adapter supports both roles through `settings.responseFormat`.

The benchmark registry includes a three-task smoke suite and the six-task/64-case adversarial suite. A revision hashes the parsed definition and the evaluator/controller source bytes. `RunConfig.benchmarkPath` retains the resolved source location. These choices preserve comparability when the evaluator or custom task source changes.

## Environment

`LOOPBENCH_HOME` controls the local catalog. Secrets belong in the environment or the provider's existing login, never in adapter manifest arguments, screenshots or committed files. The built-in Codex integration uses the installed CLI. Provider-specific settings and hard request limits belong in the corresponding adapter.

The browser can run with no adapters available and no run files. Its correct initial state is an explanation of how to make a first run. Viewing records and running unit tests should not incur inference charges.

## Upgrades

Change dependency versions through the lockfile, then run `npm run typecheck`, `npm test` and `npm run build`. For Next/React upgrades, also inspect the home page, empty state, active campaign priority, tree selection, challenge stage bars, per-benchmark statistics, graph zoom and polling with the local server. For adapter changes, verify protocol parsing and timeouts before making a live provider call. An installed CLI's response event schema can change independently of this package.
