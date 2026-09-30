# Approval Bundles (Change Sets) — Design

Status: implemented on `feat/approval-bundles-v1`.
Contract version: `acs.approval-bundle.v1`.

This document first records the flow that **actually exists** in ACS today, because
the bundle feature is an extension of that flow and not a replacement for it. Anything
described in the second half of this document is new.

---

## Part 1 — The existing approval flow, as implemented

This section was written from the code, not from the documentation. Where the two
disagreed, the code won and the disagreement is noted.

### 1.1 There is no approval token

The docs at `docs/protocol/approval-lifecycle.md` describe a bearer approval token.
That was never implemented. `store.recordApproval` writes the literal empty string
into `approval_records.approval_token_hash` (`packages/work-items/src/store.ts:4742`).
Authority is instead bound by recomputing an **action hash** at use time.

### 1.2 The action hash is the unit of authorization

`packages/policy-gate/src/fingerprint.ts` is the whole file:

```ts
export function actionFingerprint(context: PolicyContext): string {
  return stableHash({
    requester: context.requester,
    risk: context.risk,
    action: { kind: context.action.kind, description: context.action.description, params: context.action.params },
    command: context.command,
    cwd: context.cwd,
    destructive: context.destructive,
    network: context.network,
    paths: context.paths,
    write: context.write
  });
}
```

`workItemId`, `actor`, `operation` and `requesterSubject` are deliberately excluded.
Work-item scoping is supplied separately, by `planHash` and `workItemId` bindings.

This matters enormously for bundles: **an approved change is exactly an approved
action hash.** Change a command, a path, a target or a description and the hash
changes, so the change is no longer the thing that was approved.

### 1.3 Two approval models exist side by side

|              | Authoritative                                       | Legacy                                              |
| ------------ | --------------------------------------------------- | --------------------------------------------------- |
| Table        | `execution_plan_approvals`                          | `approval_records`                                  |
| Schema       | `006_execution_plans_and_attempts.sql`              | `001_audit_log.sql`                                 |
| Statuses     | `granted`/`consumed`/`invalidated`/`expired`        | `granted`/`consumed`                                |
| Immutability | UPDATE guard whitelists transitions; DELETE blocked | none; `recordApproval` can resurrect a consumed row |
| Written by   | `grantExecutionPlanApproval` (`store.ts:1629`)      | `recordApproval` (`store.ts:4711`)                  |

Both are written in one transaction by `gateApproval` (`tools.ts:133-195`). The
authoritative one is what downstream verifiers read.

### 1.4 The full control flow

```
create_work_item / JC lane / DC lane
  └─ evaluateAndRecordPolicy(..., "create")      tools.ts:73
       └─ classifyPolicyRisk                    rules.ts:36   (first match wins, 24 rules)
  └─ applyPolicyStatus                            tools.ts:103
       deny            → blocked
       require_approval→ pending_policy → needs_approval
       allow           → pending_policy → approved

human: POST /work-items/:id/approve  { reason, actionHash }   server.ts:2605
  └─ requireMutationActor(..., "acs:approve")                server.ts:2607
  └─ gateApproval                                           tools.ts:118
       └─ re-evaluate with operation = "approve"   ← self-approval now denies
       └─ const hashes = [parsed.actionHash]        tools.ts:151   ← ONE hash per call
       └─ recordApproval + grantExecutionPlanApproval (same txn)

worker: claim_next_approved_work_item                        tools.ts:248
  └─ re-evaluate policy on CURRENT content                   tools.ts:269
  └─ admitExecutionPlan
  └─ for EVERY required evaluation: getExecutionPlanApproval
  └─ leaseAttempt(approvalId, additionalApprovals: rest)      store.ts:1889
       └─ SQL trigger attempt_lease_approvals_binding_guard  migration 018
       └─ SQL trigger attempt_lease_approvals_consume        migration 018

privileged_exec
  └─ authorizeJaceCommanderExecution                         jace-commander.ts:441
       re-derives everything; requires lease.approvalId
  └─ SqliteJaceCommanderIssuanceRegistry.recordIssuance
       durable row commits BEFORE the signature is produced
```

