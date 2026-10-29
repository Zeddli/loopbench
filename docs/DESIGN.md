# Interface design and Petri reference

This document describes the local viewer. Proposed hosted key-connection, experiment-creation and owned evidence flows are in [HOSTED-UX.md](HOSTED-UX.md). Preserve the same Petri-style tree when implementing that extension.

The interface should make a recorded experiment understandable before asking the user to run another one. The reference is Petri's home composition and horizontal lineage workspace. [PETRI-STUDY.md](PETRI-STUDY.md) separates observed behavior from source findings. LoopBench uses that visual structure with its own local runner and narrower evidence claims.

## Routes and page structure

| Route             | Main content                                                                                                                                                                                    | Data source                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `/`               | Product introduction, Domain/Model/Harness filters, branching tree cards, active continuous campaign priority, separate baseline/single-branch and failed records, continuous evolution command | Current store and adapter registry |
| `/tree/[id]`      | Breadcrumb, harness/model title, benchmark, Tree/Stats switch, graph, selected strip, full record and task evidence                                                                             | One persisted tree                 |
| `/adapters`       | Registered executable manifests, downloads, registration commands and protocol example                                                                                                          | Current adapter registry           |
| `/api/trees`      | JSON array of current trees                                                                                                                                                                     | `listTrees()`                      |
| `/api/trees/[id]` | JSON for one tree or not-found response                                                                                                                                                         | `getTree(id)`                      |
| `/api/campaigns`  | Durable campaign progress, proposals and call accounting                                                                                                                                        | `listCampaigns()`                  |

Home prioritizes running or waiting continuous campaigns so the current search is easy to find. Home filter options derive from actual tree values. An adapter being registered is not evidence that a model ran. The empty page offers a command with explicit placeholders and adapter setup guidance. When records exist but filters match none, the page explains the filter result and retains the real catalog.

## Reference measurements and reconstruction choices

| Element                 | Petri source reference                      | LoopBench implementation                               |
| ----------------------- | ------------------------------------------- | ------------------------------------------------------ |
| Header                  | 52px height, 1240px inner max               | 52px sticky header, 1240px inner max                   |
| Body                    | 14px base, line-height 1.55                 | Same base and line-height                              |
| Content                 | 1240px standard / 1440px wide, 24px sides   | Same standard/wide maxima and 24px sides               |
| Primary heading         | 26–34px responsive                          | 28–36px home, 26px tree title                          |
| Selector group          | Three fields and action in rounded panel    | Same composition, actual-value filters                 |
| Cards                   | Auto-fill, minimum 340px, 14px gaps         | Same grid principle and gap                            |
| Tree generation spacing | 420 SVG units                               | 420 SVG units                                          |
| Tree leaf spacing       | 74 SVG units                                | 104 SVG units for longer labels                        |
| Tree height             | Derived from rows                           | At least 620px, then grows with rows                   |
| Node selection          | Violet ring, status, hypothesis, numbers    | Same hierarchy, local status vocabulary                |
| Record                  | Below graph; 380px detail column on desktop | Below graph; 380px detail column, then tab/task column |

This is an interaction and visual-system reconstruction, not a pixel-identical copy. Row spacing and the learning/campaign records are explicit changes. Keep them in this table when adjusting the UI so a future pass can distinguish drift from an intentional decision.

## Tokens

The current app uses a dark palette throughout. Petri also has a light theme, which is a reference rather than an implemented LoopBench feature.

| Token     | LoopBench value | Use                                         |
| --------- | --------------- | ------------------------------------------- |
| Paper     | `#0a0b0d`       | Page ground                                 |
| Surface   | `#111317`       | Cards, graph and records                    |
| Sunk      | `#16181d`       | Controls, command blocks and code           |
| Ink       | `#edeef0`       | Main text                                   |
| Mid       | `#a4a8b0`       | Supporting text                             |
| Faint     | `#7f8590`       | Labels and metadata                         |
| Rule      | `#282b33`       | Panel edges                                 |
| Rule soft | `#202329`       | Internal separators                         |
| Pass      | `#a79bf0`       | Baseline/accepted glyphs and active details |
| Pass soft | `#221e3a`       | Selected and accepted surfaces              |
| Fail      | `#ee9280`       | Rejected/failed labels and glyphs           |
| Fail soft | `#2e1c18`       | Failure verdict surfaces                    |

Panels generally use 10px radii; selectors use 8px; the composer uses 14px. Use thin borders and restrained contrast rather than heavy shadows. The root layout imports bundled Geist Sans and Geist Mono from `geist` 1.8.2 and sets their CSS variables. System fallbacks remain available. No remote font service is required to load the bundled typefaces.

## Make learning visible

The main catalog calls a history branching only when a parent has competing children. Baselines and single-child histories remain accessible in their own group; all-failed histories remain in a collapsed section. A failed process record must not be presented as an evolved tree merely because it has an ID.

