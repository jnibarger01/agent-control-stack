# Rust scope termination coordinator

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

## Build and verify

Run from the ACS repository root.

```sh
cargo fmt --check --manifest-path rust/scope-supervisor/Cargo.toml
cargo clippy --locked --manifest-path rust/scope-supervisor/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path rust/scope-supervisor/Cargo.toml
cargo build --locked --release --manifest-path rust/scope-supervisor/Cargo.toml
ACS_TEST_SCOPE_SUPERVISOR=1 npm run test:vitest -- packages/sandbox/src/scope-supervisor-parity.test.ts
```

Cargo exercises protocol and state-machine behavior. The opt-in Vitest suite
sends the same lifecycle sequence to the compiled Rust executable and the
TypeScript reference and compares the signal and finish effects after each
event. The Rust tests inspect explicit timer directives and the TypeScript
tests check that the timer state is cleared. The caller owns elapsed time in
both paths. The built binary lives under this crate's ignored `target/`
directory.
