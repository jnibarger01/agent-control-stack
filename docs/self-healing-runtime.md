# Self-healing mission runtime: stale-claim recovery

Slice 5.1 of the autonomous-evolution mission. It covers one failure: a worker takes a unit's claim and then vanishes.

## The defect it replaces

When the executor reported a stale claim's operation `absent`, the controller called `resetClaim`, which returns the
unit to `pending` and decrements `attempt`. A claim increments `attempt`, so a worker that kept vanishing netted zero
and was retried forever, immediately, with nothing recorded.

## What happens now

On a stale claim (older than `claimTtlMs`) the controller asks the executor whether the operation ran:

| Executor says                     | Result                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `absent` (confirmed it never ran) | `releaseStaleClaim`: recorded recovery, exponential backoff, unit back to `pending`.           |
| `succeeded`                       | Existing reconciliation; the result is adopted. Unchanged.                                     |
| `unknown`                         | **Not retried.** A `recovery_unsafe` escalation is recorded (once); the claim stays as it is. |
| anything else                     | Existing behavior: the mission is degraded. Unchanged.                                         |

A stale claim with no claim token has no fence to release, so it is escalated as `recovery_unsafe` and the mission is
degraded. Recovery follows confirmed non-execution only; an effect the system cannot rule out is never repeated.

### Fencing

The claim token is the fence. `releaseStaleClaim` only accepts the current claimant's token. After release the unit's
token is cleared, so the old holder cannot complete the unit (`completeOperation` requires the matching token) and
cannot release or complete a newer claim. Tests cover a late completion, a never-seen token, and a stale holder against
a newer claim.

### Idempotency

Each release is a row in `work_unit_recoveries`, unique on a hash of the released claim token. Recovering the same stale
claim again returns the first decision (`replayed: true`) and changes nothing, including after a restart.

### Bounded retries and backoff

The row count is the unit's recovery count. The n-th recovery waits `min(maxBackoffMs, baseBackoffMs * 2^(n-1))`
(defaults 2s base, 60s cap, 3 recoveries). The wait is stored as `coding_operations.retry_not_before` and enforced where
claims are made (`claimUnit`, `recovery_backoff`), so no caller can claim early. The controller treats units that are
only waiting as "nothing to run yet", not as a blocked mission, so the mission is not degraded by a backoff.
`recoveryPolicy` on the controller ports overrides the defaults; values are bounded (at most 10 recoveries, backoff cap
one hour) so a misconfiguration cannot restore an unbounded loop.

### Poison work and escalation

The recovery after the limit stops the unit instead: status `failed`, category `retry_budget_exhausted` (already
non-retryable), claim cleared, a `poison_work` escalation recorded, and the mission degraded with code `poison_work`.
`work_unit_escalations` is append-only evidence for an operator, one row per unit and kind. It is not a control;
acknowledging or resolving an escalation is a later slice, with the Mission Control surface.

### Evidence

`work_unit.recovered`, `work_unit.poisoned` and `recovery.escalated` go through the flight recorder, and replay shows
the unit as `pending` or `failed` accordingly.

## Not in this slice

- Durable checkpoints (the `checkpointed` status exists but nothing writes a checkpoint).
- Provider disconnection, dependency-failure and lost-heartbeat detection feeding recovery.
- Recovery for the generalized work-unit execution ledger (`worker-execution.ts`); only the controller's stale-claim path
  uses `releaseStaleClaim` so far.
- Operator acknowledgement or resolution of escalations, and the Mission Control view.
- Attempt accounting still follows the existing rule (a confirmed-unstarted recovery gives the attempt back); the
  recovery limit, not the attempt count, is what bounds this path.
