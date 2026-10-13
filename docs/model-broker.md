# Model and compute broker

Slice 7.1 of the autonomous-evolution mission. `@agent-control-stack/model-broker` decides **which model** should serve a
request, from local and hosted candidates, using measured evidence and the host's real resources, and records why.

## What it is not

- Not an authority. It grants no capability, holds no credentials, and does not replace ACS's worker routing (Nimble).
  Callers keep whatever authorization they already have; the broker ranks models they may already use, and a privacy class
  can only narrow that set.
- Not wired into the gateway yet. The existing inference proxy still fronts a single upstream; integrating the broker there
  is a later, separate step.
- Not an optimizer that explores. With no evidence it follows catalog priority and says so (`mode: default_priority`).

## Inputs, and where each comes from

| Input                                                                       | Source                                                                                                | If missing                         |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------- |
| What is installed or reachable                                              | **Discovery**: Ollama `/api/tags` and `/api/ps`, any OpenAI-compatible loopback server (`/v1/models`) | not available, never assumed       |
| What a model may do (task types, context window, memory, privacy clearance) | **Operator catalog** (`parseCatalog`, strict)                                                         | the model is not offered           |
| Hosted providers                                                            | credential **presence** in named environment variables; the value is never read into any structure    | not available                      |
| Free memory, CPU, GPU                                                       | `readComputeSnapshot`: `/proc/meminfo` `MemAvailable`, `os`, and `nvidia-smi`                         | GPU reported `unknown`, not `none` |
| History                                                                     | append-only outcomes and verifications (migration 064)                                                | cold start, by catalog priority    |

A model is a candidate only if it is both **catalogued** and **observed**. An installed embedding model is never offered for
code generation because the catalog does not list that task for it.

## Eligibility (hard rules, in order; every reason is recorded)

`not_available`, `provider_unreachable`, `task_unsupported`, `context_too_small` / `context_window_unknown` (unknown fails
closed), `privacy_not_allowed`, `circuit_open`, `insufficient_memory` (a model already resident is exempt; a reserve is kept),
`gpu_unconfirmed` (a GPU requirement that cannot be confirmed is rejected).

Defaults: a local model may serve up to `restricted`, a hosted model only up to `internal`, because a hosted provider sees
the prompt. A "local" provider must be on loopback; a non-loopback endpoint is refused rather than treated as local.

**Evidence ranks models; it never overrides an eligibility rule.** A model that has been right every time is still rejected
if the request's privacy class exceeds its clearance.

## Ranking

1. Models with at least `minSamples` **verified** outcomes whose conservative correctness (lower bound of the 95% Wilson
   interval) is at least `minAcceptableCorrectness`, best score first. Score is correctness minus normalized p95 latency and
   cost penalties. An unreported latency or cost contributes nothing; it is never counted as zero.
2. Models with too little evidence, by catalog priority.
3. Models with enough evidence that clears the bar for nothing, best first, as a last resort.

`mode` says which case applied (`evidence`, `default_priority`, `last_resort`, `none`). An unverified success is an attempt,
not correctness evidence: correctness is measured only on outcomes an independent check has verified (`broker.verify`).

## Execution and failover

`execute` runs a caller-supplied call against the ranking, best first. It fails over only on a **provider** failure
(unreachable, timeout, 5xx); a **request** failure would fail the same way elsewhere and stops the run. After a provider
fails in a run, its other models are skipped. Attempts are bounded (`maxAttempts`, at most 5) and every attempt is recorded,
including failures. A thrown error counts as a provider failure and its message is not stored. Repeated provider failures
open a circuit for that provider, closing again after a success; after the cooldown one attempt may probe it (`half_open`).

Failover is safe because model generation has no side effect to repeat. Do not use `execute` for a call that has one.

## What is recorded

`model_route_decisions` (request metadata, ranking, every rejection and its reasons, a hash of the host state seen, the
decision hash), `model_route_outcomes`, `model_route_verifications`. All three are append-only, with guards against
`INSERT OR REPLACE`. **No prompt is ever stored.** Routing is idempotent on `requestId`: a retried request gets the first
decision, so the host having changed does not alter it and evidence is not double counted. A stored decision that no
longer matches its hash is an integrity error.

## Not in this slice

- Gateway integration and a CLI or Mission Control view of decisions.
- Live reachability or credential validity checks for hosted providers (a call would spend money and send traffic).
- Exploration of unmeasured models, per-task-type resource accounting beyond the memory and GPU checks, queueing.
- Using a model's own list price to estimate cost: the broker records only the cost a caller reports.
- Migration number: this slice uses 064 and leaves 063 to the open recovery PR; the registry therefore has a gap at 63
  until that merges.
