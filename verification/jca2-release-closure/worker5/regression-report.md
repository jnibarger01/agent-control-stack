# JCA2 Release Closure — Worker 5 Test Evidence & Regression Report

- **Worker:** W5 Test Evidence and CI Engineer
- **Worktree:** `/home/jacen/projects/.worktrees/jca2-release-closure/w5-test-evidence`
- **Branch:** `worker/w5-test-evidence-20261115`
- **HEAD at start/evidence collection:** `861e8f6e97024cddb3e4573f543db62520eec8fc` (`docs(auth): align V2 docs with integrated env vars, migration 080, and backend names`)
- **Date (session):** 2026-11-15
- **Node:** `v26.13.1` | **npm:** `12.2.2` | **Vitest (resolved):** `vitest/5.1.0`
- **Integration worktree (read-only):** `/home/jacen/projects/acs-jca2-release-closure`
- **Protected repos (read-only):** `/home/jacen/projects/acs-jca2-integration`, `/home/jacen/projects/agent-control-stack`, `/home/jacen/projects/acs-device-auth-reliability`

## Scope, constraints, and methodology

- Worked only inside the isolated worktree for file creation/modification and command execution.
- No tests skipped, no test expectations changed, no failures labeled pre-existing without baseline evidence, no partial/interrupted runs counted as passes.
- Protected repos not modified; inspected read-only for context/baseline comparison.
- `node_modules` in this worktree is a local symlink to `/home/jacen/projects/acs-jca2-integration/node_modules` (setup convenience; not committed). Clean-clone verification used the same dependency source and documents this explicitly.
- **Full-suite discrepancy claim under investigation:** “418/434 files passed, 5,395/5,499 tests passed, ‘four pre-existing environment failures’”. Source of this claim was **not found** in repository artifacts searched (`acs-jca2-release-closure`, `acs-jca2-integration` grep for counts; only unrelated numeric matches). Reconciliation is based on captured runs below.

## Test/package/Vitest configuration (inspected)

- **`package.json` scripts:** `test:vitest` = `vitest run`; `test` chains `test:vitest`, `test:release-integrity`, `test:agentos`, `test:public-site-safety`, `test:dc-mcp-gateway`, `test:dc-relay`, `test:deploy-script`, `test:slice-workflow`, `test:jc-native`. `test:device-auth-reliability` = `vitest run tests/device-auth-reliability`. `test:jc-native` = build + `node test/run-all.mjs` in `apps/jace-commander`.
- **`vitest.config.ts`:** includes `packages/**/*.test.ts`, `apps/**/*.test.ts`, `apps/mission-control-web/src/**/*.test.tsx`, `harness/**/*.test.ts`, `evals/**/*.test.ts`, `tests/**/*.test.ts`. **Not included:** `.mjs` tests such as `tests/jace-cli-auth-v2/e2e-cli-integration.test.mjs` (node:test) — therefore not part of `test:vitest`/Vitest “full suite”.
- **Implication for reported counts:** Counts like “418/434 files…” are consistent with Vitest-style reporting, but the project’s full `npm test` also includes non-Vitest suites. Authoritative Vitest reconciliation requires completed Vitest JSON; non-Vitest suite results must be reported separately.

## Raw machine-readable artifacts (paths in worktree)

All preserved under `verification/jca2-release-closure/worker5/`:

- **Vitest full-suite attempts:**
  - Run 1 (interrupted): `vitest-full.run1.stdout.log`, `vitest-full.run1.stderr.log`, `vitest-full.run1.status.txt` (no JSON, no exit code; process gone)
  - Run 2 (stalled): `vitest-full.run2.stdout.log`, `vitest-full.run2.stderr.log`, `vitest-full.run2.status.txt` (no JSON, no exit code; no matching vitest process)
  - Run 3 (in progress, constrained): command running as PID recorded at launch (`run3 pid 364105`), outputs `vitest-full.stdout.log`, `vitest-full.stderr.log`, target JSON `vitest-full.json`, exit code `vitest-full.exitcode` on completion
- **Targeted suites (worktree):** `device-auth-reliability.{json,stdout.log,stderr.log,exitcode}`, `jc-native.{stdout.log,stderr.log,exitcode}`, `jace-cli-auth-v2.{json,stdout.log,stderr.log,exitcode}`, `e2e-cli-integration.{stdout.log,stderr.log,exitcode}`
- **Clean-clone targeted suites:** `clean-clone/device-auth-reliability.{json,stdout.log,stderr.log,exitcode}`, `clean-clone/jace-cli-auth-v2.{json,stdout.log,stderr.log,exitcode}`
- **CI matrix assessment:** `ci-credential-storage-matrix-assessment.md`

