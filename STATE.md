# Session state

Refreshed 2026-10-02. The July 2026 prompt-sequence ledger (Prompts 01 to 15) is archived verbatim at
`docs/history/STATE-2026-07-prompt-sequence.md`; it no longer describes the live work.

## Objective

Keep `main` buildable and the authority boundaries enforceable while concurrent sessions land autonomous-mission,
Nimble routing, and admin-mode changes. Nothing in this file is authoritative over code or `docs/`; where they
disagree, the executable behavior wins and the discrepancy gets fixed.

## Acceptance criteria

- `origin/main` has no conflict markers and `npm run typecheck` is clean before any feature work starts.
- Authority-bearing changes (execution mode, approvals, grants, Jev) go through a PR from a clean worktree off
  `origin/main`, with the gate commands recorded in the PR body.
- Jev stays advisory: the ESLint boundary in `eslint.config.js` and `tests/jev-boundary.test.ts` must pass.
- Global admin mode stays time-boxed and separately scoped until mission-scoped grants replace it
  (`docs/superpowers/plans/2026-10-02-retire-global-admin-mode.md`).

## General rules

- No artifact without an acceptance check.
- No platform-feature claim without a citation in `docs/platform-facts.md` or
  an explicit `UNVERIFIED` tag.
- If blocked, document the block; do not guess or route around it silently.
- Several sessions push `feat/*` and `recovery/*` branches at once. Fetch and ancestry-check before pushing; never
  force-push `main`; never commit with unresolved conflict markers (`git grep -nE '^(<<<<<<<|>>>>>>>)'`).

## Build sequence

Superseded by the plans under `docs/superpowers/plans/`. The old Prompt 01 to 15 table is in the archive file.

## Verified facts

As of 2026-10-02, checked in a clean worktree off `origin/main` (`cdb1f2a`):

- Workspace: 14 apps and 31 packages (npm workspaces, no Turborepo/Nx). `npm run lint` is clean.
- `npm audit --audit-level=high` reports 0 high or critical findings and 7 moderate.
- Execution mode: `strict` or `admin` in one `execution_mode_state` row. Admin needs `acs:execution-mode:admin`,
  an explicit operator action, and a reason. Admin is sticky by default and stays enabled until an operator
  explicitly disables it; a bounded elevation remains available via `adminModeTtlMs`. See
  `docs/protocol/execution-mode.md`.
- Mission-scoped Autonomous Authority Grants exist for the Desktop Commander change-set path (migration 047);
  Jace Commander and ordinary gated tools still use the global admin row.
- Jev integration is advisory-only per ADR 0020. The deployed runtime is Noul-only, so trace analysis that needs
  Choice or Score degrades with INCOMPATIBLE_MODEL.
- Migration numbering is contended: two `039_*` files exist and open work adds more. Coordinate before adding one.

## Open failures

- Open PR #245 removes the rule that `privileged_exec` stays human-only under admin mode. Undecided.
- Open PR #235 duplicates the admin-mode authority fix; superseded by the scope-split PR.
- 20 stashes and about 60 worktrees (many dirty or unmerged `recovery/*`) predate this refresh and have not been
  triaged individually.
- `apps/gateway/src/server.ts` is about 5,000 lines and the main source of merge conflicts.
- Mission Control renders the same markup on the server and again as client-side strings
  (`apps/control-ui/src/work-item-controls.ts` and similar), so the two can drift.
- The full `npm run check` gate was not run during this refresh.

## Lessons learned

- Re-check the controlling build plan before inheriting any `STATE.md` claim
  that a seed appendix is absent. A source artifact can appear between sessions,
  and a structural/link checker will miss the stale provenance statement unless
  it has a negative appendix-presence test. This rule and its mutation check are
  now encoded in the active `verify-platform-facts` skill.
- Use the official `llms.txt` indexes plus direct Markdown pages for exhaustive
  term searches and repeatable negative-evidence checks.
