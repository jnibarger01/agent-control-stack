# Retry fence

Status: implemented and tested on the local Rust-cutover development branch, **not shipped or production-wired**. Schema migration `083_retry_fence_cleanup_evidence.sql` is new and additive. Tests: `packages/work-items/src/retry-fence.test.ts`.

## Enforcement mode

`ACS_RETRY_FENCE` selects the mode for every process that opens the work-item store (gateway, worker, scheduler):

- unset, empty or `off` (default): execution scopes and verified cleanup evidence are recorded, but nothing is
  refused. This is the behaviour of releases without the fence, so deploying this code does not change lifecycle
  semantics.
- `enforce`: replacement attempts and retries are refused while an attempt is live or unproven, and a second
  in-flight retry of the same source is refused.
- any other value: the store refuses to open (`invalid_configuration`).

Rollout (docs/migrations/production-cutover-plan.md, B1 then B3): ship with the mode off, let scopes and evidence
accumulate for every new attempt, provide the operator route for recording verified cleanup evidence, then set
`enforce`. Rolling back the mode is setting `off` and restarting; stored rows are unaffected.

## Problem

An attempt whose outcome is uncertain (`unknown`, `quarantined`) may still have side effects: a process may still run, or its workspace may be unreleased. Before this change the store did not check that when it created a replacement attempt or a retry.

Three paths were reachable:

- `createAttempt` (the single chokepoint for every claim path) did not look at earlier attempts.
- `retryWorkItem` checked only that the source work item was terminal.
- `transition` allowed `unknown → quarantined → pending_policy` re-entry. Re-entry from `failed` with an accepted result is refused by the database trigger (`work_items: accepted result is immutable`), so the re-entry path that remained open was the unknown one.

Reproduced before the fix (`retry-fence.test.ts`, red run): a replacement attempt was created while the previous attempt was `unknown`; a retry of a terminal source with an `unknown` attempt succeeded; two concurrent retries from separate processes both succeeded.

## The fence

An attempt **holds** the fence when all of the following are true:

1. its status is live (`running`, `leased`, `cancellation_requested`) or uncertain (`unknown`, `quarantined`);
2. no row exists in `attempt_cleanup_evidence` for it.

A held fence refuses:

- `createAttempt` for the same work item, error `execution_fence_held`. Every claim path creates its attempt through this method, so this refuses replacement attempts.
- `retryWorkItem` for the work item, error `execution_fence_held`.

The fence is derived from durable rows. It has no stored flag to drift, it survives restart, and a missing scope or missing evidence leaves it held.

Failed, cancelled and succeeded outcomes do **not** hold the fence. Those outcomes carry an accepted result, and their replay stays governed by the existing retry lineage rules. Narrowing the fence to uncertain outcomes is deliberate: it avoids refusing normal retries of work that failed cleanly.

## Release evidence

Verified cleanup is recorded in two steps, both privileged and both inside the store's single write transaction (`BEGIN IMMEDIATE`):

1. `recordExecutionScope({ attemptId, workItemId, leaseId, fencingEpoch, unitName })` binds the execution unit ACS observed for the attempt to its **latest** lease row. Refused as `execution_scope_binding_mismatch` when the epoch is not current or the lease does not belong to the attempt. A different unit for an attempt that already has a scope is `execution_scope_contradiction`. Re-recording the same tuple is idempotent.
2. `recordVerifiedCleanup({ attemptId, workItemId, leaseId, fencingEpoch, unitName, verdict: "verified", evidenceHash, effectsDisposition, effectsEvidenceHash, observedAt })` releases the fence only when both scope cleanup and external-effect disposition are explicitly evidenced. `effectsDisposition` is `no_external_effects` or `reconciled`; `effectsEvidenceHash` binds the separate observation/reconciliation artifact. Refused as:
   - `attempt_still_live` for a live attempt;
   - `execution_scope_missing` when no scope is recorded;
   - `cleanup_evidence_binding_mismatch` when the lease, epoch or unit differs from the recorded scope;
   - `cleanup_evidence_contradiction` when scope evidence, external-effect disposition, or external-effect evidence hash contradicts the stored record.
   - missing or malformed external-effect fields (schema validation); no row is created and the fence stays held.
     Re-recording identical evidence returns the stored record and changes nothing.

`verdict` accepts only `verified`. A failed, unknown or partial cleanup has no storable form, so it cannot release the fence.

`closeWorkspaceAllocation` sets a workspace to `torn_down` without evidence and does **not** release the fence. The workspace state is not cleanup evidence on its own.

## Invariants

- I1. A replacement attempt or a retry is never created for a work item while any of its attempts holds the fence.
- I2. Release requires evidence whose attempt, lease, fencing epoch and execution unit match the recorded scope **plus explicit external-effect disposition evidence**. A unit teardown alone cannot release the fence.
- I3. Both `attempt_execution_scopes` and `attempt_cleanup_evidence` are append-only. `UPDATE` and `DELETE` abort in triggers.
- I4. At most one retry is in flight per source work item (`retry_already_in_flight`). Writes are serialized, so the check and the insert are atomic. A cross-process race test covers this.
- I5. Missing, stale or contradictory evidence leaves the fence held. Nothing defaults to release.
- I6. ACS retains lifecycle authority. The fence is enforced in the store, and the release APIs require privileged options.

## Compatibility

- **Existing data needs no backfill.** A historical `unknown` or `quarantined` attempt holds the fence until verified cleanup is recorded for it. This tightens behavior. Operators will see `execution_fence_held` where a retry or replacement previously succeeded. That is the intended fail-closed effect.
- **Historical `failed`, `cancelled` and `succeeded` attempts are unaffected.**
- **Migration 083** adds two tables and their triggers. It is additive. It was first written as 079 and renumbered because JCA2 device auth reserves 079–080 and the JC kernel witness 081–082 (`docs/migrations/reservations.md`). The migration roster in `packages/shared/src/migration.ts` lists it as version 83. The work-items bootstrap test pins the roster, and it was updated for this entry.
- **Rollback:** the derived fence disappears when the code is reverted. The tables can stay. They are inert without the gates.

## Not in this change

- Production wiring and attestation. Nothing in the gateway, worker, sandbox or execution controller calls `recordExecutionScope` or `recordVerifiedCleanup` yet. The store validates the fields and hashes but does **not** cryptographically verify that the evidence came from a trusted reconciler. No production component may release a fence until a Rust-controlled reconciler validates scope termination and the external-effect artifact inside its authority boundary. Until that wiring lands, uncertain attempts remain held.
- A launch-time record of the execution unit. The unit name includes random bytes, so the store cannot derive it. It has to be reported by the launcher and recorded through `recordExecutionScope`.
- Clone (`cloneWorkItem`) is not fenced. A clone starts a new lineage and is not a retry of the source. Clone of an uncertain source is an open item.
- `interrupted` is not in the held set. Its semantics are not settled by the current code.