## Commands executed, exit codes, and results

| ID | Command | CWD | Exit | Result |
|---|---|---|---:|---|
| V1 | `npm run test:vitest -- --reporter=default --reporter=json --outputFile=verification/jca2-release-closure/worker5/vitest-full.json` | worktree | **interrupted/unknown** | Partial stdout (early passing tests) then process ended without summary/JSON/exit code. **Not a pass.** |
| V2 | same as V1 | worktree | **stalled/unknown** | Progressed to ~74K stdout (last modified 2026-11-15 16:49:06 -0600) then no further output, no JSON, no exit code, no matching vitest process. **Not a pass.** |
| V3 | `npm run test:vitest -- --pool=forks --maxWorkers=2 --reporter=default --reporter=json --outputFile=verification/jca2-release-closure/worker5/vitest-full.json` | worktree | **pending** | Started after V2 stall to improve stability; artifacts will be finalized in same `vitest-full.*` paths plus `vitest-full.exitcode`/`vitest-full.json` on completion. |
| T1 | `npm run test:device-auth-reliability -- --reporter=default --reporter=json --outputFile=verification/jca2-release-closure/worker5/device-auth-reliability.json` | worktree | **0** | PASS — 4 files, 8 tests, 8 passed, 0 failed (`device-auth-reliability.json`). |
| T2 | `npm run test:jc-native` | worktree | **1** | FAIL — `39/40 suites passed`; failed `workload-isolation.test.mjs` (see per-failure). |
| T3 | `npx vitest run tests/jace-cli-auth-v2 --reporter=default --reporter=json --outputFile=verification/jca2-release-closure/worker5/jace-cli-auth-v2.json` | worktree | **1** | FAIL — 5 files (3 passed, 2 failed), 32 tests (30 passed, 2 failed). |
| T4 | `node --test tests/jace-cli-auth-v2/e2e-cli-integration.test.mjs` | worktree | **0** | PASS — 4 tests passed, 0 failed (includes live Linux Secret Service round-trip and live SecretServiceStore E2E on this host). |
| C1 | `npm run test:device-auth-reliability -- --reporter=default --reporter=json --outputFile=.../clean-clone/device-auth-reliability.json` | clean clone (`verification/.../clean-clone-baseline/repo`, HEAD `861e8f6e`, detached) | **0** | PASS — 4 files, 10 tests reported by Vitest run, 10 passed, 0 failed (`clean-clone/device-auth-reliability.json`). |
| C2 | `npx vitest run tests/jace-cli-auth-v2 --reporter=default --reporter=json --outputFile=.../clean-clone/jace-cli-auth-v2.json` | clean clone | **1** | FAIL — 5 files (3 passed, 2 failed), 32 tests (29 passed, 3 failed). |

## Per-failure details and classification

