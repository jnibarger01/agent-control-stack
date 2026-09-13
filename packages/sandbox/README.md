# `@agent-control-stack/sandbox`

Execution boundary for ACS.

## Current status

- **Worker path:** dry-run simulation only (`executionMode: "dry_run"`).
- **In-tree backends:** Bubblewrap/systemd contracts and Linux/engine isolation
  code exist for future live use; they are **not** the production worker
  execution mode in v0.1.0-alpha.

Do not claim real command execution or hardened OS sandbox isolation until the
release gate below is complete.

## Real-execution release gate

Before enabling live sandbox execution (worker wiring, default configs, or
release claims), complete:

**[Sandbox real-execution release gate](../../docs/releases/sandbox-real-execution-gate.md)**

That checklist covers path containment, environment allowlist, output caps,
network controls, approval binding, and audit evidence. CODEOWNERS requires
owner review on this package for PRs that touch the sandbox boundary.

## Related

- [ADR 0010: Fail-closed Linux sandbox](../../docs/adr/0010-fail-closed-linux-sandbox.md)
- [ADR 0014: Engine isolation boundary](../../docs/adr/0014-engine-isolation-boundary.md)
- Root README [Known limitations](../../README.md#known-limitations)
