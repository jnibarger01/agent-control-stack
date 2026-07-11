# Self-Improving Fable 5 Agent System — Build Prompts v2

15 sequential prompts + a session contract. One prompt per session. Each session produces a committed artifact with an acceptance check — not an essay.

## What changed from v1 and why

1. **Every prompt now has Deliverables + Acceptance.** v1 verbs were "explain / provide / include," which produce essays that evaporate. v2 verbs produce files, tests, and traces. Ironic flaw in v1: a library about verifiers had no verifiable outputs.
2. **Memory moved from session 11 to session 2.** v1 says "track progress in STATE.md" but doesn't create STATE.md until step 11. v2 bootstraps the repo + STATE.md immediately so all 13 remaining sessions compound.
3. **A grounding step replaces the two "explain the model" prompts.** v1 prompts 01–02 ask the model to recite capabilities, pricing, and "evidence from Anthropic experiments" from memory — that's a confabulation generator. v2's Prompt 01 builds a fact sheet verified against live docs, and every later prompt cites it instead of guessing. (The appendix pre-seeds it with what was verifiable as of 2026-07-09.)
4. **A new eval-set prompt (05).** v1 builds verifiers but never builds the fixed task set that makes "self-improving" measurable. Without a baseline, "improved" is vibes.
5. **Feature names corrected against verified mechanics.** `/goal`, dynamic workflows, and routines are real and documented — but v1 misses their actual constraints (e.g., the /goal evaluator only reads the transcript; dynamic workflows are token-heavy by design). "Outcomes" and "CMA" appear only in secondary sources — v2 treats them as verify-or-substitute, not facts.
6. **Prompt 14 reframed from "route around safety classifiers" to "implement the official refusal/fallback contract."** Fable 5 returns `stop_reason: "refusal"` with the classifier identified, and Anthropic ships supported fallback mechanisms. Use those, log everything, never rephrase-loop. An unattended system that auto-rewrites around refusals is a liability, not a feature.

## How to run

- One prompt per session. Prepend Prompt 00 to every session from session 2 onward.
- Do not advance while an acceptance check is red — file it through the Prompt 11 pipeline instead.
- Fable 5 for the orchestrating session; let the routing policy (Prompt 04) govern everything it spawns.

---

## Prompt -1 — Sequential session dispatcher

This document is an executable build sequence, not passive reference material.

At the beginning of every build session:

1. Read this document in full.
2. Read `STATE.md` if it exists.
3. Inspect the `Build sequence` table in `STATE.md`.
4. Verify prior PASS entries against their recorded acceptance evidence.
5. Select the earliest Prompt 01–15 that is not proven PASS.
6. Execute exactly that numbered prompt in the current session.
7. Apply Prompt 00 to the selected prompt.
8. Do not advance to another numbered prompt during the same session.

If `STATE.md` does not yet exist:

* Prompt 01 may run without it.
* Prompt 02 must create it.
* After creating it, Prompt 02 must populate the Build sequence table, record Prompt 01’s verified status, and complete the remaining Prompt 00 closeout requirements.

Required `STATE.md` Build sequence schema:

| Prompt | Status | Deliverables | Acceptance evidence | Commit | Resume pointer |
| ------ | ------ | ------------ | ------------------- | ------ | -------------- |

Allowed statuses:

* `NOT_STARTED`
* `IN_PROGRESS`
* `BLOCKED`
* `PASS`

A file’s existence is not acceptance evidence. A prompt becomes PASS only after its stated acceptance commands or observable checks have been executed successfully and recorded.

When acceptance is red:

* Record the failure using the Prompt 11 stage model.
* Keep the current prompt `IN_PROGRESS` or `BLOCKED`.
* Do not execute a later prompt.
* Do not weaken, reinterpret, or silently skip the failed criterion.

Prompt 02 must preserve `docs/platform-facts.md` if Prompt 01 already created it. Scaffold missing paths only; do not overwrite prior verified artifacts.

Every session ends with:

* Updated `STATE.md`
* Exact artifact list
* Acceptance evidence
* Relevant run traces
* A scoped commit when appropriate
* A resume pointer naming the same blocked prompt or the next numbered prompt


