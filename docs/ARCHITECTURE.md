# Architecture

The next LoopBench architecture uses a persistent worker, E2B-isolated Pi execution and NVIDIA Nemotron inference through Nebius Token Factory. The hosted system is proposed, not implemented.

- [Updated hosted architecture and diagrams](ARCHITECTURE-HOSTED.md)
- [Detailed implementation plan](superpowers/plans/2026-10-27-hosted-pi-e2b-implementation.md)
- [Design specification](superpowers/specs/2026-10-27-e2b-pi-design.md)
- [Data, API and event contracts](HOSTED-CONTRACTS.md)
- [Deployment, security, budgets and recovery](HOSTED-OPERATIONS.md)
- [Frontend flows and states](HOSTED-UX.md)
- [Hosted UML diagrams](HOSTED-UML.md)
- [Current local implementation architecture](ARCHITECTURE-LOCAL.md)

The local reference preserves the working CLI, JSON store, read-only browser and their evidence limits. Hosted documentation must not be used to claim that E2B or Pi integration already runs in this repository.
