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

## Repository gate

- `npm run check` exited 1 with the CI pins Node 24.16.0 and npm 11.17.0 on the local Linux host. Optional external CLI tests used the CI-style no-client configuration. An unresolved OpenCode fixture override selected its normal skip path because the installed binary rejects the fixture's `--pure` flag. The separate focused runs exercised native graph opt-in.
- Formatting, lint, build, public/DC/JC contract drift, dry-run release boundary, Mission Control harness checks, and the main Vitest run passed. Vitest reported 5,322 passed and 107 skipped across 425 files. The gate advanced to `test:jc-native`, where 33 of 35 suites passed. The approval fixture failed to observe a marker from a child using the temporary Node binary path, and the workload isolation fixture failed to observe expected PTY output. The approval failure repeated on the pinned binary. The isolated PTY rerun passed on the pinned binary, and the full Jace Commander suite passed 35 of 35 on the host's system Node.
- The failed Jace Commander suite ended the chained command before authority coverage and audit. `npm run test:authority-coverage` passed separately under the same CI-style configuration and met all 12 file thresholds. `npm run security:audit` exited 1 with 15 moderate and six high findings in the baseline npm dependency tree. The pilot changes no npm dependencies. [High-severity advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
- Browser and external CLI interoperability gates were limited to their documented test conditions. Cross-platform native binaries and a production canary remain future acceptance work.

## Performance

Node 24.16.0, Linux x86-64, AMD Ryzen 7 9800X3D, one pinned logical CPU. Both implementations used identical synthetic PR snapshots, including branch stacks, fork flags and file overlaps. Measurements include request projection, Node-API calls and reconstruction of the public result. The workload benchmark warmed both paths, alternated run order, and took the median of seven rounds. It checks ordered parity at each size before timing.

| Dataset   | Operation    | TypeScript ms/call | Rust ms/call | TS/Rust |
| --------- | ------------ | -----------------: | -----------: | ------: |
| 24 PRs    | Dependencies |              0.050 |        0.026 |   1.95× |
| 24 PRs    | Overlaps     |              0.070 |        0.074 |   0.94× |
| 150 PRs   | Dependencies |              0.650 |        0.097 |   6.70× |
| 150 PRs   | Overlaps     |              3.958 |        1.733 |   2.28× |
| 1,500 PRs | Dependencies |             63.215 |        1.143 |  55.29× |
| 1,500 PRs | Overlaps     |            475.268 |      178.982 |   2.66× |

Rust Anything's recorded mix measured 3.22× for dependencies and 1.38× for overlaps. The larger speedups reflect algorithmic differences as well as language. Payload size, overlap density and the bridge all affect latency. Keep TypeScript as the default. [Rust Anything benchmark](evidence/graph-rust-anything-bench.txt) · [Workload benchmark JSON](evidence/graph-benchmark.json)

## Live sandbox baseline for the next slice

The opt-in Linux and engine containment suites exercised Bubblewrap 0.13.1, systemd and cgroup v2 on disposable fixtures. The run passed 16 of 18 tests. Engine output decoding produced 1,026 UTF-8 bytes against a 1,024-byte cap, which reproduced in a focused run. The Linux cancellation observation was `unknown` with cleanup `failed` in the full run. It passed when run in isolation, so the cancellation discrepancy remains unresolved. Both suites used the existing sandbox code. The supervisor implementation is deferred pending an independently green baseline. [Next slice](rust-roadmap.md#next-slice-for-linux-scope-supervision)
