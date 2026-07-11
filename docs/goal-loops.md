# Goal-driven execution

Verified: **2026-07-09**

All platform behavior in this document comes from the cited rows in
[`docs/platform-facts.md`](platform-facts.md) and the live official
[`/goal` reference](https://code.claude.com/docs/en/goal). Repository templates
below are local policy, not Anthropic recommendations.

## `/goal` contract

Per the [`/goal` platform-facts row](platform-facts.md#claude-code-and-managed-agent-features):

- one condition, at most 4,000 characters, can be active per session;
- setting it starts work immediately and replaces an existing goal;
- after every turn, a fresh small fast evaluator model checks the condition;
- the evaluator reads the condition and surfaced transcript only—it does not
  run commands or inspect files;
- a `no` starts another turn with evaluator guidance; a `yes` clears the goal
  and records achievement;
- non-interactive `claude -p "/goal ..."` runs the loop to completion in one
  invocation;
- the workspace must be trusted and hooks must be enabled.

Therefore every condition below requires command output and proof to appear in
the transcript. Maker declarations such as “done” are not proof.

## Repository goal templates

### 1. Improve without moving the benchmark

```text
/goal scripts/run-evals --provider claude-cli completes with normalized score >= 0.8205128205, the JSON summary and npm run check exit 0 output are printed in the transcript, STATE.md Last session records the new score and cost, and sha256sum evals/tasks/*.json | sha256sum still prints 7a1f3122f1c7aaab099595659e8c2f33f276aa788bc8e87e0ab5c73e8ae0f83c; must not modify any file under evals/tasks/ or either committed baseline JSON; stop after 20 turns if unmet
```

### 2. Finish maker–verifier evidence

```text
/goal npm run check exits 0 and its output is printed, three committed eval-task traces validate against the makerVerifier trace schema, at least one printed trace query shows selfAssessment.pass=true with an independent verifier failure in the same iteration, and STATE.md Last session names the traces; must not change evals/tasks/, routing prices, or baseline JSON; stop after 20 turns if unmet
```

### 3. Change routing without hiding cost

```text
/goal every task class and escalation path has a passing test, a fixture full eval prints predicted and actual cost, npm run check exits 0 with output shown, and docs/harness routing tables match; must not route every class to Fable, change live pricing without updating docs/platform-facts.md, or edit committed baseline JSON; stop after 15 turns if unmet
```

Each template has one measurable end state, an in-transcript check, and explicit
must-not-change constraints.

## Choosing the continuation mechanism

| Mechanism | Next-turn or run trigger | Stop condition | Use it for | Evidence |
| --- | --- | --- | --- | --- |
| `/goal` | The preceding turn finishes. | Fresh evaluator confirms the transcript proves the condition. | One substantial, session-scoped, proof-oriented objective. | [`/goal` row](platform-facts.md#claude-code-and-managed-agent-features) |
| `/loop` | The configured interval elapses. | User stops it or the repeated prompt decides work is done. | Polling or periodic work while the current session stays open. | [`/loop` row](platform-facts.md#claude-code-and-managed-agent-features) |
| Stop hook | The main agent finishes normally. | A configured command, prompt, HTTP, or MCP handler allows the stop. | A reusable deterministic or model-evaluated gate across sessions. | [Stop-hooks row](platform-facts.md#claude-code-and-managed-agent-features) |
| Auto mode | None; it approves eligible tool calls inside the current turn. | The main agent ends the turn. | Reducing per-tool prompts; pair with `/goal` when another turn must start. | [Auto-mode row](platform-facts.md#claude-code-and-managed-agent-features) |
| Routine | A schedule, authenticated API request, or matching GitHub event starts a cloud session. | That independently started cloud session completes. | Work that must start without an open local session. | [Routines row](platform-facts.md#claude-code-and-managed-agent-features) |

## Long-running rubric-graded work

The [Outcomes row](platform-facts.md#claude-code-and-managed-agent-features)
is `CONFIRMED`, so `harness/outcomes.ts` builds the documented
`user.define_outcome` event with an inline Markdown rubric and bounded
`max_iterations`, then sends it through an injected managed-session transport.
The adapter intentionally does not guess an endpoint or credential flow; the
official managed-agent client owns that transport.

For environments without Managed Agents access, use template 2 plus the local
independent grader. Label that path as the repository fallback, not as the
platform Outcomes feature.

## Acceptance check

```bash
npx vitest run harness/outcomes.test.ts
npx tsc -b tsconfig.compounding.json
```

The committed
[`policy-action-classification` trace](../runs/2026-07-09-goal-policy-action-classification.json)
records a real non-interactive invocation. It returned the task's exact two-line
answer in one turn. A same-session `/goal` status query then returned `No goal
set`; no clear command had been issued. Under the cited contract, that state
transition is the evaluator-pass signal rather than the maker's declaration.
The trace retains both raw CLI result envelopes, platform-emitted session IDs,
exact argv, CLI version, timestamps, workspace-status hashes, and SHA-256
receipt bindings. The validator derives normalized fields from those receipts
and rejects fabricated session IDs, raw tampering, clear commands, or a missing
cleared-goal receipt.

```bash
npx tsx harness/goal-evidence-cli.ts
npx vitest run harness/outcomes.test.ts harness/goal-evidence.test.ts
npx tsc -b tsconfig.compounding.json
```