## Prompt 00 — Session contract (prepend to every session)

```
Session contract — follow before anything else:
1. Read STATE.md in full. Load every skill file listed under "Active skills."
2. Restate this session's objective in one sentence and list the acceptance
   criteria you will be graded against.
3. Work only inside this repo unless the task says otherwise.

Before ending the session:
4. Update STATE.md: Verified facts, Open failures, Lessons learned,
   Last session (one paragraph, with a resume pointer).
5. If a lesson generalizes beyond this session, update or create the
   relevant skill file and log the change in its changelog.
6. List every artifact created or changed, with paths.

Hard rules: no artifact without an acceptance check; no platform-feature
claim without a citation in docs/platform-facts.md or an UNVERIFIED tag;
if blocked, document the block — do not guess or route around it silently.
```

*Fixes the v1 gap where read-at-start / write-at-end discipline didn't exist until step 11.*

---

## Prompt 01 — Grounding: verified platform fact sheet

```
Objective: produce docs/platform-facts.md — the single source of truth for
platform claims. Every later build step cites this file instead of memory.

Instructions:
1. Seed the file from the appendix table in this document, then re-verify
   each row against live official sources (docs.claude.com,
   code.claude.com/docs, claude.com/blog, anthropic.com/news). Record per
   row: CONFIRMED (with URL + date), CHANGED (correct current name/spec),
   or NOT FOUND.
2. Rows that must be current: Fable 5 specs/pricing/availability and its
   refusal contract; the full current model lineup with IDs and per-MTok
   pricing (do not assume Sonnet 4.6 is still current); /goal, /loop, Stop
   hooks, auto mode; dynamic workflows (triggers, availability, cost
   caveats); routines (triggers, environment, connector/env-var access);
   any rubric-graded "Outcomes"-style feature; any "CMA"/managed-agents
   product and how access works.
3. Anything NOT FOUND in official docs gets an explicit fallback plan:
   the manual pattern this repo will build instead.
4. Zero claims from memory. Every CONFIRMED row has a URL.

Deliverable: docs/platform-facts.md (table: feature | status | spec |
source or fallback plan | verified date).
Acceptance: no UNVERIFIED item is phrased as fact anywhere in the file;
the file states its own re-verification cadence (30 days).
```

*Replaces v1 prompts 01–02. Reciting pricing and "Anthropic experiment evidence" from model memory is how fabricated citations enter your system on day one.*

---

## Prompt 02 — Bootstrap: repo scaffold + memory

```
Objective: create the skeleton every later session depends on.

Instructions:
1. Scaffold and commit:
   docs/        (platform-facts.md, architecture.md, sop.md)
   harness/     (orchestration code, routing)
   evals/       (tasks/, graders, runner)
   skills/      (compounding skill files + _templates/)
   runs/        (session and eval logs; gitignore large artifacts)
   STATE.md
2. STATE.md sections: Verified facts, General rules, Open failures,
   Lessons learned, Active skills, Last session. Seed General rules with
   the three hard rules from the session contract.
3. Scripts: new-session (prints contract + STATE.md), end-session
   (prompts for STATE update, prunes worktrees), run-evals (stub for now).

Deliverables: the tree above in git; scripts runnable.
Acceptance: `new-session` prints STATE.md and the contract; one clean
bootstrap commit; end-session refuses to finish if Last session is empty.
```

*v1 step 11, moved to where it belongs. Also where "no trace, no write" becomes enforceable rather than aspirational — end-session is the hook.*

---

## Prompt 03 — Architecture doc

```
Objective: docs/architecture.md — the 4-layer compound stack this repo
implements, with every box mapped to a real path.

Instructions: using docs/platform-facts.md as the only source of platform
claims, define:
  L1 Primitives      — models (per routing policy), tools, worktrees
  L2 Orchestration   — /goal loops, dynamic workflows, routines
                       (use verified names; UNVERIFIED features get their
                       documented manual substitute)
  L3 Memory          — STATE.md, skills/, runs/
  L4 Self-improvement— evals, independent verifiers, distillation
Include: one ASCII diagram of the loop (produce → verify → log → distill
→ reuse), build order with dependencies, and per layer the repo artifact
that implements it plus the prompt number that builds it.

Deliverable: docs/architecture.md.
Acceptance: every diagram box maps to a concrete path; zero feature names
absent from platform-facts.md; a reviewer can trace any arrow to code or
a file.
```