- Resolve documentation drift by assigning authority per fact type: current
  reference for behavior, lifecycle for retirement, pricing for rates, and dated
  news for availability chronology.
- Treat external trigger adapters as ACS authority-bearing entry points: bind a
  canonical actor, reject payload-supplied identity, use a dedicated action,
  preserve exact-action approvals, and keep execution behind the lease and
  sandbox boundary.
- A live-link check proves reachability only; semantic row verification remains
  mandatory.
- Repeating a repository scan cannot substitute for a controlling source
  artifact. Preserve the verified document, disclose the dependency, and stop
  after the repeated blocker threshold instead of inferring unseen rows. This
  rule is already encoded in the active `verify-platform-facts` skill.
- Model-price prediction covers task-estimated base tokens; actual Claude CLI
  spend also includes its execution context and internal calls. Always print
  and retain both values instead of presenting the estimate as a billing
  receipt.
- Constrain stable rubric IDs in the response JSON schema. Prompt wording alone
  allowed live verifiers to return descriptive labels, which correctly failed
  parsing but prevented otherwise usable evidence.
- Redact explicit sensitive values from model prose before persistence, but do
  not treat token-accounting metrics as credentials. Traverse ancestor paths
  for cycle detection so repeated object references do not become false
  `[circular]` sentinels. This procedure is recorded in the active
  `independent-verification` skill and its changelog.
- A platform command being available does not prove a bounded workflow can
  complete in the current runtime. Record failed attempts and receipts, then
  take the documented fallback instead of repeatedly increasing caps.
- A structurally completed orchestration is not automatically a passed eval.
  Add content-level acceptance checks against the task rubric; they caught an
  underspecified fan-out slice and a judge that returned analysis instead of a
  corrected final answer.
- In parallel fan-out failure paths, await every worker settlement before
  emitting the failed spend event. Otherwise a fast rejection can hide later
  sibling receipts. This rule is recorded in the active
  `bounded-orchestration` skill and its changelog.
- Evidence validators must bind normalized projections back to source receipts:
  raw-envelope hashes for external CLI state, task hashes and rubric snapshots
  for eval traces, and deep equality plus aggregate/cap/role recomputation for
  orchestration spend logs. Internal field agreement alone does not establish
  provenance.
- Receipt validation must also bind semantic inputs and time/loop budgets:
  reread the hashed source task, require exact rubric equality, reconcile model
  durations with enclosing timestamps, record measured orchestration elapsed
  time, and derive completed loop call counts from iteration count. Otherwise a
  coherent but impossible receipt can remain internally consistent.
- A provider-level post-call cap check does not cover terminal response parsing.
  Compute one final receipt, enforce every cap against it, and only then emit or
  return success; otherwise the runtime and its persisted evidence can disagree.
- For `/goal`, retain the initial result and query the same persisted session.
  `No goal set` after no manual clear is stronger evaluator-pass evidence than
  a maker's completion statement.
- Before removing a worktree, inventory dirty and untracked files plus commits
  absent from `main`, preserve intended state on a branch, and require the
  local branch SHA to equal the remote SHA. Remove the worktree only after that
  proof, and delete its local branch only after merge or remote preservation.
  This 2026-07-10 lesson is encoded and testable in
  `skills/bounded-orchestration/SKILL.md`.

## Last session

On 2026-10-02 a review of Jev authority, the monorepo, admin ("YOLO") mode, Mission Control and the OAuth paths
led to: a dedicated admin scope, required reason, TTL and confirmation dialog (PR #251); an ESLint boundary that
keeps the Jev adapter out of authority code (PR #252); a plan to retire global admin mode in favour of
mission-scoped grants (PR #253); and removal of 102 provably merged local branches plus 3 clean worktrees. This file,
`AGENTS.md` and `INDEPENDENT_REVIEW.md` were refreshed. Resume pointer: merge or revise #251 to #253, decide #245,
then split `server.ts` and remove the duplicated UI rendering as separate PRs.
