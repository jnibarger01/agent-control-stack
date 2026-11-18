# ACS integration graph pilot evidence

## Custody and baseline

- Worktree `acs-rust-pilot-20261118`, branch `feat/acs-rust-pilot-20261118`, starting commit `383bb218f40f6326ff95d4557a541047967d2d5c`. The initial only modification was the HarnessKit session timestamp.
- The target graph was the top-ranked Rust Anything candidate. Its native eligibility covers unique positive safe-integer PR numbers and the string and boolean fields used by each operation. The TypeScript implementation handles the remaining inputs. The same production adapter is used in strict replay and benchmarking. [Analyzer output](rust-anything-analysis.md)
- Initial toolchain was Node 26.13.1 and npm 12.2.2. After `npm ci`, the pre-build focused run passed 36 tests and failed to collect five suites because workspace dependency outputs were absent. After the workspace build, the focused baseline passed 104 tests across seven files.
- Unmodified `npm run check` exited 1 on the host toolchain. Vitest reported 5,321 passed, 100 skipped and four failures across three files. The focused reproduction repeated all four. OpenClaw rejected legacy `agents.list` in the test fixture, OpenCode rejected `--pure`, Hermes timed out at 30 seconds, and Node 26 disagreed with the proxy guard for `NO_PROXY=*,example.com`. The proxy guard passed under CI's Node 24.16.0.

## Pilot verification