---

## Prompt 04 — Routing policy + cost model

```
Objective: harness/routing.md and a tested route() function.

Instructions:
1. Routing table by task class, using the CURRENT lineup from
   platform-facts.md (pull live model IDs and per-MTok pricing; cite URL
   + date). Default shape: Fable 5 = orchestration/planning and refusal-
   sensitive frontier work; strongest non-classifier model = hard-subtask
   fallback; mid-tier = bulk workers; cheapest = graders/classifiers.
   At Fable 5's premium pricing, "Fable for everything" is the failure
   mode — routing down is the cost lever.
2. Escalation triggers: 2 consecutive verifier failures on a task; grader
   disagreement; refusal fallback (see Prompt 14). De-escalation: grader
   agreement ≥ N runs on a task class.
3. Implement route(taskClass, attempt, lastFailure) → model ID.
4. Cost model: est. tokens per task class × live prices, so run-evals
   prints a predicted cost before executing.

Deliverables: harness/routing.md, routing code + unit tests.
Acceptance: tests cover every task class and every escalation path; a
full eval run prints predicted vs. actual cost.
```

*v1 hardcoded a model list that is already going stale. Route by role and read the lineup at runtime.*

---

## Prompt 05 — Eval set + graders (new in v2)

```
Objective: the fixed task set that makes "self-improving" a number.

Instructions:
1. evals/tasks/: 10–20 tasks representative of this system's real
   workload. Each task file: input, context, rubric of 3–7 binary
   criteria, and an oracle/reference where one exists.
2. evals/grade: per task, a grader call (cheap model per routing policy)
   that receives ONLY the task, rubric, and candidate output — never the
   maker's reasoning or self-assessment — returning pass/fail per
   criterion + one-line justification.
3. run-evals: executes all tasks, writes runs/<date>-eval.json with
   per-task scores, token cost, and exact model versions used.
4. Run the baseline twice; record both in STATE.md → Verified facts.

Acceptance: two consecutive baseline runs agree within expected grader
variance (document the variance); results schema documented in evals/.
From here on, "improved" means this score rose at equal-or-lower cost.
```

*Without this, every later "the system got better" claim is unfalsifiable.*

---

## Prompt 06 — Maker–verifier primitive

```
Objective: makerVerifier(task, rubric, maxIters) as a reusable harness
primitive.

Instructions:
1. Maker produces in its own context. Verifier runs in a FRESH context:
   it sees the task, rubric, and output — no maker chain-of-thought, no
   maker self-assessment. Optionally a different model per routing policy.
2. On fail, the maker receives ONLY the structured failure list
   ({criterion, expected, observed}), not the verifier's prose.
3. Loop guards: maxIters; no-progress detection (identical failure set
   twice → escalate per routing); full per-iteration trace to runs/.
4. docs/ note on why independent verification beats self-critique —
   state it as design rationale unless you can cite a linkable source.
   Two named failure modes it targets: agentic laziness (declaring done
   early) and self-preferential bias (approving your own work).

Acceptance: on 3 eval tasks, at least one trace shows the independent
verifier catching an error that maker self-critique passed. Commit the
trace as evidence.
```

*Your Hermes-reviews / Forge-implements / adjudicate methodology, encoded as a function instead of a habit.*

---

## Prompt 07 — Goal loops with /goal

```
Objective: loop-until-verified entry points, using the real /goal
mechanics from platform-facts.md.

Instructions:
1. Confirm the /goal contract from official docs and encode it in
   docs/: one goal per session; condition ≤ 4,000 chars; a fast evaluator
   model checks the condition after each turn; the evaluator ONLY reads
   what has surfaced in the transcript — it runs nothing itself. So every
   goal condition must force proof into the transcript ("npm test exits 0
   and the output is shown"), and /goal requires the workspace trust
   dialog / hooks enabled.
2. Write 3 goal templates for this repo, each with: one measurable end
   state, a stated check (how Claude proves it in-transcript), and
   must-not-change constraints. Example shape:
   /goal run-evals completes with score ≥ <baseline>, the JSON summary is
   printed, STATE.md Last session is updated, and no file under evals/
   tasks/ is modified.
3. Produce a decision table from the docs: /goal vs /loop vs Stop hook
   vs auto mode vs routine — next-turn trigger, stop condition, when to
   use each.
4. For long-running rubric-graded work: if a rubric-based "Outcomes"-
   style feature is CONFIRMED in platform-facts.md, wire it; otherwise
   implement the equivalent as /goal + a grader whose verdict prints to
   the transcript.

Acceptance: one template executed end-to-end on an eval task; the loop
exits on the evaluator's pass, not on the maker declaring success.
```

