# Independent maker-verifier loop

This document describes repository-local design policy and implementation. It
does not claim that any model or platform feature guarantees independent
verification.

## Why the roles are separate

A maker can stop after producing a plausible answer instead of satisfying the
whole rubric. This repository calls that failure mode **agentic laziness**. A
maker can also overrate its own output because the same generation produced
both the answer and the assessment. This repository calls that failure mode
**self-preferential bias**. These labels are local design rationale, not
empirical claims about a platform.

`createMakerVerifier(options)` injects a maker provider and a verifier-provider
factory, then returns exactly this callable shape:

```ts
makerVerifier(task, rubric, maxIters)
```

The maker's `selfAssessment.pass` is evidence, not authority. Only a fresh
verifier call can pass an iteration.

## Isolation contract

The first maker request receives:

```json
{
  "task": { "input": "...", "context": {} },
  "rubric": []
}
```

It must return exactly:

```json
{
  "output": "...",
  "selfAssessment": { "pass": true, "summary": "..." }
}
```

Every verifier request is sent through a newly constructed provider containing
only:

```json
{
  "task": { "input": "...", "context": {} },
  "rubric": [],
  "candidateOutput": "..."
}
```

The verifier never receives the maker's self-assessment, prior model messages,
or hidden reasoning. It returns one binary result for every rubric criterion.
The harness rejects a verifier provider object that was used earlier or is also
the maker provider.
The response schema constrains `criterion` to the rubric's stable ID enum and
constrains the array length to the rubric length; descriptive labels cannot be
silently accepted as IDs.
The loop converts failed results to the only feedback allowed in a retry:

```json
{
  "task": { "input": "...", "context": {} },
  "failures": [
    { "criterion": "...", "expected": "...", "observed": "..." }
  ]
}
```

Retry input excludes verifier pass results and all other verifier prose. The
original rubric remains enforced by the verifier; it is deliberately absent
from retry requests so maker feedback cannot grow beyond the structured
failure boundary.

## Guards and evidence

- `maxIters` must be an integer from 1 through the local policy cap of 20.
- Two consecutive identical normalized failure sets trigger the existing
  `route()` verifier-failure escalation before the next maker call.
- Missing, duplicate, unknown, or extra object fields, multiline summaries or
  observations, refusals, and otherwise malformed response data fail closed.
  Partial model output is not accepted.
- A result passes only when all verifier criteria pass. Reaching `maxIters`
  returns the last candidate and failures with `pass: false`.
- The returned trace records every maker and verifier result, independent pass
  decision, structured failure set, escalation, model receipt, duration,
  token usage, aggregate cost, and timestamps. Callers can persist that trace
  with a run without reconstructing events from logs.

The harness tests use scripted injected providers. They make no live model or
network calls. The three committed acceptance traces use the tool-less Claude
CLI provider. Two are ordinary live runs. The `work-item-lifecycle` trace
explicitly injects one incomplete first maker response whose receipt model is
`fixture:seeded-maker-error`; its fresh verifier and the retry are live calls.
The trace does not misrepresent the injected output as a model response.
Each evidence envelope binds the trace to the source eval-task SHA-256 and
rubric snapshot. Its validator rereads the exact task file, recomputes the raw
SHA-256, parses and matches the task ID and rubric exactly, and then recomputes
criterion parity, structured failures, per-model cost/usage, and run
aggregates. Each model-reported duration must also fit its enclosing receipt
timestamp interval, within the documented clock tolerance.

## Acceptance check

```bash
npx vitest run harness/maker-verifier.test.ts --reporter=verbose
npx vitest run evals/maker-verifier-evidence.test.ts --reporter=verbose
npx tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --types node,vitest/globals harness/maker-verifier.ts harness/maker-verifier.test.ts
```
