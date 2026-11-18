# ADR 0031 — Incremental Rust components in ACS

## Status

Proposed for the larger migration. The opt-in integration graph is implemented and its local verification is recorded in the [pilot evidence](../migrations/rust-pilot-evidence.md).

## Context

ACS serves HTTP, SSE and MCP clients, coordinates agents and records authority in its transactional store. Rust Anything ranked the integration graph first among 599 units. It identified insertion-ordered collections as the main parity risk. The module has no runtime imports and its results inform read-only pull request reconciliation. [Analysis](../migrations/rust-anything-analysis.md) · [Integration Manager](../integration-manager.md)

The sandbox and engine backends currently have separate launch loops with shared scope cleanup and output handling. Their authority receipts, host prerequisites, namespace construction and egress rules apply independently of the implementation language. [ADR 0010](0010-fail-closed-linux-sandbox.md) · [ADR 0014](0014-engine-isolation-boundary.md)

## Decision

TypeScript continues to own the application and protocol surfaces, authorization and orchestration. Rust can own bounded computation or host operations one component at a time. Each interface has a version, an independently verifiable compatibility gate and a rollback procedure. Agents retain their existing ability to act within ACS-issued scopes. The policy gate, exact-action approvals, lease fencing, result acceptance and canonical SQLite audit chain keep a single owner. [ADR 0009](0009-engine-harness-authority-and-dependencies.md) · [ADR 0011](0011-canonical-audit-sink.md) · [Worker leases](../protocol/worker-leases.md)

- **Pure computation** may use an optional in-process Node-API addon. The graph passes PR numbers and interned string identifiers in one call per operation. The adapter reconstructs JS Maps, Sets and file ordering. A package-local module path and explicit ABI version control loading. TypeScript is the default and handles inputs outside the native subset. A requested addon that cannot load or throws a JS exception falls back with a bounded diagnostic.
- **Process lifecycle and isolation** need an out-of-process, Linux-specific boundary. A supervised helper can own bounded capture, cancellation, reaping and cleanup evidence after ACS admission. ACS owns policy, capability and lease checks, workspace allocation, isolation profiles, redaction and result acceptance. Helper loss or uncertain cleanup yields an unknown attempt outcome for governed recovery. Backend selection is pinned per attempt. Rollback applies to subsequent authorized attempts once the previous backend is eligible. [Supervisor slice](../migrations/rust-roadmap.md#next-slice-for-linux-scope-supervision)
- **Worker IPC** starts with an attempt-bound transport below the existing worker protocol. Version negotiation, bounded messages and backpressure precede adoption. ACS verifies attempt, lease, input and action bindings in its current transactions. An acknowledgment is transport evidence. Canonical state comes from ACS.
- **Events and evidence** start with read-only replay or manifest verification. Require golden byte, ordering, redaction and failure parity for persisted versions. Future writers need crash and restart evidence as well as transaction and hash-chain compatibility. [ADR 0021](0021-looptrace-evidence-spine.md)

## Alternatives considered

A Rust gateway or whole-app front door would move routing and authentication before the execution contracts are ready. An in-process addon for sandbox supervision would share the gateway's failure domain. A migration daemon for unrelated units would couple their deployments and availability.

## Consequences

Native binaries add per-platform build, provenance and support costs. A native abort can terminate a Node process. Small graphs may spend more time crossing the bridge than computing their answer. Keep TypeScript as the operational default while measuring production-shaped workloads. Rolling back an already loaded addon requires a fresh process.

The [roadmap](../migrations/rust-roadmap.md) defines the sequence, compatibility gates and open acceptance work. The [native runbook](../migrations/rust-graph-runbook.md) covers build, packaging and rollback.