*v1's biggest factual miss: the /goal evaluator can't run your tests — your condition has to make Claude surface the evidence.*

---

## Prompt 08 — Dynamic workflow patterns

```
Objective: three reusable orchestration patterns, run as dynamic
workflows where available.

Instructions:
1. Per platform-facts.md, trigger dynamic workflows the supported way
   (ask Claude to create a workflow, or the ultracode effort setting) —
   Claude writes a JS harness that fans work across parallel subagents
   with isolated contexts. Where unavailable, fall back to Agent SDK /
   headless `claude -p` orchestration with the same shape.
2. Implement and document:
   a. fanOutSynthesize(subtasks[]) — one agent per slice, isolated
      context, synthesizer with a dedup/conflict rubric as the barrier.
   b. adversarial(task) — maker vs. refuting critic vs. judge; judge
      sees both outputs, neither's reasoning.
   c. loopUntilDone(task) — maker–verifier loop inside the workflow with
      hard budget caps (tokens, wall-clock, iterations).
3. Per pattern: when to use it, its failure mode (synthesizer bias;
   critic nitpicking; runaway loop), and the guard that mitigates it.
4. Cost discipline: workflows are token-heavy by design — every invocation
   logs predicted vs. actual spend to runs/, and first runs are scoped
   small.

Acceptance: each pattern runs against ≥1 eval task; a deliberately
unbounded loop is demonstrably halted by its budget cap (trace committed).
```

---

## Prompt 09 — Worktree isolation

```
Objective: collision-free parallelism for anything not managed by a
dynamic workflow.

Instructions:
1. Scripts for the worktree lifecycle: create wt/maker-<id>, wt/exp-<id>;
   run agents inside them; merge or discard via reviewed diff; prune.
2. Conventions: verifier reads the maker's worktree read-only;
   experiments never share a worktree; main is merge-only.
3. Document the split: dynamic workflows manage their own subagent
   isolation — these conventions govern hand-run maker/verifier sessions
   and parallel experiments you drive yourself. Note any native Claude
   Code worktree/sub-agent flags per platform-facts.md.
4. Wire cleanup into end-session.

Acceptance: two parallel maker runs touching the same file produce zero
conflicts on main; `git worktree list` is clean after end-session.
```

---

## Prompt 10 — Routines: unattended cloud runs

```
Objective: the system runs and learns with the laptop closed.

Instructions:
1. Per platform-facts.md, set up cloud routines (claude.ai/code/routines
   or current equivalent) against this repo, with required connectors and
   env vars. If routines are unavailable for this account/tier, fall back
   to GitHub Actions or cron invoking the harness headless
   (claude -p --allowedTools, hard timeout) — same job contract.
2. Three jobs:
   a. Nightly eval — run-evals, write runs/, append a one-line delta
      summary to STATE.md.
   b. Event-triggered — PR opened or CI failure → scoped goal-loop task.
   c. Weekly distillation — the Prompt 12 job.
3. Contract for every unattended run: writes a run log; appends to
   STATE.md; NEVER merges to main without a passing independent verifier;
   on failure or refusal, alerts (issue/Telegram/Slack) instead of
   silently retrying.
4. Start read-only for the first several runs before granting write
   permissions.

Acceptance: one nightly job has executed unattended and its summary line
is in STATE.md; a forced failure produced an alert, not a retry loop.
```

---

## Prompt 11 — Failure → rule pipeline

