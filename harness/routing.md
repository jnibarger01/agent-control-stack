# Model routing and cost policy

Verified: **2026-07-09**

This is a repository routing policy, not a claim that Anthropic recommends these
task assignments. Model IDs, availability, refusal behavior, and prices come
only from [`docs/platform-facts.md`](../docs/platform-facts.md).

Official evidence:

- [Models overview](https://docs.claude.com/en/docs/about-claude/models/overview)
- [Pricing](https://docs.claude.com/en/docs/about-claude/pricing)
- [Fable 5 and Mythos 5 model guide](https://docs.claude.com/en/docs/about-claude/models/introducing-claude-fable-5-and-claude-mythos-5)
- [Refusals and fallback](https://docs.claude.com/en/docs/build-with-claude/refusals-and-fallback)

## Registry and default task classes

| Task class | Default route | Local policy rationale |
| --- | --- | --- |
| `orchestration` | `claude-fable-5` | Reserve the frontier route for coordinating multi-step work. |
| `planning` | `claude-fable-5` | Reserve the frontier route for plans whose errors fan out into later work. |
| `refusal_sensitive_frontier` | `claude-fable-5` | Use Fable while retaining an explicit non-Fable refusal path. |
| `hard_subtask` | `claude-mythos-5` when explicitly available; otherwise `claude-opus-4-8` | Mythos access is limited, so the router never assumes it. This ordering is local policy, not a platform ranking claim. |
| `bulk_worker` | `claude-sonnet-5` | Route repeatable implementation work below the frontier tier. |
| `grader` | `claude-haiku-4-5-20251001` | Keep bounded rubric checks on the cheapest registered tier. |
| `classifier` | `claude-haiku-4-5-20251001` | Keep bounded classification on the cheapest registered tier. |

The default availability set contains Fable 5, Opus 4.8, Sonnet 5, and Haiku
4.5. Mythos 5 is excluded because the verified source limits it to approved
Project Glasswing customers. A caller with that access must include
`claude-mythos-5` in `availableModelIds` for the current route call.

## API contract

```ts
route(taskClass, attempt, lastFailure) -> model ID
```

- `taskClass` is one of the seven classes above.
- `attempt` is the number of consecutive verifier failures for the current
  task. It must be a non-negative integer.
- `lastFailure` is `null` or a structured signal. Every signal may carry an
  `availableModelIds` override; input order never changes selection order.

Supported signals:

- `{ kind: "verifier_failure" }`: escalate one tier when `attempt >= 2`.
- `{ kind: "grader_disagreement" }`: escalate one tier immediately.
- `{ kind: "refusal", modelId }`: select the hard non-Fable tier immediately.
  Per the verified refusal contract, callers must derive this from
  `stop_reason: "refusal"`, discard any partial output, and must not infer it
  from response text or `stop_details`.
- `{ kind: "agreement", agreementRuns, currentModelId }`: after
  `DEESCALATION_AGREEMENT_RUNS` (**3**) consecutive agreement runs, return the
  class to its base tier. Before the threshold, retain the current tier.
- `{ kind: "availability" }`: apply an availability override without a failure.

Escalation tiers are `Haiku -> Sonnet -> Fable -> hard non-Fable`. The hard tier
uses Mythos only when explicitly available, then Opus, Sonnet, and Haiku. It
never returns Fable for a Fable refusal. If no model satisfies a route, the
function throws instead of silently selecting an unavailable or refused model.

## Cost discipline

The verified base rates in USD per million input/output tokens are:

| Model | Input | Output |
| --- | ---: | ---: |
| Fable 5 | $10 | $50 |
| Mythos 5 | $10 | $50 |
| Opus 4.8 | $5 | $25 |
| Sonnet 5 through 2026-08-31 | $2 | $10 |
| Sonnet 5 from 2026-09-01 | $3 | $15 |
| Haiku 4.5 | $1 | $5 |

`priceFor(modelId, onDate)` resolves the dated rate from an explicit
`YYYY-MM-DD` value. `estimateCost(...)` multiplies caller-supplied input and
output token estimates by that rate. `estimateRoutedCost(...)` first calls
`route(...)`, then returns the selected model and predicted input, output, and
total spend. These estimates do not claim to be provider billing receipts;
later runners must compare them with actual provider usage.

"Fable for everything" is the cost failure mode. At the verified rates, Fable
costs ten times Haiku and at least three-and-one-third times Sonnet per token
after Sonnet's introductory period. Defaulting bulk work and graders downward
is therefore the main controllable cost lever; escalation restores a stronger
route only when verification evidence warrants it.

## Acceptance check

```bash
npx vitest run harness/routing.test.ts harness/cost.test.ts --config /dev/null --reporter=verbose
```

The focused suite covers every task class, verifier-failure escalation, grader
disagreement, refusal fallback, limited availability, deterministic fallback,
agreement de-escalation, the Sonnet price boundary, and cost arithmetic.
