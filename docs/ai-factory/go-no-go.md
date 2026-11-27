# F12 production go/no-go matrix

**Decision (2026-11-18): NO-GO.** The factory must stay disabled (`ACS_FACTORY_INTAKE_ENABLED` unset). Nothing here authorizes a merge, deploy, or live traffic. Only an operator can sign a limited rollout, and the P0 items below block that.

| # | Gate (from the F12 slice card) | Status | Evidence / blocker |
|---|---|---|---|
| 1 | `npm run check` green on pinned builds | **FAIL** | `npm audit --audit-level=high` fails on picomatch GHSA-fc5q-39xc-vjpf (no patched release; also fails on `main`). The rest of `check` ran locally; some failures are environment-specific (local Node 26 vs CI 24, locally installed agent CLIs). |
| 2 | Integration tests | PASS (local) | Gateway factory suite, runtime suite, F11 rehearsal. |
| 3 | Policy / authority tests | PASS (local) | Forged actor, IDOR, stale preview/plan, approval binding, fencing. |
| 4 | Host sandbox gate | PARTIAL | `codex-swarm-v1` adversarial suite passes for `networkPolicy: none`. Scoped egress and credential injection are missing. |
| 5 | Cross-repo gate | PARTIAL | Live ACS↔Swarm parity passes locally. Not in CI; Swarm changes are uncommitted on a local branch. |
| 6 | Failure injection | PASS (local, simulated engine) | kill -9 crash windows, rate limit, remote drift, orphaned attempts. |
| 7 | No undocumented skipped/pending tests | PARTIAL | The live parity and sandbox suites skip unless their environment variables are set; they ran here, and both skips are documented. |
| 8 | Audited approval | PARTIAL | F8 consumes a bound, human approval record; the issuance flow for publication approvals is not built. |
| 9 | Disaster recovery | PASS (rehearsal) | Backup/restore drill with an audited write after restore. Not exercised on the production host. |
| 10 | Real Swarm execution | **FAIL** | Swarm's ACS handler refuses execution until isolation with egress exists. |
| 11 | Model billing reconciliation | **BLOCKED** | Unknown; never treated as zero. |
| 12 | Independent security review | **NOT DONE** | Required at F4 and F11 (threat model). |
| 13 | Operator sign-off for limited rollout | **NOT DONE** | Requires a human decision after items 1, 4, 5, 10, 11 and 12 clear. |
| 14 | Rollback rehearsal | PASS (local) | With the flag off, every mutating factory route returns 503 and no other ACS route is affected (F1 tests). Records are retained. |

## Release notes (draft, not released)

- New: `packages/ai-factory` (intent, preview, admission mapping, plan DAG), `packages/ai-factory-runtime` (dispatch, verification, draft publication, reconciliation, projection), the gateway `/api/factory/*` routes behind `ACS_FACTORY_INTAKE_ENABLED`, the `codex-swarm-v1` sandbox profile, the `CodexSwarmEngineAdapter` (`acs/v1`), and the Mission Control "AI Factory" page.
- Changed: plan acceptance registers independent-verification requirements; a nav test now counts twelve destinations.
- Codex Swarm (separate repo): `acs/v1` transport parity, out-of-band secret, fence client, `swarm-acs-serve` entry that refuses execution pending isolation.
- Rollback: unset the flag. Missions and the audit trail are retained; no data migration was added.