```
Objective: failures compound into rules instead of recurring.

Instructions: encode the five-stage progression as
skills/_templates/failure.md and enforce it via the session contract:
  1. Fail & document — exact error, context, hypothesis
     (STATE.md → Open failures, timestamped)
  2. Investigate — minimal repro + root cause
  3. Verify — fix confirmed by re-running the failing case AND run-evals
     (no regression)
  4. Distill — one general rule in testable form:
     "when X, do Y, because Z"
  5. Consult — rule moved into the relevant skill file; the Open failure
     closes with a pointer to it
Enforcement: end-session refuses to close a session holding an Open
failure with no stage marker.

Acceptance: one real failure from this build walked through all five
stages; the distilled rule lives in a skill file and STATE.md links to it.
```

---

## Prompt 12 — Compounding skills

```
Objective: skills/ as long-term memory that beats fresh derivation.

Instructions:
1. Skill template: scope, verified rules (each carrying the failure that
   produced it + date), anti-patterns, open questions, changelog.
2. Weekly distillation job (wired in Prompt 10): scan runs/ and STATE.md
   lessons → propose skill diffs → an independent verifier (or you)
   approves → commit. Proposals without a source trace are rejected.
3. Retrieval rule in the session contract: any task touching a domain
   with a skill file MUST load it, and the session log names what loaded.
4. Pruning: rules unreferenced for 3 distillation cycles get flagged.
   Uncurated memory rots into noise.
5. Decide and document placement: repo skills/ (project memory) vs.
   ~/.claude/skills/ (cross-project) — and what belongs where.

Acceptance: one task demonstrably faster or cheaper with the skill loaded
vs. a fresh session — compare the two traces and commit the comparison.
```

---

## Prompt 13 — Vision self-verification

```
Objective: close the loop on visual outputs.

Instructions:
1. Pipeline: maker produces UI/render → headless screenshot (Playwright
   or equivalent) → verifier in a fresh context receives the screenshot,
   the goal, design tokens, and the prior-state screenshot.
2. Verifier returns a structured diff — {element, expected, observed,
   severity} — never prose.
3. Wire it as a grader option: for /goal use, the verifier's PASS/FAIL
   verdict must print to the transcript so the goal evaluator can see it.
4. Store screenshot pairs in runs/ for regression comparison.

Acceptance: seed one deliberate visual defect; the loop detects and fixes
it with zero human input, and the diff trace is committed.
```

---

## Prompt 14 — Refusal & fallback handling

```
Objective: unattended runs degrade gracefully when Fable 5's safety
classifiers decline a request — using the official contract, never
fighting it.

Instructions:
1. Implement detection per platform-facts.md: Fable 5 returns
   stop_reason "refusal" as a successful response and identifies which
   classifier declined. Classify every failed run as
   {tool error | budget cap | refusal} — they get different handling.
2. Fallback, the supported way: server-side fallbacks parameter (beta)
   or client-side SDK middleware to retry on another Claude model, with
   fallback credit covering the cache-switch cost. Policy: ONE fallback
   attempt, logged with the classifier ID and task hash — never a
   rephrase loop, never silent.
3. Unattended runs: a refusal that also fails on fallback halts that
   branch, files an Open failure, and alerts a human with full context.
4. Distill observed refusal patterns for this system into a skill file
   so planners stop generating task shapes that predictably trip
   classifiers — avoidance by task design, not by wording games.

Acceptance: a simulated refusal produces exactly one logged fallback,
then a halt + alert + STATE entry; the trace shows zero rephrase
attempts.
```

*Reframed from v1. The fallback path is an official, billed-for-fairly API mechanism — implement that contract; don't build a classifier-evasion loop.*

---

## Prompt 15 — Capstone audit + operating SOP

```
Objective: verify the whole stack, then set the cadence that keeps it
compounding.

Instructions:
1. Audit against docs/architecture.md: re-run every layer's acceptance
   check and record pass/fail in runs/audit-<date>.md. Explicitly
   confirm: platform-facts.md verified <30 days ago; routing tests
   green; eval delta vs. baseline reported with cost; worktrees clean;
   routines alive (last-run timestamps); ≥1 skill with ≥3 verified
   rules; refusal drill passed.
2. Every red item goes through the Prompt 11 pipeline — the audit files
   failures, it doesn't hand-wave them.
3. docs/sop.md, one page:
   Daily — read STATE, review overnight run, triage alerts.
   Weekly — approve distillation diffs, prune skills, re-baseline evals.
   Monthly — re-verify platform-facts.md, cost review, routing
   recalibration.

Acceptance: audit file shows every layer green or filed; SOP fits on one
page and names who/what executes each item.
```

