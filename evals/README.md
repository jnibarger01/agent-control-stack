# Fixed evaluation harness

The fixed corpus is the numeric baseline for later self-improvement claims.
The existing `packages/eval-harness` remains the ACS audit-replay tool; this
top-level harness evaluates model-produced task outputs.

## Task schema

Each `evals/tasks/*.json` file contains a stable `id`, routing-policy
`taskClass`, input, bounded facts and constraints, 3–7 independently binary
rubric criteria, an optional reference, and a token estimate. The corpus loader
rejects unknown fields, malformed values, duplicate IDs, unexpected files, and
corpora outside 10–20 tasks.

## Independent grader boundary

The maker receives task input and context, but not the reference. The grader is
a fresh call routed to the grader tier. It receives only the task (including a
reference when present), rubric, and candidate output—never maker reasoning or
self-assessment. It returns one boolean and one-line justification per
criterion; missing, duplicate, extra, or multiline results fail closed.

## Result schema

```text
schemaVersion: 1
runId, startedAt, completedAt, pricingDate, provider
predictedCostUsd, actualCostUsd
totals: { tasks, criteria, passed, score }
taskResults[]:
  taskId, taskClass, predictedCostUsd, actualCostUsd, score
  candidate:
    requestedModel, exactModels, stopReason, usage, costUsd, output
    attempts[]: requestedModel, exactModels, stopReason, usage, costUsd
  grade:
    requestedModel, exactModels, stopReason, usage, costUsd, pass
    criteria[]: criterionId, pass, justification
```

The runner prints predicted spend before the first provider call and actual
spend after writing the result. `fixture` is test-only and cannot serve as
baseline evidence. Baselines use `--provider claude-cli`, retain exact model
receipts, and are recorded in `STATE.md`.

## Baseline comparison

Run the unchanged corpus twice. Record both paths, scores, costs, exact models,
and observed score delta in `STATE.md`. The initial expected grader-variance
bound is an absolute score delta of **0.10**. This is repository policy, not a
platform claim; a larger delta leaves the baseline gate open.

## Acceptance checks

```bash
npx vitest run evals
npx tsc -b tsconfig.compounding.json
scripts/run-evals --provider fixture --output runs/artifacts/fixture-eval.json
```
