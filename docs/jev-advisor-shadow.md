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

## JEV-3 canonical trace observation

JEV-3 extends the same advisory-only boundary to execution evidence. Its
original LoopTrace lifecycle publication was commit
`49aca302a1c5f0d12813c73ca4149f2fc7afefd4` with schema SHA-256
`5c0684ddbf26d3e62148d7d37d1523c9f1adcb9c580835d5f11663241ffb8434`.
Phase 3 extends that canonical source first with ACS-bound
`capability.issued`; the current ACS vendored schema pin is
`8b694731594466f5a83d6132df84a07421a472a1d618e34bf74259c9444051a0`.
ACS does not maintain a private schema fork and does not vendor the LoopTrace
repository or commit itself.

The lifecycle vocabulary adds source-neutral evidence kinds for run start/end,
classification and route evidence, approval request/decision, executor start,
tool start/finish, verification start/finish, promotion block/completion, run
failure/completion, and replay divergence. Existing
`acs.approval.granted`/`acs.approval.consumed` remain valid and
source-bound to ACS. Phase 3 adds `capability.issued`, also source-bound to
ACS; Jev may observe its bounded projection, but it cannot authorize, issue,
consume, or reject a capability.

Jace Commander's private trace is never sent directly to Jev. The desktop
commander adapter first verifies the JC private hash chain and maps lifecycle
events into canonical `trace-event/1` events. A supplied canonical ACS
`trace_id`/`work_item_id` is reused; otherwise only observational trace
correlation is derived. Raw argv, credential/token/capability material, and
secret-shaped values are removed before canonical payload hashing.

Phase 4 additionally projects the lease-authorized Desktop Commander execution
boundary from ACS audit events: `executor.started`, `tool.call.started`, and
`tool.call.finished`. Phase 5 adds ACS-owned verification requirement/decision
facts as `verification.started` and `verification.finished`. Phase 6 adds
promotion refusal/completion evidence from ACS's PR-only publication boundary.
The projection keeps only bounded policy/reviewer counts, decision outcome,
promotion stage/reason/external-state, publication id, commit hash, and evidence
correlation hashes; it never includes requirement bodies, reviewer prose, PR
URLs, provider/git error text, raw arguments, filesystem paths, stdout/stderr,
or result content. Jace Commander's private JSONL remains outside this automatic
ACS producer path until a reviewed durable post-execution correlation boundary
exists.

The deterministic canonical projection is bounded and re-redacted before
transport. Question set `jev-trace@1` uses Choice for the primary failure
taxonomy, Noul for escalation/maker-checker/context-rot questions, and Score
for recovery urgency. The current Noul-only runtime therefore marks the mixed
trace classifier incompatible/degraded without fetching. A future runtime
must explicitly declare complete Choice/Score capability before this path can
execute.

Trace telemetry reuses the canonical work-item and trace identities and records
the deterministic observed outcome when one is present. This data is for
offline calibration/comparison only. No production decision path consumes the
trace advisory result.

## JEV-4 automatic trace observation scheduling

JEV-3 provides the canonical trace projection and classifier infrastructure.
JEV-4 schedules that observer automatically after authoritative work has
already completed.

Architecture:

authoritative ACS execution
|
v
canonical lifecycle / LoopTrace evidence
|
| authoritative operation already completes
v
non-authoritative observation trigger
|
v
bounded trace projection
|
v
Jev shadow analysis
|
v
calibration telemetry only

Automatic Jev trace observation is post-authority and non-blocking. Jev
failure, saturation, incompatibility, timeout, or malformed output cannot
alter ACS execution or lifecycle state.

### Trigger scope

Initially observe only terminal or diagnostically significant canonical
traces, such as traces containing:

- run.failed
- run.completed
- promotion.blocked
- promotion.completed
- replay.diverged

The observer obtains a coherent canonical trace and runs the deterministic
projection once appropriate evidence is available. If the trace is
incomplete, malformed, corrupt, or unavailable, the observer emits degraded
observational telemetry if safe, otherwise does nothing, and never alters
execution state.

### Bounded observation

Observation has explicit bounds:

- maximum queued observer jobs: 1000
- maximum concurrent Jev observations: 5
- maximum attempts/retries: 3
- timeout: 30 seconds per observation
- projection size: bounded to 1000 events

When capacity is exhausted, observation is dropped/deferred rather than
blocking authoritative execution. A bounded metric/telemetry signal records
that observation was skipped/degraded.

### Idempotency and correlation

Duplicate scheduling is bounded/idempotent via the deterministic observational
identity: `trace_id + question_set_version + classifier_version`. Repeated
scheduling does not produce uncontrolled duplicate model calls. Retries
are bounded and never affect ACS lifecycle.

### Current runtime behavior

The deployed runtime remains Noul-only (Choice and Score unsupported).
Automatic trace observation against the existing jev-trace@1 mixed
primitive set will normally produce INCOMPATIBLE_MODEL without sending a
System One request. This is acceptable and remains observable in
calibration telemetry. Do not alter the trace question set merely to force
the current runtime to return a classification. A future runtime that
explicitly advertises complete Noul+Choice+Score support should begin
performing the typed trace analysis without requiring another architecture
change.

## JEV-5 execution-progress shadow

The execution-progress observer reuses the canonical trace outbox and bounded
LoopTrace projection. After a trace reaches the existing terminal observation
boundary, the worker reads only the stored mission objective and the recent
32-event window, then emits a separate `jev-execution-progress-event/1`
telemetry record. Evidence contains event IDs, sequence numbers, event kinds,
and short deterministic fact labels; raw arguments and result payloads are not
copied. Intent is redacted and bounded before it reaches System One.

The question set `jev-execution-progress@1` uses Noul only, matching the
currently supported runtime. It asks about advancing/stalled/regressing,
on-task/drift/looping/recovery, completion support, and informational
intervention recommendation and informational risk escalation. Conflicting
or intermediate judgments remain unknown. Exact repeated failed invocation hashes are counted deterministically
outside JEV and reported separately. A verbal completion event is not treated
as verification. Timeout, unavailable model, malformed response, invalid
trace, or telemetry sink failure cannot affect execution or ACS state.

This stage observes complete traces at the current post-authority terminal
boundary. Mid-run checkpoint scheduling is deferred; adding it requires
versioned window identity and bounded outbox semantics so one execution can
produce multiple assessments without changing the existing one-per-trace
idempotency contract. No assessment field is read by policy, routing, lifecycle,
capability, or execution code.
