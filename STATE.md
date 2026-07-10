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
- `independent-verification` — `skills/independent-verification/SKILL.md`
- `bounded-orchestration` — `skills/bounded-orchestration/SKILL.md`

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
  existing MoA `ModelCaller` port. Its seven focused tests passed, and live
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
- Phase 6 provides a reusable `makerVerifier(task, rubric, maxIters)` with
  isolated maker/verifier provider calls, structured-only retry failures,
  stable criterion-ID schemas, duplicate-failure escalation through `route()`,
  fail-closed parsing, and full model/cost/token/timing traces. Nine focused
  primitive tests and three evidence tests passed. Each evidence envelope now
  includes the eval-task SHA-256 and rubric snapshot; the validator reconciles
  criterion parity, failures, timestamps, duration, per-model usage/cost, and
  aggregate usage/cost.
- Three committed maker-verifier traces cover `audit-replay-invariant`,
  `redaction-repair`, and `work-item-lifecycle`. Their total live cost is
  `$0.1009503`; live calls used dated Haiku 4.5 and Sonnet 5. The lifecycle
  trace explicitly labels its first maker response as a seeded fixture and
  proves `selfAssessment.pass=true` while the fresh live verifier fails the
  same iteration, followed by a verified live retry.
- Phase 7 documents the official `/goal` contract, three repository templates,
  and the `/goal`/`/loop`/Stop-hook/auto/routine decision table. The Outcomes
  adapter emits the documented `user.define_outcome` event through an injected
  transport with an inline Markdown rubric and a 1-20 iteration bound.
- `runs/2026-07-09-goal-policy-action-classification.json` records a real
  tool-less non-interactive `/goal` run. It surfaced exactly `action: read` and
  `risk: low` in one turn using dated Haiku 4.5 at `$0.005086`. A same-session
  `/goal` query then returned `No goal set`; no clear command was issued, so
  under the cited platform contract the evaluator cleared the condition. The
  repository trace retains both raw CLI envelopes, platform session IDs, exact
  argv, CLI version, timestamps, workspace-status hashes, and SHA-256 receipt
  bindings; tamper tests reject fabricated sessions and changed raw envelopes.
- Phase 8 implements `fanOutSynthesize`, `adversarial`, and `loopUntilDone`
  with isolated role payloads, a dedup/conflict/coverage synthesis barrier,
  output-only adversarial judging, structured verifier failures, and hard
  token, wall-clock, iteration, and spend checks. Eleven focused pattern tests
  pass.
- Deterministic evidence covers all three orchestration patterns and records a
  deliberately non-passing loop stopped after two iterations and four calls
  with `failureCode=iteration_cap`. Separate live headless traces cover all
  three patterns against fixed eval tasks using dated Haiku 4.5. Their combined
  predicted cost is `$0.017500`; actual cost is `$0.117018`. Content checks
  require the fan-out approval result to deny execution, name `abc`/`def`,
  require new approval, and audit the block; adversarial and loop results must
  equal the two-line classifier oracle. The critic now declares `refute` or
  `concede`, and the validator forbids selecting a conceding critic.
- Claude Code `2.1.205` accepted `ultracode`, but two bounded dynamic-workflow
  attempts did not complete. The first requested `$0.30` and ended at
  `$0.390117` after attempting `Write`; the second requested `$0.50`, started
  two Agent tasks, and ended at `$1.751095`. `ANTHROPIC_API_KEY` was unset.
  `runs/2026-07-09-dynamic-workflow-attempts.json` records the failures and the
  explicit headless fallback without claiming dynamic-workflow success.
- Shared trace redaction now preserves token-accounting fields, distinguishes
  repeated references from actual cycles, extracts sensitive values from
  embedded JSON with trailing punctuation, and redacts those values from model
  prose before persistence. Five focused redaction tests and credential scans
  over the new evidence passed.
- The final integrated gate passed `npm run check`: 31 test files and 264 tests
  passed. The eval corpus hash remains
  `7a1f3122f1c7aaab099595659e8c2f33f276aa788bc8e87e0ab5c73e8ae0f83c`,
  with no diff in `evals/tasks/` or either committed baseline JSON.
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
- Two discarded baseline attempts produced no result artifact: the first CLI
  process exited 1 after task 3 with a `$0.05` per-call cap; the second returned
  a non-success envelope at task 9 with a `$0.10` cap. The exact remote cause
  was not retained, so no stronger claim is made. The successful complete runs
  used `$0.10` and `$0.20` caps respectively.
- Baseline JSON records task IDs but does not embed the corpus content hash.
  The current linkage is the matching hash receipt above plus unchanged task
  files. Embedding the hash in future result schema revisions would make each
  run independently provenance-complete.
- The hosted dynamic-workflow path is confirmed available at the command level
  but remains unverified end to end in this environment. Both bounded attempts
  terminated with `error_max_budget_usd` after reported actual cost exceeded
  the requested outer cap, and the generated Node path had no API key. The
  tested headless Claude CLI fallback is complete; a future hosted retry should
  wait for an explicit cost policy and a working workflow credential/runtime.

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
- For `/goal`, retain the initial result and query the same persisted session.
  `No goal set` after no manual clear is stronger evaluator-pass evidence than
  a maker's completion statement.

## Last session

On 2026-07-09, the session completed phases 6-8: independent maker-verifier
loops with three live-task traces and a labeled seeded fault, the cited `/goal`
and Outcomes entry points with a real same-session evaluator-clear receipt,
three budgeted orchestration patterns with deterministic cap evidence and live
headless receipts, and a validated `independent-verification` skill. Two
bounded hosted dynamic-workflow attempts failed and are preserved as negative
evidence; the documented headless fallback completed instead. Shared redaction
was hardened after live evidence exposed stable-ID, secret-echo, token-metric,
and shared-reference edge cases. `npm run check` passed 31 files and 264 tests,
the fixed corpus and baselines remained unchanged, and unrelated modifications
in `CLAUDE.md`, `package.json`, and `package-lock.json` remained unowned. Resume
pointer: start from the final phase-6-to-8 commit, re-read this file and both
active repository skills, then address only the open appendix provenance,
baseline corpus-hash embedding, or hosted-workflow runtime/cost gaps.
