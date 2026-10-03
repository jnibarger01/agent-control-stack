# Governed mission dispatch from Mission Control

Mission Control's **Execute an approved mission** form schedules an existing,
immutable Change Set for the existing ACS worker. It does not launch a CLI,
create approval, choose an executor, or bypass policy. Jev remains advisory-only
([ADR 0020](../adr/0020-jev-advisory-only-evidence.md)).

## Prepare and enable

1. Create a mission and submit its Change Set through the existing work-item
   endpoints. The Change Set binds the executing actor, operations, scope,
   dependencies, expiry, and verification requirements.
2. Approve the exact snapshot through `/work-items/:id/change-sets/approve` as
   a human operator. This dispatch surface accepts human bundle approvals;
   grant-driven execution remains available through the existing mission runner.
3. Configure `ACS_MISSION_DISPATCH_ENABLED=1` on both gateway and worker.
   On the worker, configure `ACS_MISSION_EXECUTING_ACTOR_ID` to the snapshot's
   executing actor and the existing mission client settings:

   - `ACS_MISSION_GATEWAY_URL`: HTTPS origin or loopback HTTP origin.
   - `ACS_MISSION_GATEWAY_TOKEN`: credential bound to the executing actor, with
     read/write access to its mission. This is separate from human approval.
   - `ACS_MISSION_DC_MCP_URL` and `ACS_MISSION_DC_MCP_TOKEN`, and/or
     `ACS_MISSION_JC_MCP_URL` and `ACS_MISSION_JC_MCP_TOKEN`: managed runtime
     endpoint and its independently authenticated credential.

   Missing configuration fails closed. Credentials never enter the dispatch
   request, plan, receipt, or audit body. Use the existing worker service/timer
   ([ADR 0013](../adr/0013-systemd-timer-worker-invocation.md)); no new daemon is
   required. Gateway opt-in alone does not prove a worker is configured or active.

## Dispatch and monitor

Open **Dispatch**, enter the mission and approval identifiers, and choose
**Review mission**. The UI fetches the current snapshot and displays the objective,
executor, tool operations and approval expiry. **Confirm execution** submits the
exact reviewed binding. Editing the form invalidates the confirmation.

The API returns `202` for an accepted scheduling receipt, not execution success.
Duplicate submissions for the same mission snapshot and approval return the same
receipt, including after database reopen. **Refresh mission progress** reads
canonical Change Set progress and reports stale or revoked bindings separately.

The worker and gateway must use the same canonical control-plane database.
Planned runtime configuration is checked before requesting any operation permit.
Running or reviewing missions do not prevent later ready missions from being
considered in a worker tick.

The worker reconstructs requests from the hash-chained audit ledger and takes one
existing mission-runner tick per eligible mission, at most ten advanced missions
per invocation. Every operation still requires current policy and approval,
operation permit, scheduler admission, runtime capability and fenced execution
lease. Accepted results and declared verification determine completion. A worker
restart reconstructs progress instead of replaying a local cursor. Failed,
blocked or uncertain operations stop for reconciliation; they are never
automatically retried. Approval expiry/revocation and snapshot amendments fail
closed at the existing authority endpoints, even after scheduling.

`mission.dispatch.requested` is an idempotent scheduling receipt.
`mission.dispatch.observed` records worker observations. Neither is a second
approval, lease, authoritative result, or lifecycle store. The existing
Change Set, attempt, lease and result records remain authoritative.

## Limits

- This does not convert arbitrary prompts into executable plans. A submitted,
  approved Change Set must exist first.
- DC and JC remain the governed execution runtimes. Registering a CLI in the
  roster does not make that CLI an ACS-governed tool adapter.
- The separately labelled **Host-side CLI run** retains ADR 0022's weaker
  containment and saved-login behavior. It does not route every internal CLI
  tool through ACS. Migrating those nine agents requires verified tool adapters
  and appropriate isolation/credential delivery, not a dispatch flag.
- Production enablement, service changes, and release cutover are separate
  operational actions. Source changes alone do not alter the deployed release.
