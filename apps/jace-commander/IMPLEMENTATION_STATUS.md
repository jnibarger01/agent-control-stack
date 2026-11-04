# Native JC implementation status

Branch `feat/jc-release-gates-20261104` (worktree `acs-jc-gates-5bb846f3`), built on
Codex's checkpoint `5bb846f3`. Development verdict: release gates 1-4 closed and
verified locally; deployment still requires independent review and explicit
rollout approval (nothing was deployed, published or reconfigured).

## Release gates

| Gate | Status | Evidence |
| --- | --- | --- |
| 1. Credential isolation | Closed | bubblewrap workload sandbox for every workload and git; `test/workload-isolation.test.mjs` (13 checks, real bwrap, host-visible fixtures): no host PIDs/environ, masked credential stores / ACS DB / env files / runtime bus, read-only runtime, no persistence, no capabilities or nested userns, network namespace, PTY works, no survivor after kill/timeout (fails on the previous engine), fail closed |
| 2. Authenticated ACS integration | Closed | `tests/e2e/acs-jc-mcp` 27/27 against real ACS (SQLite, acs.jc.v1 signing), OAuth edge, bridge and native JC: approval-gated execution, denial, post-issuance revocation and lease expiry, replay, principal isolation, audited `execution_result.accepted` |
| 3. Dependencies and migrations | Closed (17 moderate remain, dev tooling / @vercel/queue) | npm audit 39 -> 17 (high 5 -> 0); shipped JC graph 0 findings; migration 076 order-safe vs both 075s; migration suites 63/63 |
| 4. Standalone runtime | Closed | `npm run jc:verify-release`: clean install outside all repos with `$HOME/projects` masked, 123 runtime packages all inside the release, 30/30 + 27/27 suites, real MCP SDK client session (11 checks), 309 resolved modules all inside the release; chain e2e 27/27 against an installed release |
| 5. Hardening | Done for this scope | defects fixed below; docs and templates updated |

## Defects found and fixed in this continuation

- Live authority check unusable against real ACS (model-facing token, never set) -> dedicated read-scoped credential; mismatch reasons reported.
- Sandboxed workload could survive `kill_process` (die-with-parent startup race) -> PID-namespace init killed on every exit path.
- `kill_process` returned before termination; `interact_with_process` returned the terminal echo instead of output.
- ACS database / `~/.config/acs` env file were reachable by workloads and file tools.
- Release verifier recorded `ENOLOCK` as "no audit findings".

## Baseline failures (not introduced by this branch; identical at 69dc9fbd)

- `packages/local-advisor` egress NO_PROXY case `*,example.com` on Node v26.13 (guard is stricter: the safe direction).
- Real CLI interop tests for the locally installed OpenCode, Hermes and OpenClaw CLIs (installed CLI versions).

Root vitest: 5098 passed, 4 failed (the baseline cases above), 96 skipped.

## Not verified here

- ChatGPT, Claude, Codex and OpenClaw against the public endpoint (requires publishing the endpoint; not authorized).
- Privileged helper and approverd installation (root changes; not performed).
- The bridge env template edit (blocked by a local guardrail on `*.env*` paths; see README migration step 4).
