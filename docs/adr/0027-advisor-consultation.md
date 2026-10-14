# ADR 0027: Advisor consultation is evidence, never a decision

## Status

Accepted

## Context

Claude Code can consult a second, stronger model at decision points and usually follow its guidance. ACS already has two different advisory mechanisms:

- Jev ([ADR 0020](0020-jev-advisory-only-evidence.md), [ADR 0025](0025-routing-ownership-and-staged-jev-influence.md)) is a probabilistic shadow observer. It stays shadow-only.
- The MOA advisor ([packages/moa-orchestrator](../../packages/moa-orchestrator)) reviews a task before an aggregator may ask ACS to create work. It is not a mid-run consultation.

[ADR 0015](0015-advisory-reasoning-evidence-and-independent-verification.md) already says an `ADVISORY_REASONER` may propose and review, and may not authorize, approve, or complete work. A mid-run advisor fits that role only if its text cannot become a gate.

## Decision

An advisor consultation is an append-only evidence record. The leased executor may read the guidance. Policy, approval, routing, lease issuance, and completion may read the checkpoint, the disposition, and the hashes. They may not read the guidance text.

- The advisor is off until an operator enables a binding. Enabling an unknown, excluded, or weaker advisor fails closed and writes nothing.
- The executor requests one of three checkpoints: `before_approach`, `recurring_failure`, `before_completion`. The caller cannot supply a transcript or choose the advisor model.
- ACS builds the advisor input from the mission flight recorder, redacts it, and bounds it. A tampered flight chain is not sent.
- The advisor request has no tools. A response that is not the strict guidance schema is stored as `unavailable`. Nothing is fabricated.
- `requireBeforeCompletion` is opt-in. When set, success requires a `before_completion` row whose disposition is `reviewed` or `declined`. Missing or `unavailable` fails closed with `advisor_consultation_required`. A decline means the advisor answered. It does not mean the work passed.
- Child work may copy a parent binding. Pairing is checked again against the child executor. A copy that cannot pair does not attach an advisor and does not block creating the child. Refusing the child would let pairing decide whether work exists.
- Existing work with no binding is unchanged.

This does not call Anthropic's server advisor tool and does not change Jev's import boundary.

## Consequences

- New tables `advisor_bindings` and `advisor_consultations` (migration 073). Consultations are append-only.
- Guidance text lives in `@agent-control-stack/advisory/guidance`. Authority packages may import the disposition module only.
- Audit events carry identifiers, the checkpoint, the disposition, and hashes. They do not carry the flight projection or the guidance body.

## Rejected alternatives

- **Treat advisor guidance as approval or completion.** Rejected by ADR 0015. A model's "ship it" is not a decision.
- **Send the caller-supplied transcript.** Rejected. The caller is untrusted, and the flight recorder is the bounded record ACS already has.
- **Reuse Jev or the MOA aggregator.** Rejected. Jev must stay shadow-only, and MOA runs before work exists.
- **Silently drop a weaker advisor at enable time.** Rejected. A misconfigured operator binding fails closed so the gap is visible.
- **Fail child creation when the copied advisor cannot pair.** Rejected. That would make an advisory check decide whether the child exists.
