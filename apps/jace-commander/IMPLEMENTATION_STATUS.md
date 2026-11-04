# Native JC implementation status

Development verdict: PARTIAL. Deployment/release is blocked pending independent review.

Implemented: independent package, JC-owned shell and PTY relay, byte output cursors,
bounded process groups and timeouts, caller-owned sessions, binary file writes,
contained deletion, four approval-gated tools, redacted ACS summaries, current
work-item/lease verification, native bridge default, CachyOS user-service template,
forward database migration and regression tests.

Verified during the Codex continuation: 27/27 native package suites in a physical
copy outside the repository; no Desktop Commander or workspace files available.
Gateway routing/attestation: 37/37 tests. Migration/approval/drift suites and the
gateway's new-tool approval tests pass; full logs are in
/home/jacen/projects/release-evidence-20261103/codex-resume/.

Remaining release gates:
- Full repository check, including all baseline failures and coverage/audit.
- Native JC execution against a real ACS instance through the production-equivalent
  authenticated edge; client-specific ChatGPT/Claude/Codex/OpenClaw compatibility.
- Migration 076 number reservation and preflight (075 is already used elsewhere).
- Account/process isolation for approved shell commands. A contained cwd and
  scrubbed child environment are not an OS sandbox or same-UID credential isolation.
- Explicit review and rollout approval. No live credentials, services, endpoints,
  persistent databases, Tailscale settings, rulesets or merges were changed.

The original unrelated managed-attestation fixture edits and backup files remain
outside the local native-JC checkpoint unless explicitly listed in its commit.

Final continuation checks:
- Root Vitest, with real CLI interop explicitly disabled and maxWorkers=4:
  5,097 passed, 1 failed, 95 skipped. The remaining failure is the unchanged
  local-advisor NO_PROXY proxy-dispatch test; it also fails in isolation.
- Root typecheck and lint: pass after migration-fixture correction.
- Complete dc-mcp-gateway suite: 205 passed, 0 failed.
- Release integrity, AgentOS, public-site safety, relay, deployment-script
  sandbox and slice-workflow suites: pass.
- Dependency audit: fails; see dependency-audit.log. No blanket audit fix ran.
- Authority coverage was not reached by the repository check.
- ARES continuation: draft PRs #2 through #7 opened; all stay draft.
