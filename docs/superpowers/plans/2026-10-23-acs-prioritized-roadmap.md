# ACS prioritized roadmap (2026-10-23, verified against origin/main 2026-10-24)

Status: proposed. Not an execution plan. Ranking is preserved from the 2026-10-23 review. Statuses were corrected after
re-checking origin/main and open PRs, because an earlier pass used a stale checkout and reported items as absent.

## Architecture decision (recorded)

- React Mission Control is the newer operator console. It is merged to `main` (`apps/mission-control-web`).
- ACS gateway remains the sole authority. Approval and dispatch enforcement stay server-side.
- The React app is feature-flagged: `ACS_MC_WEB=1` enables it, `ACS_MC_WEB_DEFAULT=1` serves it at `/`
  (`apps/gateway/src/mission-control-web.ts`).
- The server-rendered console stays at `/legacy` as rollback (`apps/gateway/src/dashboard-routes.ts:247`).
- Do not start another frontend rewrite. Harden and integrate React. Retire the legacy renderer only after parity,
  security, and operational acceptance gates pass.

## Ranked roadmap with verified status

Status key: **DONE** = merged, tested, integrated and accepted for its stated outcome. **IMPL** = implementation exists, but integration, rollout or acceptance is incomplete or unverified.
**DRAFT** = open PR, not merged. **PARTIAL** = some code or docs, outcome not met. **NOT FOUND** = no matching code or doc on main.

| Rank | Deliverable | Status | Evidence |
|---|---|---|---|
| 1 | Approval inbox with "Why blocked?" | PARTIAL | Approval rails and `/#approvals` exist. No "why blocked" explanation found on main. |
| 2 | Approval-replay hardening | IMPL (merged; integration unverified) | Merged as #402, `dff50089` "harden approval replay (base-grant approver, current plan, full decision audit)". Threat model T03 in `docs/threat-model.md:145`. |
| 3 | JC path boundaries and alias parity | PARTIAL | Path-boundary matching specified in `docs/protocol/change-sets.md:292`. No alias-parity implementation found. |
| 4 | Governed run timeline | PARTIAL | Attempts and lease projections in the Mission Control work queue. No single queued/executing/stalled/verified timeline found. |
| 5 | DC scheduler visibility | IMPL (API available; UI unverified) | `apps/gateway/src/server.ts` exposes read-protected `GET /api/dc/scheduler` (active/queued snapshot); `apps/gateway/src/dc-capability-issue.test.ts` checks HTTP 200. Operator UI parity and release acceptance remain unverified. |
| 6 | Mission-scoped autonomy grants | IMPL (gateway/coder; other lanes/UI incomplete) | `apps/gateway/src/server.ts` supports work-item authority grants; `docs/runbooks/governed-coding-missions.md` documents issue, bind, verify and revoke behavior for the coder lane. Governed mode is off by default, JC/DC drivers and operator UI remain incomplete, and global admin mode remains in place. |
| 7 | Outcome Engine PR checklist | IMPL | `docs/outcome-engine.md` and ADR 0028. CLI `acs outcome accept/evaluate/show/list` (`apps/cli/src/outcome.ts`). Read-only: it never merges or comments. Integration into the merge path is incomplete. |
| 8 | Failed-mission evidence replay | IMPL (flight-record replay; operator workflow unverified) | `packages/coding-mission/src/flight-recorder.ts` implements `readMissionFlightRecord`; `packages/coding-mission/src/recovery-runtime.test.ts` exercises recovery/replay. End-user failed-mission replay UX, cross-run coverage and rollout acceptance remain unverified. |
| 9 | React Mission Control consolidation | IMPL (merged; rollout incomplete) | `apps/mission-control-web` on main, default-root flag, `/legacy` fallback. Rollout and hardening are not complete. |
| 10 | Bounded black-box recorder | DRAFT | PR #406 `feat(black-box): Agent Black Box recorder, flagged off by default` (draft, mergeable, checks green). Live integration incomplete. |

## Corrections from the 2026-10-24 check

- Items 5, 6 and 8 also have verified API/runtime implementations. They remain IMPL because UI, lane coverage or rollout acceptance is incomplete or unverified.
- Item 7 is implemented. Integration is open.
- Item 9's implementation is merged; integration, rollout and hardening are open. Legacy stays as fallback. Do not mark the outcome DONE yet.
- Item 10 is a draft PR, not merged. Live integration is open.
- Item 2's implementation is merged (#402), but integration into the approval UX is unverified. Do not mark the outcome DONE yet.
- Earlier "not found" results for items 7 and 10 came from a stale checkout. Do not reuse them.

## Merge gate (replaces any readiness score)

A change merges only when all of these hold:
- Required checks pass. Record the exact commands (`npm run typecheck`, `npm run lint`, affected suites) in the PR body.
- Zero unresolved review findings at high severity or above.
- Each authority-bearing change has a deny-path test, not only an allow-path test.
- Each claimed capability cites a file path and a passing test. Claims without evidence stay unverified.
- Roadmap status moves to DONE only after the integration gate for that item passes, not when code merges.

## Open decisions

- Item 1 and item 4: confirm "why blocked" and the governed timeline are wanted in the inbox before scoping.
- Item 5 and item 6: confirm read-only scheduler visibility ships before any grant changes.
- Legacy retirement: name the parity, security, and operational gates and who signs off.
