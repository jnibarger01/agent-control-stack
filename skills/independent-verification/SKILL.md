---
name: independent-verification
description: Run and audit the repository's fresh-context maker-verifier loop. Use when generating independently graded work, retrying from criterion failures, proving that self-assessment is not the stop authority, or persisting maker-verifier evidence under runs/.
---

# Independent Verification

Keep generation, verification, retry feedback, and persisted evidence on
separate trust boundaries.

## Procedure

1. Read `STATE.md`, `docs/independent-verification.md`, the selected eval task,
   and `harness/routing.md`.
2. Require a rubric with 3-7 unique stable IDs. Constrain the verifier response
   schema's `criterion` field to those exact IDs and constrain its array length
   to the rubric length. Do not rely on prompt prose to preserve identifiers.
3. Create the maker and verifier with separately injected providers. Each
   verifier call must be fresh and receive only task input/context, rubric, and
   candidate output. Never send maker reasoning or self-assessment.
4. Treat maker self-assessment as evidence only. An iteration passes only when
   the independent verifier passes every criterion.
5. On failure, return only `{criterion, expected, observed}` entries to the
   next maker call. Do not forward verifier prose or passing results.
6. Enforce `maxIters`. Escalate through `route()` after the same normalized
   failure set appears twice. Malformed, partial, duplicate, unknown, or
   refused responses fail closed.
7. Before writing a trace, collect explicit values under sensitive task keys
   from the task input and context, and redact those literals from all
   model-generated prose. Preserve exact
   model, token, cost, duration, and stop receipts. Mark any fault injection
   explicitly; never represent a seeded answer as a live model result.
8. Validate the full traces and scan them for secrets before treating them as
   evidence. Reread the source task, recompute its raw file hash, parse it, and
   require exact task ID and rubric equality. Then reconcile criterion
   failures, timestamps, per-model receipts, aggregate usage, and aggregate
   cost. Require every reported model duration to fit its enclosing timestamps
   within the documented clock tolerance. A maker-only success receipt or an
   internally consistent detached rubric is insufficient.

## Acceptance check

```bash
npx vitest run harness/maker-verifier.test.ts evals/maker-verifier-evidence.test.ts packages/shared/src/redact.test.ts
npx tsc -b tsconfig.compounding.json
if rg -n -i 'sk-ant-|bearer[[:space:]]+[a-z0-9._~+/-]{12,}|secret-token|hunter2' runs/*maker-verifier*.json; then exit 1; fi
```

Confirm that three distinct eval task traces exist and at least one contains
`maker.selfAssessment.pass=true` with `verifier.pass=false` in the same
iteration.

## Changelog

- 2026-07-09: Created after live verifier outputs showed that prompt wording
  alone did not preserve stable rubric IDs; added response-schema enums.
- 2026-07-09: Added explicit task-secret redaction and fault-injection labeling
  after a grader echoed sample secret values into otherwise valid evidence.
- 2026-07-09: Exempted token-accounting fields from credential-key redaction
  and distinguished repeated references from actual cycles after a live trace
  validator caught corrupted receipts.
- 2026-07-09: Added task-file hashes, rubric snapshots, and full receipt
  reconciliation after an independent tamper audit showed that internally
  plausible but corrupted aggregate fields could pass the first validator.
- 2026-07-09: Bound task hashes and rubric snapshots back to the parsed source
  file and reconciled durations with timestamps after a second independent
  audit found coherent detached-rubric and impossible-duration receipts.
