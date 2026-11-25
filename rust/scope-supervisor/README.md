# Rust scope supervisor

The Linux scope supervisor slice has a Rust termination coordinator exercised
through a private stdio pipe in the sandbox parity tests. It consumes lifecycle
events and emits decisions. The existing TypeScript backends continue to own
authority verification, process creation, signal delivery, output capture and
the final systemd cleanup observation.

## Protocol version 1

One process represents one fixture session. The caller sends one UTF-8 JSON
line per event with `version: 1`, `seq` starting at one, and an `event`
object. The frame limit is 1,024 bytes including LF and the session limit is
16 events. A reply carries the same version and sequence and an ordered
`effects` array. The coordinator flushes the reply before reading again.

| Event type               | Fields                                             | Meaning                                        |
| ------------------------ | -------------------------------------------------- | ---------------------------------------------- |
| `cancel`                 | None                                               | The caller observed cancellation.              |
| `deadline_elapsed`       | None                                               | The caller's deadline elapsed.                 |
| `grace_elapsed`          | None                                               | The grace timer armed by this session elapsed. |
| `scope_signal_completed` | `signal` (`term` or `kill`) and `failed` (boolean) | The pending scope signal settled.              |
| `launcher_closed`        | None                                               | The caller observed launcher close.            |

The first cancellation or deadline orders `signal_scope` with TERM. A matching
scope reply normally orders `signal_launcher` and, after TERM, `arm_grace`.
Grace expiry orders KILL. Close produces `clear_timers` and suppresses late
launcher effects. Any issued scope signal must settle before `finish`.
`finish` carries `trigger` and `signal_failed`. This is the termination
classification. The TypeScript host still needs verified cleanup before
publishing an execution outcome.

Malformed frames, seq replay, invalid transitions, EOF before finish, and
session exhaustion exit nonzero. Earlier replies may already have been
delivered. Test code never turns those replies into systemd operations. A future
live caller must correlate the private channel to the current attempt and fence
and treat a lost helper as an unknown outcome. The current prototype has no
service entry point, authority fields, workload arguments or signal target
identifiers in its interface.

## Protocol version 2: live supervised scope

`acs-scope-supervisor supervise` runs one admitted attempt. It is opt-in with
`ACS_SANDBOX_SUPERVISOR_BACKEND=rust` (default `typescript`) and an optional
absolute `ACS_SCOPE_SUPERVISOR_PATH`. The selection is fixed for a backend
instance. A selected helper that is missing or not executable fails the host
probe with `sandbox_supervisor_missing`; there is no silent fallback. The
observation's `backendVersion` ends in `+scope-supervisor-rust-v2` so the
backend used for each attempt is recorded.

| Owner       | Responsibilities                                                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACS (TS)    | Authority receipt, workspace verification, unit name, systemd and bubblewrap invocation, launcher environment allowlist, redaction, rendered output cap, result acceptance. |
| Rust helper | Process creation in a new process group, deadline and grace timers, scope and launcher signals, raw combined output cap, reaping, terminal scope cleanup observation.       |

**Start frame.** One LF-terminated JSON line of at most 64 KiB on the helper's
stdin: `version: 2`, `type: "start"`, a `session` with a random `sessionId`
(at least 16 characters), the work item, attempt, lease, worker, fencing token
and unit name, the rendered `command` and `args`, the explicit `environment`,
`systemctlPath` and the wall-clock, grace and output limits. The helper checks
identifiers, normalized absolute executable paths, argument and environment
bounds, and that `args` begin with `--user --scope` and contain exactly one
`--unit=` flag naming the session's unit. A rejected start emits
`{"version":2,"type":"rejected","code":...}`, exits nonzero and launches
nothing.

**Control frames.** At most 16 LF-terminated lines of at most 1,024 bytes,
each carrying `version`, the `sessionId`, the `fencingToken` and a `seq`
starting at one, with event `{"type":"cancel"}`. A stale fence, foreign
session, replayed or out-of-order sequence, malformed or oversized frame
terminates the workload and is reported as `protocolViolation`. EOF on stdin
(parent loss) terminates the workload and sets `parentLost`.

**Observation.** Exactly one line: the echoed session binding, `trigger`,
`signalFailed`, `terminationError`, `launchError`, `exitCode`, `signal`,
`cleanup`, base64 `stdout`/`stderr` with byte counts and truncation flags,
`protocolViolation`, `parentLost`, `abandoned` and `durationMs`. Termination
decisions reuse the v1 coordinator. Cleanup follows the TypeScript reference:
a fresh terminal `systemctl --user is-active` status, and after a forced kill a
fresh terminal status within the same bounded retries. If the launcher has not
closed by deadline + grace + 10 s, the helper kills the group and scope and
reports `abandoned` with cleanup `unknown`.

**ACS acceptance.** The client validates the frame schema, every binding field
against the issuing request and invocation, canonical base64 and byte
accounting against the output budget, bounds the frame by that budget, and
runs a watchdog at deadline + grace + 30 s. A missing, rejected, malformed,
duplicate or mismatched frame, a nonzero helper exit, a violation, parent loss
or abandonment yields cleanup `unknown`. ACS then makes a best-effort forced
scope stop, and the observation outcome is `unknown`, which requires governed
reconciliation before retry or publication.

The helper's own descriptors are close-on-exec. The workload receives
`/dev/null` on stdin and fresh output pipes, so the control channel is not
reachable from the scope.

## Build and verify

Run from the ACS repository root.

```sh
cargo fmt --check --manifest-path rust/scope-supervisor/Cargo.toml
cargo clippy --locked --manifest-path rust/scope-supervisor/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path rust/scope-supervisor/Cargo.toml
cargo build --locked --release --manifest-path rust/scope-supervisor/Cargo.toml
ACS_TEST_SCOPE_SUPERVISOR=1 npm run test:vitest -- packages/sandbox/src/scope-supervisor-parity.test.ts packages/sandbox/src/rust-supervisor.test.ts
ACS_TEST_SCOPE_SUPERVISOR=1 npm run test:sandbox-integration -- --no-file-parallelism
ACS_SANDBOX_INTEGRATION=1 ACS_SANDBOX_SUPERVISOR_BACKEND=rust npm run test:vitest -- packages/sandbox/src/linux.integration.test.ts
```

`tests/supervise.rs` drives protocol v2 against fake launcher and `systemctl`
shims. The live parity block in `linux.integration.test.ts` runs identical
requests through both backends on real bubblewrap and systemd scopes.

Cargo exercises protocol and state-machine behavior. The opt-in Vitest suite
sends the same lifecycle sequence to the compiled Rust executable and the
TypeScript reference and compares the signal and finish effects after each
event. The Rust tests inspect explicit timer directives and the TypeScript
tests check that the timer state is cleared. The caller owns elapsed time in
both paths. The built binary lives under this crate's ignored `target/`
directory.
