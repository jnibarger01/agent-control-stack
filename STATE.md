# Session state

## Objective

Close out the completed repository reconciliation by proving local and GitHub
parity, recording preservation and cleanup evidence, retaining unresolved audit
failures, and leaving a reproducible session handoff.

## Acceptance criteria

- Inspect `main` and all four named cleanup paths; record branch, dirty or
  untracked files, commits absent from `main`, and preservation status.
- Preserve every uncommitted or unmerged change before cleanup.
- Reconcile intended changes into `main` while excluding generated or
  superseded work.
- Run the relevant tests, type checks, builds, and repository validations.
- Commit legitimate remaining changes with clear messages.
- Fetch and reconcile the remote without force-pushing or rewriting shared
  history.
- Push `main` and every branch still needed to preserve unique work.
- Prove local `main` equals GitHub `main`, the pushed commit exists remotely,
  and the working tree is clean.
- Remove the four named paths only after preservation and remote verification;
  use Git worktree removal for registered worktrees.
- Prune stale worktree metadata.
- Delete local worktree branches only after merge or exact remote-SHA proof.
- Finish with a concrete commit, test, branch, SHA, worktree, and risk receipt.

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
  primitive tests and four evidence tests passed. Each evidence envelope now
  includes the eval-task SHA-256 and rubric snapshot; the validator rereads and
  parses the source task, recomputes its raw SHA-256, requires exact task ID and
  rubric equality, reconciles criterion failures and receipt aggregates, and
  checks each reported duration against its enclosing wall-clock timestamps.
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
  bindings; tamper tests reject inconsistent session fabrication and changed
  raw envelopes.
- Phase 8 implements `fanOutSynthesize`, `adversarial`, and `loopUntilDone`
  with isolated role payloads, a dedup/conflict/coverage synthesis barrier,
  output-only adversarial judging, structured verifier failures, and hard
  token, wall-clock, iteration, and spend checks. Twelve focused pattern tests
  pass. Each spend receipt includes measured elapsed milliseconds; evidence
  validation enforces the wall-clock cap and binds completed loop iterations to
  exactly one maker and one verifier call per iteration. The runtime rechecks
  one final receipt immediately before returning success, closing the terminal
  parsing window after the last provider call.
- Deterministic evidence covers all three orchestration patterns and records a
  deliberately non-passing loop stopped after two iterations and four calls
  with `failureCode=iteration_cap`. Separate live headless traces cover all
  three patterns against fixed eval tasks using dated Haiku 4.5. Their combined
  predicted cost is `$0.017500`; actual cost is `$0.111717`. Content checks
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
- The final integrated gate passed `npm run check`: 31 test files and 267 tests
  passed. The eval corpus hash remains
  `7a1f3122f1c7aaab099595659e8c2f33f276aa788bc8e87e0ab5c73e8ae0f83c`,
  with no diff in `evals/tasks/` or either committed baseline JSON.
- Existing user modifications in `CLAUDE.md`, `package.json`, and
  `package-lock.json` were not changed by this session.
- The 2026-07-10 worktree cleanup inspected `main` plus
  `hermes/agentos-contracts-slice`, `hermes/lease-bound-results`, and
  `hermes/mcp-transport`. Their dirty files and unique commits were committed
  and pushed before removal. The non-Git Phase-0 artifact path was classified
  separately before deletion.
- AgentOS contract work was preserved at
  `6633abc552ffae7fe17163948ebd2fd8702b201f` and integrated into `main` as
  `e38a004c03e5f8881a9499c8c8cd542b9e7146ca`. Lease-result work is preserved
  at `45c7830388966012d2fd8aadb7d39b5dd1778c88`; the older MCP hardening slice
  is preserved at `3ef51925b84ef01a93744dc3ef8cb6c7e425e8b5` and was not merged.
