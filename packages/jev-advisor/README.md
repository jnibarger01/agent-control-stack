# @agent-control-stack/jev-advisor

Typed, capability-aware Jev/System One observer (jev-advisory-v2).

**Advisory only, never authoritative.** Jev output is observational evidence.
It MUST NOT alter classifier evidence, task/risk/sensitivity classification,
routing, executor/model selection, policy, approvals, capabilities, work-item
lifecycle, verification, promotion, retries, or any deterministic authority
decision. Disabled, unavailable, incompatible, timed-out, or malformed Jev
returns degraded/empty advisory evidence and leaves the existing ACS path
unchanged.

## TypeSafe primitive semantics

The live TypeSafe contract is authoritative:

- **Noul** answers yes/no questions. answer.noul is **P(yes)**.
  - near 1 = strong yes
  - near 0 = strong no
  - p >= high = yes
  - p <= low = no
  - otherwise = unknown
- **Choice** selects one declared option and returns per-option probabilities
  plus confidence.
- **Score** returns a position over ordered criteria, per-level probabilities,
  and confidence.
  Example: actionable.noul = 0.02 means approximately a 2% probability that the
  request is actionable, therefore a strong **no**.

The package owns typed NoulQuestion, ChoiceQuestion, and ScoreQuestion
contracts plus noul(), choice(), and score() builders and safe answer parsing.
Independent questions over the same state are fanned out in one
POST /v1/systemone.

## Current runtime capability

The currently deployed local binary profile is:

| Primitive | Supported |
| --------- | --------- |
| Noul      | yes       |
| Choice    | no        |
| Score     | no        |

Typed Choice/Score support exists architecturally but is capability-gated.
The local profile is only the default for the current runtime; callers may
supply a complete trusted capability profile through runtime configuration,
transport initialization, trusted metadata discovery, or injected tests.
Missing capability fields are unknown, not false. An incomplete metadata
source cannot establish primitive support.

Requesting Choice or Score against the current Noul-only profile returns
degraded advisory evidence with INCOMPATIBLE_MODEL before any request. The
adapter never downgrades Choice/Score to Noul and never fabricates an answer.

## Usage

All independent typed questions are serialized in one System One request.
Before transport, state is deterministically redacted and bounded;
credential-like values, authorization material, capability/approval tokens,
and unrestricted argv are removed or redacted.

Example:

    const result = await classifyJev(state, {
      actionable: noul("Does this request require action?"),
      route: choice("Which route best fits?", {
        code: "Code change",
        browser: "Browser work"
      }),
      urgency: score("Recovery urgency?", ["none", "soon", "now"])
    }, {
      capabilityProfile: discoveredProfile
    });

## Environment

| Variable           | Default                            | Meaning                           |
| ------------------ | ---------------------------------- | --------------------------------- |
| ACS_JEV_ENABLED    | unset/off                          | No network call unless exactly 1. |
| ACS_JEV_URL        | http://127.0.0.1:8017/v1/systemone | System One endpoint.              |
| ACS_JEV_TIMEOUT_MS | 750                                | AbortController timeout.          |

## Noul thresholds

Every threshold is applied to **P(yes)**.

| Signal           |  low | high |
| ---------------- | ---: | ---: |
| actionable       | 0.15 | 0.85 |
| urgent           | 0.10 | 0.90 |
| needs_code       | 0.15 | 0.85 |
| needs_shell      | 0.10 | 0.90 |
| needs_browser    | 0.15 | 0.85 |
| needs_mobile     | 0.10 | 0.90 |
| needs_desktop    | 0.10 | 0.90 |
| duplicate_like   | 0.05 | 0.95 |
| destructive      | 0.03 | 0.97 |
| auth_sensitive   | 0.03 | 0.97 |
| runtime_mutation | 0.03 | 0.97 |
| approval_likely  | 0.03 | 0.97 |

deriveJevDecision() preserves the existing offline advisory helper:
actionable may recommend skip only when it is classified no and P(yes) <=
0.05. This helper is not wired into authoritative ACS intake. duplicate_like
can only recommend that a deterministic duplicate check be performed; it
never replaces that check.

