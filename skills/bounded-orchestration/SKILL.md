---
name: bounded-orchestration
description: Run and audit the repository's fan-out/synthesis, adversarial, and loop-until-done patterns. Use when parallelizing eval work, adding multi-agent judging, enforcing token/time/iteration/spend caps, or deciding between hosted dynamic workflows and the headless fallback.
---

# Bounded Orchestration

Make multi-agent work prove isolation, bounded resource use, complete receipts,
and task-level correctness.

## Procedure

1. Read `STATE.md`, `docs/orchestration-patterns.md`, `harness/routing.md`,
   `harness/cost.ts`, and the Dynamic workflows row in
   `docs/platform-facts.md`.
2. Supply explicit invocation plans and positive token, wall-clock, spend, and
   loop-iteration caps. Require worst-case predicted spend to fit before the
   first provider call. Keep predicted and actual spend separate.
3. For `fanOutSynthesize`, give each worker one slice and no sibling context.
   Await every parallel worker settlement before emitting a failure receipt;
   an early rejection must not omit later sibling cost. The synthesizer must
   pass stable-ID deduplication, conflict, and coverage criteria.
4. For `adversarial`, pass only visible maker output to the critic and only the
   two visible outputs to the judge. Require the judge's `output` to be the
   corrected final task answer; keep its rationale in `justification`.
5. For `loopUntilDone`, give each verifier only task, rubric, and candidate.
   Return only structured failures to the next maker. Stop on verifier pass or
   a typed cap failure; never return an unverified last candidate as success.
6. Log every completed or failed invocation with per-call predicted/actual
   cost, token usage, exact models, measured elapsed milliseconds, and the
   failure code. Validate receipt sums before persistence. Bind a completed
   result's spend object to its spend log, recompute aggregate
   usage/models/cost, enforce spend/token/wall caps, and validate the exact role
   sequence. For a completed loop, require exactly two provider calls per
   iteration in maker/verifier order. Validate the single final receipt again
   immediately before emitting or returning success so terminal parsing cannot
   cross the wall cap after the last provider check.
7. Label deterministic fixtures, headless live calls, and hosted dynamic runs
   distinctly. A command-level availability check is not a hosted-workflow
   pass. After bounded hosted failures, record the receipts and use the cited
   headless fallback instead of silently raising caps.
8. Check final outputs against the eval rubric. A structurally completed
   orchestration is not necessarily a correct answer.
9. Before removing an orchestration worktree, inventory its branch, dirty and
   untracked files, and commits absent from `main`. Preserve intended dirty
   state in a commit, push every unique commit to a remote branch, and require
   the local branch SHA to equal the remote SHA before `git worktree remove`.
   Delete the local branch only when it is merged or its exact tip is verified
   on the remote.

## Acceptance check

```bash
npx vitest run harness/orchestration-patterns.test.ts evals/orchestration-evidence.test.ts evals/orchestration-live-evidence.test.ts evals/dynamic-workflow-evidence.test.ts
npx tsc -b tsconfig.compounding.json
jq -e '.expectedFailure == "iteration_cap" and .spendLog.failureCode == "iteration_cap" and (.spendLog.calls | length) == 4' runs/*orchestration-loop-iteration-cap.json
```

Confirm the three live traces use non-fixture exact models, retain predicted
and actual spend, and pass their task-level content assertions.

For a worktree cleanup, also require this check to succeed before removal:

```bash
test "$(git rev-parse "$WORKTREE_BRANCH")" = \
  "$(git ls-remote origin "refs/heads/$WORKTREE_BRANCH" | awk '{print $1}')"
```

## Changelog

- 2026-07-09: Created after two bounded hosted dynamic attempts exceeded their
  requested outer caps; added explicit negative-evidence and fallback rules.
- 2026-07-09: Required `Promise.allSettled`-style receipt collection after an
  early fan-out rejection could otherwise omit sibling spend.
- 2026-07-09: Added task-level output checks after valid orchestration envelopes
  exposed an underspecified worker slice and a judge that returned analysis
  instead of the corrected answer.
- 2026-07-09: Added structured critic `refute`/`concede` positions and deep
  result/spend/cap/role validation after a tamper audit and a live judge chose
  a critic that had found no material flaw.
- 2026-07-09: Added measured elapsed-time receipts and loop iteration-to-call
  reconciliation after a second independent audit found that declared wall and
  iteration caps were not yet bound to completed evidence.
- 2026-07-09: Added a final receipt cap check after a controlled-clock audit
  exposed a terminal parsing window between the last provider check and the
  completed result.
- 2026-07-10: Added the remote-SHA worktree-removal gate after the cleanup
  session found unique commits and dirty files that would have been lost by
  removing worktrees before preservation.
