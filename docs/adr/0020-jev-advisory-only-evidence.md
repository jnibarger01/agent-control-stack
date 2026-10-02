# ADR 0020: Jev is advisory-only evidence, never an authority

## Status

Accepted.

## Context

Jev (`jev` / System One, a local binary probability engine) is being integrated
into ACS so that its probabilistic judgements can be logged, traced, compared
against the deterministic mission classifier, and evaluated offline. The risk
is a well-documented failure mode: an advisory model quietly becoming an
authorization, routing, approval, or promotion gate.

The deployed local engine is currently Noul-only and reachable at
`http://127.0.0.1:8017/v1/systemone`. For Noul, `answer.noul` is **P(yes)**:
values near `1` are strong yes and values near `0` are strong no. The adapter
also owns typed Choice and Score contracts, but the deployed runtime does not
advertise those primitives. Choice/Score therefore remain capability-gated and
must never be inferred, downgraded to Noul, or fabricated. A complete trusted
runtime capability profile may replace the current local default without
changing the authority boundary.

## Decision

Jev is an `ADVISORY_EVIDENCE` source ([ADR 0015](0015-advisory-reasoning-evidence-and-independent-verification.md)).
It produces typed, probability-bearing evidence and nothing else.

- The integration is gated by `ACS_JEV_ENABLED=1`. When unset it is fully
  inert: no network call, no fabricated data.
- The hook is fire-and-forget, log-only, and fires at the gateway
  `create_work_item` boundary **after** the policy-gated call succeeds. It
  writes telemetry lines only.
- The adapter is degrade-never-fail: disabled, unavailable, timed out, non-2xx,
  malformed, out-of-range probability, or unsupported capability all resolve
  with `degraded: true`, empty signals, and no fabricated values. It never
  throws into the request path.
- Jev never alters classifier evidence, risk ranking, policy, approvals,
  capability issuance, executor selection, work-item state, or promotion. The
  authoritative `ClassifierEvidence` (and its content hash) is identical
  whether Jev is disabled, healthy, degraded, or ignored; this is asserted by a
  differential test.
- Model-controlled strings are sanitized to a safe charset before they reach
  consumer-visible output.
- If duplicate-likeness is useful, Jev may only _recommend_ that the
  authoritative deterministic duplicate check run. Jev itself never discards or
  rejects work.

The adapter may also expose a pure, offline `deriveJevDecision` helper
(`skip | continue | duplicate_check_required | degraded`) for the CLI and for
offline evaluation. It is not wired into any authoritative path; a `skip`
recommendation is telemetry, not a lifecycle transition.

## Consequences

- `packages/jev-advisor` is a workspace package consumed by `packages/policy-gate`
  (`src/jev-shadow.ts`).
- ACS behavior is provably unchanged with Jev on or off; only advisory
  telemetry differs.
- No new authority, no second control plane, no new approval or promotion path.

## Rejected alternatives

- **Jev as a prefilter that skips intake.** Rejected: Jev must not independently
  reject work; a probabilistic model is not an authority.
- **Jev as a promotion or approval gate.** Rejected by ADR 0015 and the ACS
  authority invariants.
- **Inferring `choice`/`score` support from a decision response.** Rejected: the
  running model does not advertise it; absent fields stay absent and never
  default to `false` or `true`.

## Enforcement

The boundary is a lint rule, not only convention. `eslint.config.js` forbids importing
`@agent-control-stack/jev-advisor` everywhere except the adapter package itself,
`packages/policy-gate/src/jev-shadow.ts` and `packages/evidence/src/observation-worker.ts`
(tests excepted). Policy-gate decision modules may additionally not import `./jev-shadow.js`,
and authority code outside the gateway MCP observation path may not import Jev shadow hooks
through the `@agent-control-stack/policy-gate` barrel. `tests/jev-boundary.test.ts` proves the
direct and barrel-import rules fire for authority paths and stay quiet for the documented
observation paths. Widening the allow-list requires amending this ADR.