- Preexisting `CLAUDE.md`, `package.json`, and `package-lock.json` changes were
  preserved on `preserve/main-working-tree-20260710`, whose verified remote tip
  is `3eb8b6f8a5b2a8b5d6ab5d62813a97ac5e40b6e8`.
- Before the documentation-only closeout, local `main`, `origin/main`, and the
  GitHub API all resolved to
  `e38a004c03e5f8881a9499c8c8cd542b9e7146ca`; divergence was `0 0`, the tree
  was clean, and GitHub contained all five preservation/archive refs.
- The integrated `main` gate passed `npm run check` with 33 test files and 276
  tests, the AgentOS Node suite passed 48 tests, and
  `scripts/bootstrap-acceptance.test.sh` passed. The AgentOS and lease
  worktrees also passed their focused tests and TypeScript builds before
  preservation.
- The registered worktrees at
  `/home/jacen/agent-control-stack-agentos-contracts-slice`,
  `/home/jacen/agent-control-stack-lease-results`, and
  `/home/jacen/agent-control-stack-mcp-transport` were removed without force
  after their remote SHA checks. Worktree metadata was pruned; unrelated
  preexisting worktrees were left untouched.
- `/home/jacen/agent-control-stack-phase0-artifacts-20260708-0212` was not a
  Git worktree. Its authored AgentOS source, idea brief, and reviews were pushed
  to `archive/agentos-phase0-20260708` at
  `eb58b8d301b9642c49c88364cfce07b6e35be6ef`; the generated ISO, chroot,
  package caches, boot files, and duplicate documentation archive were then
  deleted.
- The complete cleanup acceptance receipt and artifact inventory are recorded
  in `docs/worktree-cleanup-closeout-2026-07-10.md`.

## Open failures

- **Prompt 11 — Stage: `OPEN_FAILURE`**
  - Status: `UNRESOLVED`.
  - Failure: the required independent cross-audit produced no independent
    verdict. The MCP attempt timed out after 30 seconds; the CLI retry exited 3
    because the Codex authentication token was stale and Gemini failed under
    `TERM=dumb`.
  - Evidence: IJFW reported that neither auditor contributed and that lineage
    diversity was reduced. “No findings” is therefore not a PASS.
  - Resume: refresh Codex authentication, run Gemini under a compatible
    terminal, and rerun the cross-audit against the final closeout range.
- The preserved `hermes/mcp-transport` branch remains test-red at
  `3ef51925b84ef01a93744dc3ef8cb6c7e425e8b5`. Its focused run passed 21 tests
  and failed these two audit-chain tests:
  `packages/eval-harness/src/replay.test.ts > deterministic replay > replays approved work through SQLite events`
  and
  `packages/work-items/src/state-machine.test.ts > work item state machine > writes a verifiable audit hash chain`.
  The branch is preserved remotely and was not merged into `main`.
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
- The `/goal` evidence is internally bound by raw-envelope and workspace-state
  SHA-256 hashes and is corroborated on this machine by the captured CLI
  transcript, but those hashes are self-contained rather than externally
  signed. A future clone can detect partial tampering but cannot independently
  authenticate the receipts as platform-originated evidence.

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

On 2026-07-10, the Fable 5 closeout verified the completed worktree cleanup,
recorded every preservation and archive ref, retained the two MCP audit-chain
test failures, archived the authored Phase-0 source before deleting generated
ISO state, and added a remote-SHA cleanup rule to the bounded-orchestration
skill. The main repository passed its build, 276-test Vitest gate, 48 AgentOS
Node tests, and bootstrap acceptance check. Independent cross-audit coverage
remains open at Prompt 11 because Codex authentication was stale and Gemini
failed under `TERM=dumb`. Resume pointer: start from `origin/main`, read
`docs/worktree-cleanup-closeout-2026-07-10.md`, then resolve Prompt 11 by
restoring both auditors and rerunning the audit; do not reopen the completed
Git reconciliation or remove the unrelated worktrees.
