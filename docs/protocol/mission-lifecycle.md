# Mission lifecycle

ACS is the durable source of truth for an autonomous mission. The mission
runtime does not replace work items, actor routing, execution admission, or
approval records. It persists the mission aggregate beside them and advances
only from those records.

## Previous lifecycle

Before this lifecycle, ACS authorized one work item at a time:

```text
work item -> policy -> approval -> attempt lease -> executor -> attempt result
```

Execution plans were ordered steps on a single work item. Nothing persisted a
mission-level dependency DAG, change set, deployment, or production
verification, and a lost executor response was not a first-class unknown
outcome.

## Authoritative lifecycle

```text
PLANNED
  -> RUNNING
  -> WAITING_FOR_RESULT | WAITING_FOR_RECONCILIATION
  -> READY_FOR_CHANGE_SET
  -> WAITING_FOR_APPROVAL
  -> APPROVED
  -> APPLYING
  -> VERIFYING_PRODUCTION
  -> COMPLETED
```

Operation verification uses the operation status `VERIFYING`. The mission stays
`RUNNING` while those checks are recorded. `VALIDATING` remains a legal
mission status for a caller that has already gathered validation evidence and
needs to move toward a change set or completion. The runner does not enter it
on the ordinary path.

`FAILED`, `CANCELLED`, and `BLOCKED` are the other terminal or held states.
`APPROVED -> WAITING_FOR_APPROVAL` is the only return edge, and it is used
only when the proposed mutation is superseded. That supersession invalidates
the previous change set. An approval binds to one change-set hash through
`approval_records` (`action_hash` is the change-set hash) and
`mission_approvals`. A different hash is not approved.

Operation readiness is derived by `deriveMissionProgress` from persisted
dependency results. A completed operation cannot change status. Dispatch uses
a stable execution id (`acs:mission-execution:v1` over mission and operation).
A timeout or lost response becomes `UNKNOWN` and is reconciled before another
dispatch. Mutation-class operations are `fail_closed` when the executor state
cannot be established.

Completion is rejected until required operation results, verification,
change set, approval, application, deployment health, and production
verification are durable. Calling completion again does not append another
`mission.completed` event.

## Restart

`resumeOpenMissions` reads non-terminal missions and calls `advance`. The
worker invokes that hook through `resumeMissions` before it claims the next
work item. Expired claims become ready when dispatch was never persisted, and
become `UNKNOWN` when dispatch was persisted and the result was not.

## Acceptance

```bash
npm run acceptance:mission-runtime
```

The command runs the lifecycle against a temporary SQLite database. It does
not deploy or mutate a production target.
