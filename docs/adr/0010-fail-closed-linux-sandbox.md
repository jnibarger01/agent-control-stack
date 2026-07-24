# ADR 0010: Live execution requires a fail-closed Linux sandbox

## Status

Accepted

## Context

`packages/sandbox` currently returns a dry-run result and executes no process.
That is safe as a simulation boundary, but it is not process isolation.

The first Engine Harness release targets Linux Mint/Ubuntu-compatible Linux and
must execute one allowlisted command inside a per-attempt Git worktree. Engine
output, repository contents, command arguments, and tool requests are untrusted.
An execution path that silently falls back to the host when isolation is
missing would turn a configuration error into unrestricted code execution.

## Decision

`packages/sandbox` is the sole process-containment adapter. Live execution uses
Bubblewrap (`bwrap`) as the initial namespace and mount backend, with cgroup v2
resource enforcement through a separately verified local launcher. No
unsandboxed live backend exists.

Dry-run remains a distinct simulation mode. It may be used by tests and
operator previews, but a dry-run result cannot satisfy a live execution,
verification, or completion requirement.

### Required execution contract

A live sandbox request is immutable and contains, at minimum:

- work-item ID, attempt ID, lease ID, worker ID, and current fencing value;
- approved action or plan hash and policy version;
- a workspace allocation ID plus canonical host worktree path;
- an executable selected from a closed command profile;
- an argument vector, never a shell command string;
- a workspace-relative working directory;
- a deny-by-default child environment with explicitly supplied values;
- network mode (`none` for the first release);
- wall-clock, CPU, memory, PID, and output-byte limits;
- an idempotency key and audit correlation ID.

The sandbox validates this contract itself even when the caller already
validated it. It returns bounded observations: backend identity, start/finish
timestamps, exit status or signal, truncation flags, resource usage, and a
cleanup result. It does not decide work-item success.

### Preflight and fail-closed behavior

Before process creation, the backend must verify:

1. `bwrap` is the expected executable and supports the required namespace
   options.
2. User namespaces and mount namespaces are available to the service account.
3. The cgroup v2 controller/launcher can enforce the configured limits.
4. The canonical workspace path equals the allocation recorded for the attempt.
5. The workspace is not shared with another active attempt.
6. The requested cwd stays below the workspace after lexical and realpath
   resolution.
7. Every mounted path has an explicit read-only or read-write purpose.
8. The executable and arguments match an allowlisted command profile.
9. The child environment contains only contract-approved names.
10. The canonical audit sink has durably recorded execution intent.

Any missing, inconsistent, or inconclusive check denies execution. Backend
unavailability, unsupported host features, audit failure, workspace lookup
failure, lease/fence mismatch, and policy lookup failure are errors, not
reasons to run directly.

### Filesystem boundary

The per-attempt worktree is the only mutable host bind mount. The sandbox root
is assembled explicitly:

- the workspace is mounted at a fixed in-sandbox path;
- required runtime binaries and libraries are mounted read-only;
- `/proc` and device exposure are minimal;
- temporary storage is an isolated size-bounded tmpfs;
- the host home directory, repository parent, other worktrees, credential
  directories, sockets, and service state are not mounted;
- symlink traversal is checked before launch and contained again by the mount
  namespace;
- teardown never follows workspace-owned symlinks.

Path prechecks reduce mistakes but do not constitute isolation. Namespace mount
layout is the enforcement boundary for filesystem reachability.

### Process and network boundary

- Network is disabled with a new network namespace for the first release.
- No host network fallback is permitted.
- The process runs without a shell, with a new PID namespace and a controlled
  process group.
- Cancellation and timeout terminate the complete process tree, first
  gracefully and then forcibly after a bounded grace period.
- CPU, memory, PID, output, and wall-clock budgets are mandatory.
- A failure to place the process in its intended cgroup before useful work can
  begin aborts execution.

### Credentials

No parent environment is inherited. The first release passes no reusable
credentials. Credential mediation is a later capability and must inject only a
single-use or narrowly scoped value for one declared operation; it may not
mount a general credential store.

### Audit and unknown outcomes

The canonical audit store records intent before launch. Completion observations
and cleanup status are recorded with result acceptance. If ACS loses the
ability to determine whether a process ran or whether cleanup completed, the
attempt outcome is unknown and cannot become successful. It must enter a
blocked or quarantined recovery path.

## Consequences

- Phase 1 can implement and test containment without introducing an engine.
- The workspace manager must exist before model-driven execution is enabled.
- Host prerequisite failures are visible readiness failures.
- Bubblewrap constrains namespace and mount reachability; cgroups constrain
  resources. Application tests alone cannot claim those OS properties.
- Command profiles are capabilities, not a general shell allowlist.

## Required tests

Application-level tests must cover strict request parsing, command-profile
denial, environment sanitization, missing backend, stale lease/fence,
workspace mismatch, output truncation, cancellation, and unknown outcomes.

Linux integration tests must prove filesystem escape denial (including symlink
and rename races), network denial, process-tree cleanup, and CPU, memory, PID,
output, and wall-clock limits using the real backend. These tests must report
`BLOCKED`, not pass, when host prerequisites are absent.

## Rejected alternatives

### Direct `child_process.spawn` with path checks

Rejected. Path checks do not isolate processes, mounts, network, or descendants.

### Docker as the first backend

Rejected for the first local release because it adds daemon authority and image
lifecycle to a narrow local requirement. It may be evaluated later through the
same contract.

### Best-effort limits

Rejected. A limit that cannot be verified is not a security boundary.

### Dry-run fallback when Bubblewrap is unavailable

Rejected for live work. The caller may explicitly request a simulation, but ACS
must never relabel it as execution or completion.
