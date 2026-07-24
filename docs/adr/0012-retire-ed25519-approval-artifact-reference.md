# ADR 0012: Retire the orphaned Ed25519/"locked PDP contract" approval-artifact reference

## Status

Accepted

## Context

`docs/threat-model.md` line 202 (Deferred Hardening section) currently reads:

> "The execution slice authorization artifact will be an Ed25519-signed approval grant per the locked PDP contract. Do not add a parallel approval bearer token."

A repo-wide search (`grep -rn "PDP contract\|locked PDP\|Ed25519"` across `.md`, `.ts`, `.sql`) finds no document, ADR, schema, or code path that defines a "locked PDP contract." The only other "PDP" occurrence in the repository is an unrelated generic use of the term "Policy Decision Point" in a planning doc, not a contract artifact. The only other "Ed25519" occurrences are the tunnel-connector signing keys described in `docs/oauth-authentication.md` and `docs/threat-model.md` — a different mechanism (remote connector authentication), unrelated to work-item approval. The referenced contract was never written and the referenced signed-grant mechanism was never built.

Meanwhile, the approval mechanism that *was* built and is currently enforced is documented in `docs/adr/0004-request-bound-approval-tokens.md` (as amended) and `docs/protocol/approval-lifecycle.md`: approvals bind to a deterministic action hash (`actionFingerprint`, `packages/policy-gate/src/fingerprint.ts`) plus authenticated-actor identity at the gateway boundary — not a signed token of any kind.

Phase 4 has since added a second, stronger binding layer for plan-level approvals. `storage/migrations/006_execution_plans_and_attempts.sql` defines `execution_plan_approvals` with `plan_hash`, `action_hash`, and `request_hash` columns, and enforces, entirely through triggers, without any signature scheme:

- **Exact, multi-field binding**: `execution_plan_approvals_binding_guard` requires the approval's `plan_id`/`work_item_id`/`plan_hash` to match an existing plan row before insert.
- **Single-use, atomically**: `attempt_leases_binding_guard` only allows a lease insert to reference a `granted`, unexpired approval bound to the *same* plan, and `attempt_leases_consume_approval` (an `AFTER INSERT` trigger) flips the approval to `consumed` in the same transaction as lease issuance — there is no window where a lease could issue without the approval being spent. `execution_plan_approvals_transition_guard` further forbids any field in a granted row from changing except the terminal status transition, and forbids consuming past `expires_at`.
- **Expiry checked atomically, not via a sweeper**: the expiry comparison is evaluated inside the same `BEFORE INSERT`/`BEFORE UPDATE` triggers that bind the lease and the consume transition, not in a separate cron-style expiry job that could race consumption.
- **Append-only history**: `execution_plan_approvals_no_delete` forbids deletion.

This is a complete cryptographic-strength binding (hash-based, not signature-based) between an approval grant and the exact plan/action content it authorizes, enforced at the database layer independent of application code correctness. It closes the same threat the deferred-hardening line was gesturing at — a forged or reused approval artifact — without a signature scheme.

## Decision

Retire the "Ed25519-signed approval grant per the locked PDP contract" line from `docs/threat-model.md`. No such contract exists, no such mechanism was built, and none is needed: the existing hash-chain binding (`action_hash` + `plan_hash` + `request_hash`, single-use via atomic trigger-enforced status transition, expiry-checked at the same instant as consumption) already provides the guarantee a signed grant would have provided — proof that the artifact being consumed matches, byte-for-byte, what was approved, and that it can be consumed exactly once.

`docs/threat-model.md` line 202 is replaced with:

> "Approval grants are bound to exact plan/action content via `plan_hash`/`action_hash`/`request_hash` and are single-use and expiry-checked atomically at consumption (see ADR 0004, ADR 0012, `storage/migrations/006_execution_plans_and_attempts.sql`). No signed approval-grant artifact is planned or required."

No code changes accompany this ADR. This is a documentation correction: the implementation already matches the retired recommendation's intent through a different (and already-shipped) mechanism.

## Consequences

- `docs/threat-model.md`'s Deferred Hardening section no longer references a nonexistent contract document, closing a source of documentation/implementation drift.
- Future readers will not build toward a signed-grant design that duplicates protection the hash-and-trigger binding already provides.
- If a future requirement genuinely needs a party *outside* the current gateway/store trust boundary to prove it saw an approval before execution (the same condition ADR 0004 identifies as the only case where a bearer artifact adds value), that is a new design problem and warrants its own ADR — not a revival of this line.
- The sandbox process-isolation sentence in the same threat-model paragraph is unaffected and remains accurate per ADR 0010.

## Rejected alternatives

### Formally specify the Ed25519-signed-grant design now

Rejected. No topology in the current or Phase 4 design has a party outside the gateway/work-items trust boundary holding a plaintext or signed artifact between grant and consumption — the same reasoning ADR 0004 already used to reject a bearer token applies equally to a signed grant. Building a signature scheme with no consumer that needs it would add key management, verification, and revocation surface for a threat the trigger-enforced hash binding already closes. Revisit only if a genuinely external approval channel (e.g., an out-of-band relay the gateway itself cannot forge) is introduced.

### Leave the line as-is, marked "aspirational"

Rejected. A threat-model line that names a nonexistent artifact risks a future reader assuming stronger protection exists than actually does, or spending effort implementing an unnecessary mechanism. Documentation/implementation drift should be resolved explicitly, not left standing.

## Implementation requirements

- Update `docs/threat-model.md` line 202 to the replacement text above.
- Add a cross-reference from `docs/threat-model.md`'s Deferred Hardening section to this ADR and to `storage/migrations/006_execution_plans_and_attempts.sql`.
- No code, schema, or test changes required.