### 1.5 The set mechanism already exists

`attempt_lease_approvals` (`018_attempt_lease_approvals.sql`) is a join table
carrying **many** approvals per lease, and `issueLeaseInputSchema.additionalApprovals`
accepts up to 64. `gateWorkerClaimInTransaction` (`tools.ts:293-336`) already requires
that _every_ policy-required action hash has a bound, granted plan approval before it
will lease, and passes the extras through `additionalApprovals`.

So the multi-operation approval fan-out is already built and enforced. The migration
header says so explicitly:

> _"A plan with multiple approval-required actions needs every required approval
> represented in, and atomically consumed by, the same lease's authority — not just
> the first one."_

### 1.6 The actual gap

`tools.ts:151` — `const hashes = [parsed.actionHash]` — a single approve call grants
exactly one action hash. A reviewer must therefore click approve N times for N actions.

Everything downstream already tolerates N. **The missing piece is one human act
producing N grants, plus a reviewable artifact of what those N grants cover.**

### 1.7 Rate limiting is not per-route

`server.ts:386` applies one global sliding window. The `{ config: { rateLimit } }`
objects on individual routes are declarative and never read by the `preHandler` at
`server.ts:696`. Every rate-limited route effectively gets 120 req / 60 s. New routes
must be added to `isRateLimitedRoute` (`server.ts:3535`) to be limited at all.

### 1.8 Two divergent "known action kinds" lists

`rules.ts:180 SUPPORTED_ACTION_KINDS` (24 entries) and `contracts.ts:126
isUnknownActionKind`'s hardcoded set (12 entries) disagree. `privileged.exec` is in
the first and not the second.

### 1.9 Pre-existing red tests on this base commit

`npm run check` fails on unmodified `a4f636e`. Recorded so it is not mistaken for
regression: `state-machine` migration-count (expects 36, code has 37), `database-health`,
`database-backup-policy`, `render-golden`, and the Hermes CLI interop test.

---

## Part 2 — Design

### 2.1 Core decision: the bundle is a review layer, not a second authority

A bundle does **not** introduce a new authorization substrate. It is a versioned,
hashed, reviewable grouping of proposed changes that, when approved, mints the
**existing** `execution_plan_approvals` rows — one per covered change — in a single
transaction, and then reuses `attempt_lease_approvals` exactly as before.

```
bundle revision --approve--> execution_plan_approvals (one row per change)
                                    |
                          attempt_lease_approvals (existing trigger)
                                    |
                          lease.approvalId + additionalApprovals
                                    |
              authorizeJaceCommanderExecution (existing, unchanged)
```

Consequences:

- Every existing invariant still holds. Nothing downstream was taught a new concept.
- `idx_jc_capability_one_per_approval` and the one-time-use consumption semantics are
  preserved, because there is still one approval row per action.
- A bundle cannot authorize anything the policy engine would not already fingerprint.

### 2.2 Coverage is defined by the existing action hash

`approvalCoverage()` answers `authorization.covers(operation)` by re-deriving the
operation's `actionHash` with the _same_ `actionFingerprint` the policy engine uses,
then requiring that exact hash to be covered by a granted, unexpired, non-invalidated
approval belonging to an approved bundle revision bound to the same work item and plan.

This is deliberate. It means:

- No substring or prefix matching is ever used for scope. A covered change is one
  `actionHash`, byte for byte.
- `actionFingerprint` already binds `requester`, `risk`, `kind`, `description`, `params`,
  `command`, `cwd`, `paths`, `write`, `network`, `destructive`. Changing any of them
  changes the hash, so the operation is no longer covered and fails closed.
- Because `actionFingerprint` excludes `workItemId`, the bundle binding supplies
  work-item scoping separately — a bundle for mission A cannot cover mission B even
  when the action content is identical.

