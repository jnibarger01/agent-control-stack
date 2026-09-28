# Jev Advisor — Shadow Semantic Observation

Status: JEV-2 implemented on this branch; Jev remains advisory only.

The System One endpoint is http://127.0.0.1:8017/v1/systemone by default.
The adapter lives in packages/jev-advisor.

## Authority boundary

ACS remains the sole authority. Jev output MUST NOT change:

- ClassifierEvidence or deterministic task/risk/sensitivity classification
- routing, executor, or model selection
- policy allow/deny
- approvals or capability issuance/consumption
- work-item lifecycle, retries, verification, or promotion

Unavailable, timed-out, incompatible, malformed, or disabled Jev produces
empty/degraded advisory evidence. There is no heuristic fallback. LoopTrace
and Jev evidence must never be read back as authorization state.

## TypeSafe semantics

Noul probability is **P(yes)**.

- near 1: strong yes
- near 0: strong no
- p >= high: yes
- p <= low: no
- otherwise: unknown

Therefore actionable.noul = 0.02 means approximately 2% probability that the
request is actionable, which is a strong no.

Choice returns one declared option plus per-option probabilities and
confidence. Score returns a position over ordered criteria plus probabilities
and confidence. Typed Choice and Score are implemented in the adapter but
remain unusable against a runtime whose complete capability profile says they
are unsupported.

Current local runtime capability:

| Primitive | Support |
| --------- | ------- |
| Noul      | yes     |
| Choice    | no      |
| Score     | no      |

## Runtime capability negotiation

LOCAL_BINARY_CAPABILITY is the default profile for the currently deployed
binary; it is not permanent architectural truth. classifyJev can consume a
complete profile supplied by runtime configuration, transport initialization,
trusted health/metadata discovery, or injected tests.

Missing response capability fields do not mean false. Only a complete trusted
capability source can establish full primitive support. Unsupported requested
primitives degrade with INCOMPATIBLE_MODEL before transport; they are never
silently converted to Noul.

## Mission-intake fan-out

Question set jev-intake@2 owns exactly ten production intake questions:
actionable, needs_code, needs_shell, needs_browser, needs_mobile,
needs_desktop, destructive, auth_sensitive, runtime_mutation, and
approval_likely.

All ten are independent Noul questions over the same state and are sent in
one POST /v1/systemone. The old routing/risk two-request split is removed.

## Redaction and bounds

Before state reaches Jev it is deterministically redacted and bounded.
Secret-shaped text, authentication material, capability/approval tokens, and
unrestricted argv are removed or replaced. This transformation contains no
model logic.

Telemetry schema jev-advisory-event/2 never includes raw state or tool
arguments. It carries:

- partial canonical correlation: request_id, work_item_id, trace_id when known
- question_set_version and primitive per observation
- model and resolved runtime capability profile
- latency and degradation reason
- bounded Noul/Choice/Score observations
- a compact deterministic classifier baseline
- actual_outcome when later enriched

At intake, the gateway reuses the created work-item ID and the mission
request ID. It does not mint a trace ID solely for Jev.

## Gateway wiring

packages/policy-gate/src/jev-shadow.ts runs only after create_work_item
succeeds. It is feature-gated by ACS_JEV_ENABLED, fire-and-forget, and catches
both Jev and telemetry-sink failures. The deterministic baseline snapshot is
copied for comparison; the authoritative classifier object is not modified.

Regression tests prove the authoritative classifier evidence hash is
identical with Jev disabled, healthy, and degraded.

## Existing advisory skip helper

deriveJevDecision retains the historical offline recommendation semantics:
when actionable is classified no and actionable P(yes) <= 0.05, it may return
skip. This helper is not wired into authoritative ACS intake. A
duplicate-like recommendation never replaces the deterministic duplicate
check.

Any future promotion of Jev evidence into an authoritative decision requires
a separate design/ADR and evidence review.
