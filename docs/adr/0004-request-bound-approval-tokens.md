# ADR 0004: Request-bound approvals (amended: no separate bearer token)

## Status

Amended 2026-07-23. Originally accepted with a random-bearer-token design that was never implemented; this revision documents the mechanism that was actually built and is currently enforced, and formally retires the bearer-token requirement rather than leaving it as an unimplemented aspiration.

## Context

Risky actions need human approval, but approval must not become a reusable permission slip. If approval says "write this file" and execution performs "run this shell script," the system has built a tiny betrayal machine.

The original version of this ADR additionally required a random, high-entropy, hashed-at-rest bearer token, shown once to the approving human and re-presented at execution time. That token was never implemented: `packages/work-items/src/store.ts`'s `recordApproval` has always written an empty string to the `approval_token_hash` column. This was not an oversight that slipped through review unnoticed forever — `docs/threat-model.md` has independently documented the column as dormant and not an authorization artifact — but the ADR and `docs/protocol/approval-lifecycle.md` kept describing a token flow that does not exist, which is a real drift between documented and actual security posture. This revision closes that drift.

On inspection, the bearer-token requirement does not fit how approval and execution actually happen in this system. Approval-granting (`approve_work_item`) and approval-consumption (during `claim_next_approved_work_item`) both occur inside the same trusted boundary: an authenticated gateway mutation actor calls `approve_work_item` directly, and the worker-claim path that later consumes the approval is internal harness code, not a separate untrusted party presenting a credential it obtained out-of-band. A bearer token only adds security when some party *outside* the approving system's own trust boundary must later prove it saw the approval. No such party exists in the current design: nothing here separates "who is allowed to approve" from "who can trigger the resulting execution" through an external channel. Introducing a token in this topology would mean generating a secret, storing only its hash, and then having no way for the internal claim path to ever reconstruct or use it — so it would sit unused, or the system would end up storing the plaintext somewhere reachable by the same actors who could already approve directly, which provides no real additional protection.

## Decision

Approvals are bound to a canonical action hash and are valid for one execution only. No separate bearer token is required or generated.

The action hash (`packages/policy-gate/src/fingerprint.ts`, `actionFingerprint`) is computed over the actual proposed action content: requester, risk classification, action kind/description/params, command, cwd, and the destructive/network/write/paths flags. The request hash (`packages/work-items/src/store.ts`, `approvalRequestHash`) is a deterministic hash of `{ actionHash, workItemId }` — not a secret, and not intended to be one; it exists to bind a stored approval row to the exact action it was granted for, not to authenticate the party presenting it.

Authorization instead rests on two things that are cryptographically and procedurally real today:

- **Authenticated actor identity.** Only a caller already authenticated as a mutation-capable actor at the gateway (bearer token, signed session, or trusted loopback per `apps/gateway/src/runtime-config.ts`) can call `approve_work_item` in the first place. `packages/policy-gate/src/rules.ts` additionally denies self-approval on high/critical risk actions (`isSelfApproval`).
- **Exact-hash binding, checked at consumption, not just at grant.** `gateApprovalInTransaction` rejects an approval whose supplied `actionHash` doesn't match a currently-pending requirement on the work item (`approval_action_mismatch`) or isn't actually required (`approval_not_required`). `consumeApproval` (invoked only during worker claim) re-checks status, expiry, and — when a request hash is supplied — an exact match, and flips `status` to `consumed` atomically; a second consumption attempt fails (`approval_conflict`). If the action content changes after approval, `actionFingerprint` produces a different hash, so the old approval no longer matches anything the new action requires.

The `approval_token_hash` column remains in the schema for backward compatibility with any external reader of the table shape, but is formally not part of the authorization decision. It is not populated with a real value, and no code path reads it.

## Approval lifecycle

```text
requested -> pending -> approved -> consumed
                  \-> denied
                  \-> expired
```

Unchanged from the original ADR. What changed is what "approved" means: it means a currently-authenticated, non-self actor recorded a decision bound to the current action hash — not that a bearer secret was issued.

Consumption (at worker claim) checks:

1. An approval row exists for this work item and action hash.
2. If a request hash was supplied by the caller, it matches the stored request hash.
3. Approval status is `granted`.
4. Approval has not expired.
5. Approval has not already been consumed (atomic compare-and-set on `status`).
6. Policy still permits execution (re-evaluated at claim time, independent of the stored approval).

## Consequences

- An approval cannot authorize modified action content — a changed action produces a different `actionHash`, and no approval exists for it.
- An approval cannot be consumed twice (enforced by an atomic status transition, not by token single-use).
- A stale approval cannot execute after policy changes if the current policy denies it, because policy is re-evaluated at claim time.
- Approval storage and the gateway's own authentication boundary are the trusted local security boundary — there is no additional bearer-secret layer, and this ADR now says so explicitly instead of implying one exists.
- **Residual risk, stated plainly:** if a gateway session/bearer credential is compromised, the attacker can call `approve_work_item` directly with that credential — the same as they could forge any other authenticated mutation. A random bearer token shown once to a human would not close this gap either, given the current call topology (see Context); closing it would require a genuinely separate approval channel (e.g., a second factor or an out-of-band relay that the gateway itself cannot forge), which is out of scope for this ADR and would be its own design.

## Rejected alternatives

### Approve by request ID only

Rejected. IDs are easy to confuse or replay unless bound to exact request content. (Unchanged from original — still the reasoning for using an action-hash, not just a work-item ID.)

### Store raw tokens

Rejected — moot under the amended design, since no token is generated. Retained here for history: if a token were reintroduced later, storing it unhashed would still be wrong for the same reason as before (leakage from disk would directly grant authority).

### Random bearer token, shown once, re-presented at execution

This was the original decision in this ADR. Rejected on amendment because the current system has no external party that holds the plaintext token between grant and consumption — approval and claim both happen inside the same gateway/store trust boundary. Revisit if a future design introduces a genuinely separate approval channel (e.g., a human approves via a side channel the gateway cannot itself write to, such as a signed out-of-band relay) where a token would provide real additional assurance.

### Long-lived approval grants

Rejected for MVP, per the original ADR. Still true; approvals expire (`expires_at`, default 10 minutes per `packages/work-items/src/store.ts`).

## Implementation requirements

- Canonical JSON serialization must be deterministic (`stableHash`, `packages/shared`).
- Action-hash and request-hash generation must be covered by tests (`packages/policy-gate/src/fingerprint.ts` and `packages/work-items/src/store.ts` both have associated test coverage).
- Changed argument order or semantically equivalent values must canonicalize to the same hash, or intentionally produce a new one — covered by existing `fingerprint`/`policy` test suites.
- Consuming an approval must be atomic with the state transition that authorizes execution — `consumeApproval` and `claimNextApprovedWorkItem` both run inside `store.withTransaction`.
