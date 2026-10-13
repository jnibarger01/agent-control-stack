# Governed coding missions

How to run a coding mission under the dispatch authority gate. Governed execution is **off by default**. Nothing here has
been deployed; this describes what the code does and what an operator must set up.

## What it guarantees

A governed mission's executor is never called unless, at that moment, ACS can verify from durable state and its own clock that:
the mission is bound to a human-issued grant that is intact, unrevoked and unexpired; the work item the grant approves is
still non-terminal and unchanged; the worker resolves to the actor the grant names; the lane and tool are granted; the
attempt is within the grant's limit; and the audit chain verifies. Anything else is a refusal that runs nothing.

## One-time setup per worker

1. A human operator registers an `AGENT` or `SERVICE` actor for the worker with `externalRef` `worker:<workerId>`, where
   `<workerId>` is the id Nimble routes to (a registry agent id), using `POST /actors` with the operator's credential.
2. That registration is the identity binding. If anyone else registers or overwrites that actor, the worker stops resolving
   until an operator registers it again. There is no fallback to the worker id.

## Per mission

1. Create the work item that represents the approved work. **The coding mission id must equal the work item id**, and the
   grant must be issued for that id.
2. A human issues an authority grant (`/work-items/:id/authority-grants`) naming the executing actor from step 1, the tool
   classes (the `coder` lane needs a `sandbox` tool class), scope, `maxRuntimeMs`, attempt limit and expiry.
3. Create the coding mission (`POST /coding-missions`). It plans, then waits with code `authority_required`.
4. A human operator binds the grant: `POST /coding-missions/:id/authority` with `{ "grantId": "..." }`. On success the mission
   runs to the human approval boundary in the same request.
5. Inspect it any time with `GET /coding-missions/:id/authority-graph`.

## Enabling

Set `ACS_CODING_MISSION_GOVERNED=1` (exactly `1`) on the gateway. The gateway and the mission store must use one database
file. Without the flag, coding missions behave exactly as before. Enabling it for a deployed gateway is a release action, not
part of the source change.

## When it refuses

A refusal after binding returns the unit to `pending`, records `authority.denied` with the reason, and degrades the mission
with `dispatch_authority_denied`. Reasons include `grant_revoked`, `authority_expired`, `grant_subject_changed` (the work item
changed or is terminal), `worker_not_authorized_for_authority`, `lane_not_permitted`, `tool_not_permitted`,
`attempt_limit_exceeded`, `audit_integrity_failed`. Binding is write-once, so a revoked or expired mission is finished; create
a new mission and grant.

An executor that runs past the deadline is signalled to stop and the outcome is recorded as uncertain. It is not retried
unless the executor reports the operation absent and can fence the old run or is declared idempotent; otherwise a
`recovery_unsafe` escalation is recorded for an operator.

## Known limits

- Only the `coder` lane runs; `mcp` is never authorized, and `jc`/`dc` have no production driver yet.
- Each dispatch may cost a full audit-chain verification; unmeasured on a large database.
- Binding is done over HTTP by a human operator; there is no Mission Control control for it yet.