### 2.3 Canonical manifest

`canonicalApprovalManifest(revision)` produces a strict canonical JSON document
containing every authorization-relevant field, hashed with
`domainHash("acs:approval-bundle-manifest:v1", ...)`.

`strictCanonicalJsonV1` (`packages/shared/src/strict-canonical-v1.ts`) is reused rather
than `canonicalJson`, because it _throws_ on `undefined`, non-finite numbers, symbols,
cycles, accessors and non-plain objects. A manifest that cannot be canonicalized cannot
be hashed, and therefore cannot be approved. Key order is normalized by the serializer,
so insertion order cannot affect the hash.

The manifest covers: schema version, bundle id, mission/execution/agent, revision,
title, rationale, each change's id/type/summary/target/command/risk/dependencies/
metadata, the scope block, and the base state. It deliberately excludes `status`,
timestamps, approval decisions and the manifest hash itself — those are lifecycle
bookkeeping, not authorization.

### 2.4 Revisions and delta

Revisions form an immutable chain via `parentManifestHash`. `approvalDelta(previous,
next)` classifies each change in `next` against `previous` by **comparing manifest
change digests**, not ids:

| Class       | Meaning                             | Requires approval |
| ----------- | ----------------------------------- | ----------------- |
| `unchanged` | identical digest                    | no                |
| `modified`  | same id, different digest           | **yes**           |
| `added`     | digest not present in previous      | **yes**           |
| `removed`   | present in previous, absent in next | no (narrowing)    |

This is what makes "approve only the delta" safe: an unchanged change keeps its prior
grant, and a modified or added change cannot inherit one, because its digest is part of
the new manifest hash and the grant is bound to the manifest hash it was issued under.

### 2.5 Partial approval and dependencies

`approveSelected` validates the selection before granting anything:

- A change may not be approved if any of its transitive `dependsOn` entries are not
  themselves approved in this decision. Rejecting a dependency leaves the dependent
  non-executable; the API refuses rather than silently widening.
- A change may not be approved if policy currently denies it. Policy Gate stays
  authoritative; a bundle cannot override a deny.

### 2.6 TOCTOU

`baseState` binds a revision to `gitSha` and `configHash` when supplied. The active
grant records the base state observed at approval time; `activeGrantCovers()` reports
`base_state_changed` when the live value differs, which the executor treats as not
covered. Anything materially relevant that changes after approval invalidates the
grant for that operation.

### 2.7 Approval strategies

Implemented in `packages/policy-gate/src/approval-strategy.ts` and persisted on the
canonical `execution_mode_state` row as a separate, defaulting column.

| Strategy            | Behaviour                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PER_ACTION`        | Default. Unchanged existing behaviour; every privileged action approved independently.                                                                    |
| `BUNDLE`            | Privileged actions accumulate into a bundle and are approved together.                                                                                    |
| `POLICY_AUTONOMOUS` | Executes without human approval **only** where `evaluatePolicy` already returned `allow`. `require_approval` still requires a human; `deny` still denies. |

`POLICY_AUTONOMOUS` is not "allow everything". It is exactly "treat an explicit
policy allow as sufficient", and the mode is fail-closed on a missing or corrupt row.

### 2.8 JEV

Unchanged. `jev-shadow.ts` returns `Promise<void>`, swallows its own errors, and is
`void`-ed at its single call site. No bundle code reads JEV output, and no JEV code
can reach bundle state. `approval-bundles` has no dependency on `jev-advisor`.

### 2.9 Compatibility

- New tables only. No existing table is altered, so no existing row or consumer is
  affected.
- `execution_mode_state` gains a nullable `approval_strategy` column with
  `DEFAULT 'PER_ACTION'`, so every existing deployment keeps today's behaviour.
- `PER_ACTION` never constructs a bundle; the existing `POST /work-items/:id/approve`
  path is untouched and remains the route used in that mode.
- Existing audit consumers keep working: new events are additive.