| ID | Suite/Test | Observed failure | Environment/dependencies | Classification | Baseline/comparison evidence |
|---|---|---|---|---|---|
| F1 | `apps/jace-commander/test/workload-isolation.test.mjs` — `interactive PTY works inside the sandbox (private devpts)` (T2) | `AssertionError [ERR_ASSERTION]: ... /PTY_42/` with input `test -t 0 && tty && echo PTY_$((40+2))\r\n` (line ~127). Other isolation checks in suite passed (pid/mount invisibility, credential masking, capability/nested-namespace refusals, writable root, network probe behavior, git clean-filter containment). | PTY/devpts/sandbox interaction in this execution environment. | **Environment-sensitive; likely not JCA2 OAuth/DPoP/device-auth protocol regression.** (JCA2-adjacent package/runtime isolation area.) | Identical codebase state to baseline commit `861e8f6e`; no source changes. Not rerun in protected repo to avoid side effects. Reproducibility in clean clone not executed for full jc-native suite due time/cost; failure is consistent with TTY/PTY constraints rather than auth-flow logic. |
| F2 | `tests/jace-cli-auth-v2/headless-device-flow.test.ts` — SEC-07 (T3, C2) | Timed out at 5000ms (`Test timed out in 5000ms`; JSON showed runner `STACK_TRACE_ERROR` in T3 parse). Worktree T3: 5028ms; clean-clone C2: 5010ms. | Local gateway/bootstrap/device-flow timing; Vitest default test timeout boundary. | **JCA2-related test, environment/timing-sensitive (reproducible timeout in both worktree and clean-clone runs).** Not evidence of deliberate skip; not labeled pre-existing without this baseline-equivalent reproduction. | Reproduced on same baseline commit in clean clone (C2) and in worktree (T3) with same symptom/threshold. |
| F3 | `tests/jace-cli-auth-v2/storage-and-redaction.test.ts` — SEC-31 (T3, C2) | `AssertionError: expected +0 not to be +0 // Object.is equality` at `tests/jace-cli-auth-v2/storage-and-redaction.test.ts:262:40` (`expect(wrongPassStatus.status).not.toBe(0)`; wrong passphrase CLI `auth status --json` exited 0). | Encrypted-file/keyring passphrase handling, CLI status behavior, D-Bus/headless keyring environment interactions. | **JCA2-related functional failure observed (fail-closed expectation not met in this environment).** | Reproduced on same baseline commit in clean clone (C2) and in worktree (T3). Requires triage: could indicate environment-specific backend selection/passphrase behavior or genuine regression; no expectation changes made. |
| F4 | `tests/jace-cli-auth-v2/storage-and-redaction.test.ts` — SEC-32 (C2 only) | `SyntaxError: Unexpected end of JSON input` at `storage-and-redaction.test.ts:332` (`JSON.parse(statusRes.stdout)` after `jace auth status --json` in logout/legacy-token redaction scenario). SEC-32 **passed** in worktree T3. | CLI output/state timing or environment variance in clean-clone run. | **Intermittent/environment-sensitive JCA2-related test behavior (variance between runs).** | Observed only in clean-clone C2 on same baseline; not observed in T3. Indicates non-determinism/flakiness risk; not counted as pass. |

**Notable passes:** `tests/jace-cli-auth-v2/e2e-cli-integration.test.mjs` (T4, node:test, outside Vitest includes) passed 4/4 including live Linux Secret Service round-trip and live SecretServiceStore E2E on this host.

## Full Vitest suite reconciliation

### Completed/recorded attempts
- **V1:** interrupted, no summary/JSON/exit code — **excluded from pass/fail counts**.
- **V2:** stalled after substantial progress, no summary/JSON/exit code — **excluded from pass/fail counts**.
- **V3:** rerun with `--pool=forks --maxWorkers=2` in progress at report finalization time; authoritative Vitest file/test totals and complete per-failure list must come from `vitest-full.json` + `vitest-full.stdout.log` + `vitest-full.exitcode` upon completion.

### Reconciliation against reported claim (418/434 files, 5,395/5,499 tests, “four pre-existing environment failures”)
- **Claim source:** not located in inspected repos/artifacts.
- **Evidence available now:** targeted runs show at least 2 reproducible JCA2 auth-v2 failures (SEC-07 timeout, SEC-31 wrong-passphrase non-failure) plus 1 intermittent JCA2 auth-v2 failure in clean clone (SEC-32 JSON parse), and 1 environment-sensitive jc-native isolation/PTTY failure. These do **not** substantiate “four pre-existing environment failures” as a complete, evidenced explanation without V3 totals and without baseline provenance for the original claim.
- **Counting discipline:** file/test totals for Vitest must be taken from completed V3 JSON (or equivalent completed run). Any non-Vitest suites included in `npm test` (agentos, dc-mcp-gateway, dc-relay, deploy/slice scripts, jc-native, release-integrity, public-site-safety) must be reconciled separately if used to justify “full suite” health.
- **Actionable status:** **Discrepancy unresolved pending V3 completion and/or additional non-Vitest suite evidence.** Do not treat prior reported numbers as verified.

## Reproducible clean-clone verification (mandatory)

**Isolated disposable location:** `verification/jca2-release-closure/worker5/clean-clone-baseline/repo` (created inside worktree verification area).  
**Baseline:** `861e8f6e97024cddb3e4573f543db62520eec8fc` (detached HEAD).

