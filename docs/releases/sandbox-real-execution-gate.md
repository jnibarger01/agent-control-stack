# Sandbox real-execution release gate

Status: **required checklist before enabling live sandbox execution**

`packages/sandbox` ships a dry-run simulation path used by the production
worker today. Bubblewrap/systemd backends and contracts also exist in-tree
([ADR 0010](../adr/0010-fail-closed-linux-sandbox.md),
[ADR 0014](../adr/0014-engine-isolation-boundary.md)), but **real execution
must not be wired into the worker or claimed in release notes until this gate
passes**.

This document is the written release gate. It does not implement live
execution. Completing the checklist is a prerequisite for any PR that:

- changes `executionMode` away from `"dry_run"` on the worker path;
- enables live backends for default local/production worker runs;
- claims hardened OS sandbox isolation or real command execution.

## How enforcement works

- Reviewers: treat an incomplete checklist as a hard block on PRs that enable
  live sandbox execution.
- CODEOWNERS: `.github/CODEOWNERS` requires `@jnibarger01` review for
  `packages/sandbox/**` and this file so sandbox-exec PRs cannot land without
  owner review (enable required reviews / CODEOWNERS on the default branch).
- Optional CI: a path filter on `packages/sandbox/**` or worker execution-mode
  changes may require this file to be updated or explicitly acknowledged in
  the PR description.

## Checklist

Copy into the enabling PR and mark each item only when proven (tests + review).
Do not mark an item complete based on dry-run simulation alone.

### 1. Path containment

- [ ] Request workspace host path is absolute, normalized, and equal to the
      authoritative per-attempt allocation after `realpath`.
- [ ] Working directory stays inside the workspace after lexical and realpath
      resolution (including symlink and rename-race cases).
- [ ] Only intended mounts are present; host home, sibling worktrees,
      credential dirs, and service state are not reachable.
- [ ] Linux integration tests prove filesystem escape denial (symlink escape,
      `..` traversal, rename races) or report `BLOCKED` when host prerequisites
      are absent—not a silent pass.

### 2. Environment allowlist

- [ ] Child environment is deny-by-default (`clearenv` / no parent inheritance).
- [ ] Only contract-allowlisted names are accepted (see
      `sandboxEnvironmentNames` / engine credential injection rules).
- [ ] Ambient credentials, SSH agents, and cloud provider env vars are not
      visible inside the sandbox.
- [ ] Tests cover rejection of non-allowlisted variables and empty/denied
      inheritance.

### 3. Output caps

- [ ] stdout/stderr are hard-capped (`limits.outputBytes` / equivalent).
- [ ] Truncation is observable in the result (flags / bounded message), not
      unbounded buffering.
- [ ] Wall-clock, CPU, memory, PID, and tmpfs limits are mandatory and verified;
      unverifiable limits fail closed.
- [ ] Tests cover truncation and resource-limit enforcement (or `BLOCKED` when
      cgroup/backend prerequisites are missing).

### 4. Network controls

- [ ] CommandBroker / default live path uses `network: "none"` with a new
      network namespace; no host-network fallback.
- [ ] Engine isolation (if enabled) uses a separate audited egress contract
      (ADR 0014)—never by weakening CommandBroker `network: "none"`.
- [ ] Tests prove network denial for the CommandBroker backend (or `BLOCKED`
      when unsupported).

### 5. Approval binding

- [ ] Live launch requires an approved action/plan hash bound to the current
      work item / attempt (exact hash, not a vague “approved earlier”).
- [ ] Lease, worker identity, fencing/epoch, and policy version match the
      attempt authority receipt before process creation.
- [ ] Stale leases, superseded plans, and hash mismatches fail closed with no
      process start.
- [ ] Dry-run results cannot satisfy a live execution, verification, or
      completion requirement.

### 6. Audit evidence

- [ ] Canonical SQLite `audit_events` records execution intent **before**
      process creation (fail closed on audit write failure).
- [ ] Completion observations (exit/signal, truncation, cleanup, backend
      identity) are recorded with result acceptance.
- [ ] Unknown outcomes (lost process / incomplete cleanup) cannot become
      `succeeded`; they enter blocked/quarantined recovery.
- [ ] Secrets and credential values are redacted from audit and returned
      output.

## Explicit non-goals (this gate)

- Implementing or enabling real execution in the worker.
- Claiming Bubblewrap isolation solely because backend code exists in
  `packages/sandbox`.
- Relaxing dry-run alpha claims in the root README before every checklist
  item above is complete.

## References

- Root README [Known limitations](../../README.md#known-limitations)
- [`packages/sandbox/README.md`](../../packages/sandbox/README.md)
- [ADR 0010: Fail-closed Linux sandbox](../adr/0010-fail-closed-linux-sandbox.md)
- [ADR 0014: Engine isolation boundary](../adr/0014-engine-isolation-boundary.md)
- [v0.1.0-alpha release notes](./v0.1.0-alpha.md)