The workspace campaign banner shows current generation, continuous mode, challenge level, proposal count, adapter-call reservations, status and selection reason. Resource checkpoints offer explicit continuation commands. Historical benchmark pages explain the unavailable revision and link to the current continuous lineage when one exists, rather than inviting an invalid comparison. Challenge transitions have their own labels, and statistics are grouped by benchmark revision. Counts say Evaluations and include real challenge checkpoints; neither a checkpoint nor a tie is labeled a learned upgrade. The banner shows the selected 2-6-sibling width for the current round, adapted from failures unless the operator fixed it. A perfect score does not remove the required competing experiments. The banner reads durable state; it does not predict that a proposal will pass.

Each evolution node exposes a Mistake → Lesson → Harness change → Outcome record below the graph. Source-node buttons select the actual `learnedFrom` evidence, including rejected or failed nodes. The model diagnosis and prediction are labeled as proposal reasoning; task diagnostics and paired outcomes are measured evidence. The graph's parent ancestry and learning references are distinct relationships. A lesson can cite a rejected sibling while the structural parent is another version.

## Graph layout

`components/lineage.ts` groups nodes by `parentId`. Missing parents become roots for display. Each leaf gets a separate row. Accepted children are visited between the upper and lower groups of other children, and a parent's y-position is the midpoint of its immediate children's extent. Generation determines x-position. A visited/visiting guard prevents unbounded traversal of damaged data; it is not a substitute for store validation.

`LineageGraph.tsx` draws cubic Bezier edges first, then status glyphs and label backgrounds. The node label hierarchy is status plus shortened ID, hypothesis, then measured score/progress/delta. Rejected/failed edges use a dashed treatment. Selection has a ring and visible text, so color alone is insufficient to describe status.

Benchmark stage bars identify challenge levels. The graph supplies zoom and viewport controls and scrolls horizontally when its natural width exceeds the container. Avoid shrinking labels until they are unreadable. The selected strip remains a text summary below the graph and links to the full record. Small previews reuse the lineage shape without claiming a new score.

## Interaction contract

- Selecting a node updates its strip, record, task evidence and parent link. It does not launch execution or change a verdict.
- Graph nodes support keyboard focus and Enter/Space selection. There is no global Space shortcut that simulates acceptance.
- Tree/Stats changes the view. Stats plots individual recorded scores, including rejected experiments, in separate panels per benchmark hash. It does not connect different test sets as one improvement curve or imply uncertainty estimates.
- The record shows the hypothesis, status reason, task counts, paired comparison, configuration fingerprint, adapter, times, reported usage and raw JSON.
- Goal, Rules, How it works and Limits tabs explain this tree's benchmark and the local comparison policy. Do not borrow Petri's independent-key language.
- Task rows expand to show candidate output, errors and paired parent evidence when available.
- Copy controls copy CLI commands. They never mutate records. Templates require the operator to edit the hypothesis and instructions.
- Adapter registration happens through the CLI. The browser lists manifests and can download them; it does not execute their commands.
- Continuation offers both an autonomous `evolve` command and a manual intervention when the selected node is completed and its benchmark revision is available. Historical data stays inspectable when the evaluator or task source has changed, but its invalid continuation command is withheld.

## Live behavior

`useLiveRecords` polls every two seconds while the document is visible, avoids overlapping requests and aborts on unmount. Returning to the tab triggers a fresh read. The parser validates the payload before replacing displayed records. If a poll fails, the last valid data remains with an update-error message and the next interval retries.

Selection is keyed by node ID so a refresh does not jump away from the node under inspection. A new node should not impersonate the selected node. New progress changes must come from store data, not a timer that increments a score.

## Responsive layout and accessibility

At widths below 1100px, the record's left column reduces to 330px. Below 800px, record columns stack, the legend moves into normal flow, stats become two columns and protocol examples stack. Campaign counts become two columns below 600px. Below 520px, page padding is 16px, selector fields fill their own rows and the primary action spans the composer.

Preserve visible focus outlines, native select labels, button states, semantic landmarks and text status. Respect `prefers-reduced-motion` by removing smooth scrolling/transitions. Long IDs and outputs must wrap or scroll inside their panels. The graph may scroll inside its own container; the entire page should not require horizontal scrolling on a phone.

## Visual acceptance checklist

- [ ] Empty installation contains no prepared experiment cards or score history.
- [ ] Desktop home matches the introduction/composer/cards hierarchy.
- [ ] The graph is the main workspace element, with the full record below it.
- [ ] All actual nodes appear, including rejected, failed and running nodes.
- [ ] Branching trees, baselines/single branches and all-failed histories are classified from real parent relationships.
- [ ] Campaign progress is read from saved reservations and completed work.
- [ ] Home prioritizes active continuous campaigns and historical pages link to the correct current lineage.
- [ ] Challenge baselines retain their parent edges and are distinct from accepted harness changes.
- [ ] Stage bars, graph zoom and separate per-benchmark statistics remain usable across a deep real history.
- [ ] Learning sources select actual records and diagnosis is distinguishable from measured outcome.
- [ ] A fresh CLI task result appears after a successful visible-tab poll.
- [ ] Copying or pressing Space cannot manufacture acceptance.
- [ ] Keyboard selection reaches the corresponding full evidence.
- [ ] Small-screen content stays readable and graph overflow stays contained.
- [ ] Error states retain the last valid result and distinguish a stopped update from a completed run.

The checklist is a manual review contract. A build or unit test does not by itself establish that every visual item passed.