---

## v1 → v2 mapping

| v1 | v2 | Change |
|---|---|---|
| 01 Capabilities essay | 01 | Merged with 02 → verified fact sheet with URLs |
| 02 Self-improving vs self-learning | 01 | Folded into grounding doc |
| 03 Compound stack | 03 | Every box must map to a repo path |
| 04 Routing matrix | 04 | Live lineup/pricing + tested route() + cost model |
| 05 /goal vs Outcomes | 07 | Real /goal mechanics (transcript-only evaluator, 4k-char condition); "Outcomes" verify-or-substitute |
| 06 Verifier | 06 | Structured-failure-only feedback, loop guards, evidence trace |
| 07 Dynamic Workflows | 08 | Verified triggers (ask / ultracode), budget caps, cost logging |
| 08 Worktrees | 09 | Split manual conventions vs. workflow-native isolation |
| 09 Routines | 10 | Real setup path + unattended-run contract + read-only first |
| 10 Memory progression | 11 | Enforced via end-session, not honor system |
| 11 STATE.md | 02 | Moved to session 2 |
| 12 Skills | 12 | Distillation job + retrieval rule + pruning |
| 13 Vision | 13 | Structured diff + /goal-visible verdict |
| 14 Safety fallbacks | 14 | Official refusal/fallback contract; no rephrase loops |
| 15 Capstone | 15 | Audit re-runs acceptance checks; SOP with owners |
| — | 00 | New: session contract |
| — | 05 | New: eval set + graders (the missing measuring stick) |

## Appendix — feature status as of 2026-07-09 (seed for Prompt 01)

| Feature | Status | Notes |
|---|---|---|
| Fable 5 | Confirmed | $10 in / $50 out per MTok; 1M context; 128k output; GA on Claude API, Bedrock, Vertex, Foundry; 30-day retention, no ZDR. Consumer-plan access has been in flux — re-check. Source: platform.claude.com docs + anthropic.com/news |
| Fable 5 refusal contract | Confirmed | stop_reason "refusal" on HTTP 200, classifier identified; server-side `fallbacks` (beta), SDK middleware, or manual retry; fallback credit; refusals before output aren't billed |
| /goal | Confirmed | Claude Code ≥ v2.1.139; fast-model evaluator after each turn; reads transcript only; ≤4,000-char condition; one per session; needs trust dialog/hooks. Source: code.claude.com/docs/en/goal |
| /loop, Stop hooks, auto mode | Confirmed | Interval re-run / custom turn evaluation / unattended tool approval — decision table in same docs |
| Dynamic workflows | Confirmed | GA; Claude writes a JS harness orchestrating parallel subagents with isolated contexts; trigger by asking for a workflow or ultracode; token-heavy — scope first runs. Source: claude.com/blog |
| Routines (cloud scheduled runs) | Confirmed | claude.ai/code/routines; schedule/API/GitHub-event triggers; runs on Anthropic cloud with connectors + env vars |
| "Outcomes" (rubric-graded feature) | Unverified | Secondary sources only — treat as /goal + transcript-visible grader until found in official docs |
| "CMA" (Claude Managed Agents) | Secondary sources only | Name appears in creator content; confirm product name + access in official docs before building against it |
| Model lineup for routing | Volatile | Sonnet 5 has shipped since the v1 list was written — pull the models overview + pricing page at runtime, don't hardcode |

## If you're running this next to ACS / LoopTrace

- Point `runs/` at LoopTrace instead of flat JSON — the end-session step in Prompt 00 becomes your "no trace, no write" enforcement hook.
- Prompt 06 is your Hermes-adversarial / Forge-implements / adjudicate pattern as a callable primitive; the routing table in Prompt 04 can map straight onto your agent registry roles.
- Prompt 14's refusal log is a natural PDP event class — a classifier block is just another denied grant with an audit entry.
