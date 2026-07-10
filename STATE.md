# Session state

## Objective

Build the repository's compounding-agent skeleton, routing and cost model,
fixed evaluation harness, independent maker-verifier loop, proof-oriented goal
entry points, and budget-capped orchestration patterns from the supplied goal
objective.

## Acceptance criteria

- Track the required top-level tree and ship runnable `new-session`,
  `end-session`, and `run-evals` entry points in a clean bootstrap commit.
- Test every routing class, escalation path, and predicted/actual cost receipt.
- Keep 10–20 fixed eval tasks, isolate grader context, document the results
  schema, and record two comparable baseline runs.
- Bound maker-verifier and orchestration loops by iterations, time, and tokens;
  commit the required evidence traces.
- Encode the verified goal-loop contract, three goal templates, the feature
  decision table, and the confirmed managed Outcomes integration.
- Keep platform facts live-cited in `docs/platform-facts.md`; use no
  memory-derived platform claim.
- Preserve unrelated worktree changes and satisfy every acceptance gate from
  the supplied objective before claiming completion.

## General rules

- No artifact without an acceptance check.
- No platform-feature claim without a citation in `docs/platform-facts.md` or
  an explicit `UNVERIFIED` tag.
- If blocked, document the block; do not guess or route around it silently.

## Active skills

- `ijfw-workflow` — `/home/jacen/.codex/plugins/cache/ijfw/ijfw/1.6.3/skills/ijfw-workflow/SKILL.md`
- `firecrawl-deep-research` — `/home/jacen/.agents/skills/firecrawl-deep-research/SKILL.md`
- `skill-creator` — `/home/jacen/.codex/skills/.system/skill-creator/SKILL.md`
- `verify-platform-facts` — `.codex/skills/verify-platform-facts/SKILL.md`
- `eval-baseline` — `skills/eval-baseline/SKILL.md`

## Verified facts

- `docs/platform-facts.md` exists and contains every feature family explicitly
  named in the supplied objective.
- The 2026-07-09 manual semantic review used the AEO Foundations Architect, AI
  Engineer, Agentic Search Optimizer, Backend Architect, and AI Data Remediation
  Engineer lanes. Final row counts are 11 `CONFIRMED`, 3 `CHANGED`, and 1
  `NOT FOUND`.
- The current first-party model inventory audit covers 11 callable models with
  IDs, context/output limits, and input/output MTok rates; the row evidence is
  cited in `docs/platform-facts.md`. The Mythos Preview conflict was resolved in
  favor of the lifecycle-specific retirement source and is recorded as
  `CHANGED`.
- All 29 unique external links in `docs/platform-facts.md` returned HTTP 200
  after redirects on 2026-07-09.
- Every `CONFIRMED` row has an official URL, and the sole `NOT FOUND` row has a
  fail-closed ACS fallback.
- `bash .codex/skills/verify-platform-facts/scripts/check-platform-facts.sh`
  passed.
- `git diff --check -- docs/platform-facts.md` passed.
- The repo-local `verify-platform-facts` skill passed `quick_validate.py`.
- A 2026-07-09 resume audit reloaded every active skill, rescanned the live
  worktree (including hidden and untracked repository files), and found no
  appendix or attachment. The platform-facts checker and diff check passed
  again; `quick_validate.py` also passed under `/usr/bin/python3` after the
  unavailable `python` shim returned exit 127.
- The final 2026-07-09 blocked audit searched repository content, filenames,
  and all Git history for the appendix or an attachment. It found only the
  existing limitation notices and platform-facts artifacts. The acceptance
  checker still passed, including live-link checks, and `git diff --check`
  reported no errors.
- The supplied full objective was read from the Codex attachment and reconciled
  against the live tree. The phase-1 bootstrap acceptance script passed; it
  verifies the required tree, executable session scripts, contract and state
  output, empty-`Last session` refusal, eval-stub receipt, and large-run-artifact
  ignore rule. The TypeScript scaffolds passed a no-emit type check.
- The pre-change repository baseline passed `npm run check`: 16 test files and
  183 tests passed.
- Phase 4 now has seven deterministic task classes, exact model IDs,
  two-verifier-failure and disagreement escalation, structured refusal
  fallback, three-agreement-run de-escalation, explicit Mythos availability,
  dated Sonnet pricing, and direct/routed cost estimates. Its focused routing
  and cost suite passed 24 tests.
- The additive Claude CLI provider records requested and exact models, token
  usage, stop reason, refusals, duration, and actual cost without changing the
  existing MoA `ModelCaller` port. Its six focused tests passed, and live
  structured-output probes succeeded with tools disabled and no session
  persistence.
- The fixed eval corpus contains 10 tasks across all seven routing classes and
  39 binary criteria. Corpus hash on both baselines was
  `7a1f3122f1c7aaab099595659e8c2f33f276aa788bc8e87e0ab5c73e8ae0f83c`.
- Live baseline 1 is `runs/2026-07-09-eval-baseline-1.json`: 31/39 criteria,
  score `0.7948717949`, predicted cost `$0.066500`, actual cost `$0.440955`.
- Live baseline 2 is `runs/2026-07-09-eval-baseline-2.json`: 32/39 criteria,
  score `0.8205128205`, predicted cost `$0.066500`, actual cost `$0.479861`.
  Absolute score delta is `0.0256410256`, within the documented `0.10`
  expected grader-variance bound. Both runs record Fable 5, Opus 4.8, Sonnet
  5, and dated Haiku 4.5 model IDs.
- The integrated post-eval repository gate passed `npm run check`: 23 test
  files and 225 tests passed. The `eval-baseline` skill passed validation and
  an independent forward test accepted the two-run evidence pair.
- Existing user modifications in `CLAUDE.md`, `package.json`, and
  `package-lock.json` were not changed by this session.

## Open failures

- The appendix table referenced by the objective is absent from the repository
  and was not recoverable from the current tree or the live IJFW session files.
  Exact appendix-to-table parity therefore remains unverified. The document is
  seeded from every row explicitly named in the supplied objective. Three
  consecutive live-state audits reached the same result. This remains an open
  provenance gap, but the supplied full objective now permits work on the
  explicitly named repository phases without inferring additional rows.
- The maker-verifier, goal-template/decision-table/Outcomes, and three
  orchestration-pattern acceptance gates are not yet implemented.
- Two discarded baseline attempts produced no result artifact: the first CLI
  process exited 1 after task 3 with a `$0.05` per-call cap; the second returned
  a non-success envelope at task 9 with a `$0.10` cap. The exact remote cause
  was not retained, so no stronger claim is made. The successful complete runs
  used `$0.10` and `$0.20` caps respectively.
- Baseline JSON records task IDs but does not embed the corpus content hash.
  The current linkage is the matching hash receipt above plus unchanged task
  files. Embedding the hash in future result schema revisions would make each
  run independently provenance-complete.

## Lessons learned

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

## Last session

On 2026-07-09, the session completed the clean bootstrap, deterministic routing
and cost policy, usage-aware tool-less Claude CLI adapter, 10-task fixed corpus,
independent grader boundary, full eval runner, validated `eval-baseline` skill,
and two live baselines while
preserving unrelated changes in `CLAUDE.md`, `package.json`, and
`package-lock.json`. The baselines agreed within the documented variance bound,
and the integrated 223-test gate passed. Resume at phase 6: implement
`makerVerifier(task, rubric, maxIters)`, prove fresh verifier context,
structured-only failure feedback, no-progress escalation, and commit evidence
from three eval tasks with at least one independent-verifier catch.
