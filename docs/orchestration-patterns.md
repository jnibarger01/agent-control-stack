# Orchestration patterns: headless fallback

This repository implementation is the **headless fallback** for three reusable
orchestration shapes. It calls an injected `ModelProvider`; it does not select,
start, or claim to be a hosted dynamic workflow. Current platform availability,
activation, scale, and cost facts belong only in
[`docs/platform-facts.md`](./platform-facts.md), especially the Dynamic
workflows and external-trigger rows.

The implementation lives in
[`harness/orchestration-patterns.ts`](../harness/orchestration-patterns.ts).
Tests use deterministic providers and make no live Claude calls.

## Shared contract

Every pattern receives exact model plans, token estimates, a pricing date, and
hard execution caps. Before work starts, the harness prices the planned calls
through `harness/cost.ts`. After each provider call, it aggregates the provider's
actual cost, token usage, and exact-model receipts.

Each invocation returns an in-memory `spend` receipt and emits the same data to
a required logger callback:

- predicted and actual USD;
- input, output, cache-read, and cache-creation tokens;
- requested and exact models per call;
- completed or failed status, with a failure code.

Evidence validation deep-compares the completed result's spend receipt with
the emitted log, recomputes aggregate models/tokens/cost from calls, enforces
the recorded caps, checks measured `elapsedMs` against the wall-clock cap, and
checks the exact role shape for each pattern. For a completed loop, its
iteration count must correspond to exactly one maker and one verifier receipt
per iteration. The runtime validates the same single final receipt against all
caps immediately before it emits or returns a completed result, including time
spent parsing and validating the terminal model response.

The committed acceptance runner persists one logger event per invocation under
`runs/`. Its deterministic evidence is labeled `headless-deterministic-fixture`,
uses `fixture:*` exact model IDs, and records zero actual spend; it is plumbing
and cap evidence, not a provider billing receipt. Malformed JSON, unknown
fields, missing receipts, refusals, a failed synthesis
barrier, and exhausted caps throw; partial output is not returned as success.

## `fanOutSynthesize(subtasks, options)`

Use this when a task can be divided into independent slices and the final answer
must reconcile all of them. Each worker call receives exactly one slice. Only
the synthesizer receives all visible worker outputs.

The synthesizer is a barrier, not a concatenation step. It must report and pass
all three explicit rubric criteria:

1. deduplicate materially equivalent claims while preserving provenance;
2. identify and resolve, or explicitly leave unresolved, material conflicts;
3. preserve coverage of every slice or explain an exclusion.

Named failure mode: **synthesizer bias**. A synthesizer can silently prefer one
worker or erase disagreement. Mitigation: isolated slices, required coverage,
structured conflict records, and a fail-closed dedup/conflict rubric.

## `adversarial(task, options)`

Use this for a decision or answer that benefits from a direct challenge before
acceptance. The maker returns only its visible answer. The refuting critic sees
the task and that answer, then returns a visible refutation plus an explicit
`refute` or `concede` position. The judge
sees the task and both visible outputs, but neither agent's chain-of-thought,
hidden reasoning, or self-assessment.

Named failure mode: **critic nitpicking**. A critic can reward stylistic
objections over material correctness. Mitigation: the judge is explicitly told
to weigh correctness, materiality, and an actionable resolution, and its verdict
is constrained to `maker`, `critic`, or `mixed` with a final output.
The judge cannot select a critic that conceded.

## `loopUntilDone(task, options)`

Use this when success can be expressed as a finite rubric and a candidate may
need bounded revision. Each verifier call receives only the task, rubric, and
candidate. On failure, the next maker call receives only structured
`{criterion, expected, observed}` entries.

Named failure mode: **runaway loop**. A maker and verifier can repeat work
indefinitely or consume disproportionate resources. Mitigation: positive hard
caps on:

- total token receipts, including cache token categories;
- elapsed wall-clock time;
- maker-verifier iterations;
- actual spend, with the remaining spend passed to every provider call.

The worst-case planned cost across all allowed iterations must fit the spend cap
before the first call. Any cap exhaustion raises a typed error and records a
failed spend event; it never converts the last unverified candidate into a
successful result.

## Provider and response isolation

`ModelProvider` is the only execution boundary. Callers can inject a headless
Claude provider, another conforming provider, or a deterministic fixture. JSON
schemas are supplied on every call, rubric identifier fields are constrained
to their stable ID enums, and the harness independently validates returned JSON
with exact-key checks. The provider must report non-negative
usage and cost plus at least one exact model identifier.

No pattern accepts or forwards maker reasoning. The only cross-context data is
the visible output required by the next role:

- worker output to synthesizer;
- maker answer to critic and judge, critic refutation to judge;
- maker candidate to verifier, structured verifier failures to the next maker.

## Acceptance evidence

```bash
npx tsx evals/orchestration-evidence-cli.ts
npx vitest run harness/orchestration-patterns.test.ts evals/orchestration-evidence.test.ts
npx tsc -b tsconfig.compounding.json
```

The four `runs/2026-07-09-orchestration-*.json` files cover one completed run
per pattern and a deliberately non-passing loop stopped after two iterations.
The separate `runs/2026-07-09-dynamic-workflow-attempts.json` trace records two
failed `ultracode` attempts. The command was available, but neither bounded run
completed a pattern: the first lacked its required Write path; the second
started two Agent tasks, found no API key for its generated Node path, and then
exceeded the outer budget check. This is a documented runtime/cost block, not a
dynamic-workflow pass. The three `orchestration-live-*.json` traces are the
allowed headless Claude CLI fallback. Do not relabel fixture or headless
evidence as the hosted mechanism.