| Check                                                                   | Observed result                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rust-anything record` and `diff`                                       | 16/16 recorded calls matched, with Map and Set order checked. Corpus covers empty input, forked branches, multiple parents, detached propagation, cycles, file multiplicity, UTF-16 traps and identifiers above the signed 32-bit limit. |
| Rust Anything shadow                                                    | 16 side-by-side calls and zero mismatches with generated QA shadow using the same adapter.                                                                                                                                               |
| `rust-anything gate`                                                    | All 11 checks passed. Includes release build, API, ordered recorded behavior, fmt, clippy with warnings denied, Cargo tests and no handwritten unsafe blocks.                                                                            |
| `cargo test --locked`                                                   | Two tests passed, including an iterative walk of 20,000 stacked PRs.                                                                                                                                                                     |
| `npm run test:vitest -- packages/integration-manager` with native flags | 108 passed across eight files on Node 24.16.0. Includes 256 generated graph inputs for both native functions, public package invocation, fallback, reconciliation, merge simulation and gate behavior.                                   |
| `npm run typecheck` and affected ESLint                                 | Both exited zero after the bridge lint fix.                                                                                                                                                                                              |
| `node rust/integration-graph/package-smoke.mjs`                         | Compiled package layout loaded the addon on opt-in and called both functions. Missing-artifact fallback and fresh-process rollback produced identical ordered results.                                                                   |

The Linux x86-64 GNU build used rustc and Cargo 1.99.1, Rust Anything 1.5.1 and the crate lockfile. The addon checksum was `102407d551924cac89340504b7534625bc708b633c95615ed2ce9f3522580187` and the highest referenced glibc symbol version was 2.34. [Gate JSON](evidence/graph-gate.json) · [Recorded corpus](../../rust/integration-graph/cases.jsonl)

The native integration run covering the integration manager, Outcome Engine, CLI outcome command and outcome boundary tests passed all 248 tests across 20 files.

The compiled package smoke test also passed in a read-only Debian Bookworm container with networking disabled, Node 24.16.0 and glibc 2.36. This used the Dockerfile's `node:24.16.0-bookworm-slim` base at digest `sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203`. It also passed on Bookworm with Node 24.22.3. The tests used staged synthetic fixtures, the built addon and the package loader. The scratch filesystem needs executable mappings for Node to load the addon.

## Repository gate

- `npm run check` exited 1 with the CI pins Node 24.16.0 and npm 11.17.0 on the local Linux host. Optional external CLI tests used the CI-style no-client configuration. An unresolved OpenCode fixture override selected its normal skip path because the installed binary rejects the fixture's `--pure` flag. The separate focused runs exercised native graph opt-in.
- Formatting, lint, build, public/DC/JC contract drift, dry-run release boundary, Mission Control harness checks, and the main Vitest run passed. Vitest reported 5,322 passed and 107 skipped across 425 files. The gate advanced to `test:jc-native`, where 33 of 35 suites passed. The approval fixture failed to observe a marker from a child using the temporary Node binary path, and the workload isolation fixture failed to observe expected PTY output. The approval failure repeated on the pinned binary. The isolated PTY rerun passed on the pinned binary, and the full Jace Commander suite passed 35 of 35 on the host's system Node.
- A retry installed the pinned toolchain under an ignored worktree directory with the standard `bin/node`, `bin/npm` and `lib/node_modules/npm` layout. That put the Node executable outside the workload sandbox's private `/tmp` and satisfied the ACS sandbox unit fixture's npm layout. The pinned standalone Jace Commander run passed 35 of 35 suites, and the ACS Linux sandbox unit suite passed all 12 tests. Two full-gate retries with the corrected layout each reached 5,321 passed and 107 skipped before a different gateway fixture failed its five-second timeout. The affected production-config suite passed 10 of 10 on its own, and the affected agent-dispatch case passed in 766 ms in isolation. The eight-worker full retry still timed out in agent dispatch, so the full-gate discrepancy is open.
- With the sandbox output fix and four Vitest workers, the root Vitest run passed 5,325 tests with 107 skips. The full gate then passed 34 of 35 Jace Commander suites. The private PTY test received the command echo ahead of its output. A controlled 250 ms delay reproduced that assertion failure. The fixture now follows both output cursors within its original five-second deadline and still checks the computed marker, the private devpts path and termination. All 13 workload-isolation tests passed in three focused runs after the fixture change.
- The subsequent full `npm run check` with the pinned toolchain, CI-style external CLI skips and four Vitest workers passed every stage through authority coverage. The main and coverage runs each passed 5,325 tests with 107 skips. All 35 Jace Commander suites and all 12 authority coverage thresholds passed. The chained command exited 1 at `npm run security:audit` with the same 15 moderate and six high findings. The repository verdict remains PARTIAL.
- The failed Jace Commander suite ended the chained command before authority coverage and audit. `npm run test:authority-coverage` passed separately under the same CI-style configuration and met all 12 file thresholds. `npm run security:audit` exited 1 with 15 moderate and six high findings in the baseline npm dependency tree. The advisory reports no patched picomatch release through 4.0.7, which matched the registry's latest version at verification time. The pilot changes no npm dependencies. [High-severity advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
- Browser and external CLI interoperability gates were limited to their documented test conditions. Cross-platform native binaries and a production canary remain future acceptance work.

## Performance

Node 24.16.0, Linux x86-64, AMD Ryzen 7 9800X3D, one pinned logical CPU. Both implementations used identical synthetic PR snapshots, including branch stacks, fork flags and file overlaps. Inputs follow reconciliation's ascending PR order. The GitHub source refuses a partial result beyond 100 open PRs, so 150 and 1,500 PRs measure kernel capacity. Measurements include request projection, Node-API calls and reconstruction of the public result. The workload benchmark warmed both paths, alternated run order, and took the median of seven rounds. It checks ordered parity at each size before timing.

| Dataset   | Operation    | TypeScript ms/call | Rust ms/call | TS/Rust |
| --------- | ------------ | -----------------: | -----------: | ------: |
| 24 PRs    | Dependencies |              0.029 |        0.018 |   1.62× |
| 24 PRs    | Overlaps     |              0.045 |        0.041 |   1.10× |
| 100 PRs   | Dependencies |              0.216 |        0.042 |   5.14× |
| 100 PRs   | Overlaps     |              1.342 |        0.487 |   2.75× |
| 150 PRs   | Dependencies |              0.333 |        0.062 |   5.35× |
| 150 PRs   | Overlaps     |              3.029 |        1.111 |   2.73× |
| 1,500 PRs | Dependencies |             32.823 |        0.683 |  48.04× |
| 1,500 PRs | Overlaps     |            311.471 |       74.928 |   4.16× |

Rust Anything's recorded mix measured 3.22× for dependencies and 1.38× for overlaps. An earlier descending-order workload measured 0.94× for overlaps at 24 PRs, so these small-input timings cannot establish a reliable adoption threshold. The larger speedups reflect algorithmic differences as well as language. Keep TypeScript as the default. [Rust Anything benchmark](evidence/graph-rust-anything-bench.txt) · [Workload benchmark JSON](evidence/graph-benchmark.json)

## Live sandbox baseline for the next slice

The opt-in Linux and engine containment suites exercised Bubblewrap 0.13.1, systemd and cgroup v2 on disposable fixtures. The initial run passed 16 of 18 tests. A serial baseline rerun passed 17 of 18 and reproduced 1,026 bytes of rendered UTF-8 against a 1,024-byte cap. The Linux cancellation observation was `unknown` with cleanup `failed` in the initial run. It passed in isolation and in the serial reruns.

Both backends now preserve the aggregate raw capture counter, drop incomplete UTF-8 tails at the cut and cap both strings after redaction. Three focused regressions failed before the implementation and passed after it. The real engine tests continue to check exact raw counts at both 1,024 and 1,025 bytes. They also check the aggregate bound on the returned strings and reject a replacement character introduced by cutting valid UTF-8.

`npm run test:sandbox-integration -- --no-file-parallelism` exited zero on Node 24.16.0 with 45 passing tests, including all 18 live cases. All per-file coverage thresholds passed. Typechecking and affected ESLint passed. Three additional runs with the Linux and engine files running in parallel passed 18 of 18 each. They did not reproduce the prior cancellation discrepancy. [Output contract](../../packages/sandbox/README.md#observation-output) · [Next slice](rust-roadmap.md#next-slice-for-linux-scope-supervision)

## Scope supervisor reference

The Linux and engine launchers now use one TypeScript termination coordinator. The first timeout or cancellation wins. Close clears its timers and finishes any in-flight scope signal before verification. A launcher that has reported an exit receives no further process-group signal. Engine cancellation during proxy setup returns before workload creation and removes the temporary proxy directory.

Deterministic tests model close during an outstanding TERM and during an outstanding KILL. They check the trigger, carried termination error, timer count and absence of late launcher signals. Cleanup tests require a clean inactive or absent response and distinguish an interrupted or ambiguous probe. An active or transitioning scope still triggers forced cleanup without a verified result. This is a reference for the selected Rust supervisor. The private handoff and recovery on supervisor loss remain open. [Observation contract](../../packages/sandbox/README.md#scope-cleanup-observations)

The updated `test:sandbox-integration` coverage gate passed all 61 tests, including 19 live cases. All six source files met their per-file thresholds. Aggregate branch coverage was 80.64%. The package-scoped Rust Anything analysis identified async sequencing and callbacks in both launcher units. The roadmap retains an out-of-process boundary for this lifecycle work.

Three parallel runs of the updated live suites passed 16, 18 and 19 of 19 tests. The failures included a clean engine exit with `cleanup: failed` and two allowlisted egress fixture exits with code 1. The three affected cases passed together in three focused reruns. Three parallel runs from an unmodified export of `03dd9d20235232b1d74c142a81264d59417c1fce` passed 18, 18 and 17 of 18. The baseline failure had the same clean-exit/failed-cleanup signature in a different engine case. The concurrent egress exit remains unresolved. The serialized coverage result qualifies the reference behavior under those test conditions, while concurrent host parity remains open.

The Rust Anything gate matched 16 of 16 graph cases, and the compiled graph package smoke test passed. The full `npm run check` with the pinned toolchain and four workers passed 5,340 tests with 108 skips in each Vitest run, all 35 Jace Commander suites, and authority coverage. The final npm audit exited 1 with 15 moderate and six high findings.

## Isolated Rust termination coordinator

The new Rust executable implements the termination decisions over private stdio. It processes one bounded session and preserves the first trigger, settles the pending signal before finish, and suppresses launcher effects after close. Each request and reply uses the same version and sequence. The binary has no authority, process-launch, signal-delivery, or cleanup-verification interface.

The four initial protocol tests failed against the empty binary before implementation. All six Cargo protocol tests passed after implementation, including invalid-frame, replay, session exhaustion and early-EOF checks. Cargo formatting, Clippy with warnings denied and the locked release build passed on Rust 1.99.1. The six Node-driven parity fixtures exercise request/reply streaming and matched the signal and finish effects from the TypeScript coordinator at each event. The compiled binary also completed a clean-close session in the pinned read-only Debian Bookworm image with networking disabled. [Protocol and build commands](../../rust/scope-supervisor/README.md)

The opt-in serialized sandbox coverage gate passed 67 of 67 tests with the six parity fixtures enabled. It met every per-file threshold. Four concurrent diagnostic runs in a scratch export pinned to one CPU passed 19, 19, 19 and 18 of 19. The prior allowlisted egress exit did not recur. The final run again observed unknown cleanup, this time on the engine timeout case.

The Rust binary is isolated to the test harness. The TypeScript launch paths still own approval, effects and systemd cleanup. Live adoption still needs the attempt- and fence-bound handoff and recovery tests, as well as resolution of the concurrent cleanup and egress gaps. [Integration roadmap](rust-roadmap.md#next-slice-for-linux-scope-supervision)

The full `npm run check` with the pinned toolchain, four Vitest workers and coordinator parity enabled passed 5,346 tests with 108 skips in each Vitest run, all 35 Jace Commander suites, and authority coverage. It exited 1 at the npm audit with 15 moderate and six high findings. The graph gate and package smoke passed again, along with all 248 focused graph and consumer tests.