## Canonical mission-intake registry

Question set jev-intake@2 owns exactly ten production intake questions:

- actionable
- needs_code
- needs_shell
- needs_browser
- needs_mobile
- needs_desktop
- destructive
- auth_sensitive
- runtime_mutation
- approval_likely

All ten are currently Noul questions. The registry owns stable IDs,
instructions, primitive type, category/consumer, and question-set version.
The gateway shadow observer sends all ten in **one POST** after a successful
create_work_item call.

## Correlated telemetry

Telemetry schema jev-advisory-event/2 contains bounded, non-authoritative
evidence only:

- canonical request/work-item/trace IDs when available; fields may be partial
- question_set_version and primitive per observation
- Jev model and resolved runtime capability profile
- latency and degraded/failure reason
- Jev probabilities/Choice/Score outputs
- a compact snapshot of the deterministic classifier recommendation
- actual_outcome when later known
  Telemetry never contains raw mission state, raw tool arguments, credentials,
  capability tokens, approval tokens, or unrestricted model output. At mission
  intake a trace ID is not minted solely for Jev; later correlation may enrich
  the event with the canonical trace identity.

The deterministic classifier object is never modified to carry Jev data.
Tests compare classifierEvidenceHash() with Jev disabled, healthy, and
degraded to enforce this invariant.

## Shadow wiring

packages/policy-gate/src/jev-shadow.ts is feature-gated and fire-and-forget.
It derives a safe deterministic baseline snapshot and emits a single telemetry
record from the one ten-question response. The gateway invokes it only after
create_work_item succeeds and supplies the canonical work-item ID. All Jev
and telemetry-sink failures are swallowed at this boundary.

Jev is not consumed by classifyMissionIntake, policy evaluation,
approval/capability issuance, executor selection, lifecycle state, or
promotion.

## CLI

    acs-jev classify --state-file <state.txt> \
      --signal actionable="Does this request require an action?" \
      --signal needs_code="Does this need code?" [--json] [--strict]

CLI --signal questions are explicitly wrapped as Noul questions. The default
exit code remains 0 on Jev degradation; --strict exists for testing only and
must not be used as an ACS authority gate.

## Canonical LoopTrace shadow classification

JEV-3 consumes **canonical LoopTrace `trace-event/1` events only**. Jace
Commander private JSONL is verified and normalized by
`@agent-control-stack/desktop-commander-adapter` before it can reach the Jev
projection. LoopTrace remains observational evidence; no trace state is read
back as authorization state.

`projectCanonicalTraceForJev()` is deterministic and model-free. It:

- requires one canonical `trace_id` and strictly increasing sequence
- prioritizes recent failure, verification, tool-outcome, and promotion evidence
- caps event count, detail keys/string lengths, and total serialized state
- reapplies the shared ACS secret redactor and drops raw argv/arguments
- preserves event kind, ordering, source, outcome-relevant detail, and canonical
  work-item/trace correlation when available

Trace question set `jev-trace@1` is:

| Question              | Primitive |
| --------------------- | --------- |
| `failure_mode`        | Choice    |
| `should_escalate`     | Noul      |
| `needs_maker_checker` | Noul      |
| `context_rot`         | Noul      |
| `recovery_urgency`    | Score     |

The failure-mode Choice is limited to `healthy`, `tool_loop`,
`budget_burn`, `instruction_drift`, `verifier_fail`, `stagnation`,
`hallucination`, `policy_denied`, `worktree_collision`, and `other`.

Because the deployed runtime is Noul-only, the complete trace question set is
currently reported as `INCOMPATIBLE_MODEL` without a network request. It is
not converted into independent fake Choice/Score answers. Tests inject a
future full-capability profile to validate the mixed typed path.

`classifyJevTrace()` and `runJevTraceShadow()` emit only correlated
`jev-advisory-event/2` telemetry. The latter catches projector, transport, and
telemetry-sink failures. Neither function is wired into policy, approvals,
capability issuance, retry/termination, verification, or promotion.