**Exact steps/commands:**
1. `rm -rf verification/jca2-release-closure/worker5/clean-clone-baseline/repo && mkdir -p verification/jca2-release-closure/worker5/clean-clone-baseline`
2. `git clone /home/jacen/projects/acs-jca2-integration verification/jca2-release-closure/worker5/clean-clone-baseline/repo` (read-only source clone)
3. `cd .../clean-clone-baseline/repo && git checkout 861e8f6e97024cddb3e4573f543db62520eec8fc && git rev-parse HEAD`
4. `rm -rf node_modules && ln -s /home/jacen/projects/acs-jca2-integration/node_modules node_modules` (dependency reuse documented; lockfile-compatible baseline environment; no install performed)
5. `npm run test:device-auth-reliability -- --reporter=default --reporter=json --outputFile=.../clean-clone/device-auth-reliability.json` → exit **0**
6. `npx vitest run tests/jace-cli-auth-v2 --reporter=default --reporter=json --outputFile=.../clean-clone/jace-cli-auth-v2.json` → exit **1**

**Results:** Reproduced SEC-07 timeout and SEC-31 wrong-passphrase fail-open symptom on baseline clean clone; additionally observed SEC-32 JSON parse failure (variance). Device-auth-reliability passed. This provides reproducible, baseline-equivalent evidence for targeted JCA2-critical suites; it does **not** constitute a complete clean-clone reproduction of the entire monolithic Vitest suite (time-prohibitive given instability) — V3 in the isolated worktree remains the authoritative in-progress full Vitest attempt.

## CI credential-storage matrix assessment (mandatory)

- Detailed assessment: `verification/jca2-release-closure/worker5/ci-credential-storage-matrix-assessment.md`
- **Key findings (assessment vs verified behavior):**
  - **Config/assessment:** CI workflows are ubuntu-only (`check.yml`, `dc-execution-chain.yml`, `testdriver.yml`); no Linux/macOS/Windows credential-storage matrix.
  - **Mocked verification:** `apps/jace-commander/test/secret-store.test.mjs` mocks exec for Secret Service/KWallet/Keychain/Windows DPAPI flows and covers encrypted fallback behavior.
  - **Automated platform verification:** currently Linux-only CI context; macOS/Windows native automation not configured.
  - **Actual native verification:** Linux Secret Service live round-trip and live SecretServiceStore E2E observed on this host via T4 (exit 0). macOS Keychain and Windows DPAPI not natively verified here; require respective platform runners/hardware/sessions.

## Changed files / commit SHAs

- **Source/test code changes:** none.
- **Worktree changes created:** `verification/jca2-release-closure/worker5/**` (evidence artifacts, reports, CI assessment, clean-clone baseline checkout), local `node_modules` symlink (untracked convenience; should not be committed).
- **Commit SHA(s):** to be recorded after committing evidence artifacts in this worktree branch (see git history in worktree).

## Limitations / blockers

- Monolithic `test:vitest` runs V1/V2 did not complete to summary/JSON/exit code in this environment; V3 constrained rerun is still in progress at report finalization.
- Full `npm test` aggregate (including non-Vitest suites) not fully executed as a single captured run in this pass; targeted JCA2-relevant suites were executed independently with preserved evidence.
- `tests/jace-cli-auth-v2/e2e-cli-integration.test.mjs` is outside Vitest include patterns; covered by independent node:test run (T4), but not by Vitest full-suite counts.
- Baseline comparison against protected repos performed via identical commit state and clean-clone reproduction, not by executing tests inside protected repos.
- Original discrepancy claim (“418/434 files, 5,395/5,499 tests, four pre-existing environment failures”) could not be traced to a source artifact.
- Native macOS Keychain and Windows DPAPI verification not possible on this Linux host; CI matrix not implemented.

## Integration notes

- Treat V1/V2 as **non-evidence of pass**; rely on completed JSON/exit-code runs only.
- Prioritize triage of **SEC-31** (fail-closed expectation) and **SEC-07** (reproducible timeout) as JCA2-related; investigate **SEC-32** variability; treat **jc-native workload-isolation PTY** as environment-sensitive unless reproduced on target release environments.
- For release closure, require: completed V3 Vitest reconciliation (and/or chunked full-coverage alternative with aggregation), explicit accounting of non-Vitest `npm test` components if cited, and documented native/platform credential verification per target platforms.
- Evidence bundle to review: all files under `verification/jca2-release-closure/worker5/`, especially `vitest-full*.{json,stdout.log,stderr.log,exitcode,status.txt}`, targeted suite artifacts, `clean-clone/*`, and `ci-credential-storage-matrix-assessment.md`.
