# ADR 0024: Agent runs get a governed lifecycle; Jev stays out of it

## Status

Accepted. Extends [ADR 0022](0022-human-authorized-agent-runs.md); does not change
[ADR 0020](0020-jev-advisory-only-evidence.md).

## Context

An assessment of the E2E "Jev authority and dispatching" chain found two separate things that must not be
confused:

- Jev produces advisory evidence and is forbidden from approving, issuing capabilities, choosing executors or
  changing work-item state (ADR 0020).
- Mission Control dispatch starts human-confirmed CLI runs (ADR 0022). Those runs have no work item, plan, lease or
  approval record, so ACS authority over _what the CLI does_ is limited to the worktree and the CLI's own
  permission mode.

ADR 0022 left five lifecycle gaps that can be closed without changing the plan contract: a confirmation never
expired and could be replayed, duplicate submissions raced, a late result could overwrite an interrupted run, exit
code 0 was reported as success, and nothing recorded a human accepting the result.

## Decision

All of this lives in `AgentRunService`; the plan contract, worker and scheduler are untouched.

- **Confirmations are issued, single-claim and expiring.** `preview` records the confirmation hash for the
  operator it was issued to. `dispatch` is refused unless that operator previewed that exact command on this
  gateway in the last 10 minutes (`agent_confirmation_unissued`, `agent_confirmation_expired`). The hash still binds
  agent, mode, repository, time limit and prompt.
- **Duplicate dispatch is idempotent.** The first dispatch of a confirmation claims it synchronously. A repeat
  returns the same run, including after it finished, and re-previewing an identical claimed request does not
  reopen it. A capacity refusal does not consume the confirmation.
- **Runs are fenced.** Each run has an owner token written to `agent_run.requested`. `started` and `finished` are
  applied only when they carry it, and a terminal state (`interrupted`, `cancelled`, finished) is final. A late or
  forged result cannot overwrite a run that was already reconciled.
- **Exit 0 is not success.** After the run, ACS inspects the worktree and `assessResult` decides the outcome:
  - read-only run that changed the worktree: `failed` (`unexpected_changes`);
  - worktree could not be inspected: `failed` (`inspection_failed`);
  - no changes and output reading as an auth or provider failure (the goose 401-with-exit-0 case): `failed`
    (`failure_signature`);
  - otherwise `succeeded` with `changes_present` or `no_changes`.
    The CLI's own report is kept as `reportedOutcome` in the audit event.
- **Success needs review.** A `succeeded` run is `pending_review` until a human operator calls
  `POST /api/agent-runs/{id}/review` with `accept` or `reject`, recorded as `agent_run.reviewed`. Nothing is
  promoted either way; this records the decision and gates anything that later reads it.
- **Jev is not on this path.** `agent-runs.ts` and `agent-routes.ts` do not import or mention Jev, and a test
  fails if they do. Disabling, degrading or poisoning Jev therefore cannot change dispatch.

## Addendum: restart recovery and the governed path

- **Orphan handling.** The runner's pid and Linux process start time are recorded (`agent_run.process_started`).
  On gateway start, a run left active is marked `interrupted`; if its process is still alive and the pid and
  start time still match, the process group is terminated, because it is no longer under any authority. A process
  that cannot be verified is left alone and the reason says so. ACS never signals a pid it cannot prove is its own.
- **Governed execution has its own path.** Mission Control's mission dispatch
  ([runbook](../runbooks/governed-mission-dispatch.md)) schedules an approved Change Set through the existing
  mission runner: policy, approval, operation permit, scheduler admission, capability and fenced lease. That
  covers work item, lease and result validation for governed DC/JC execution. It deliberately does not launch
  CLIs, so the plan contract is unchanged.
- **Jev.** Neither dispatch path references Jev, and a test runs mission dispatch with Jev disabled, down and
  adversarial and requires identical results and zero calls to the advisor.

## Not done: the remaining authority gap

These need their own design and are deliberately out of this change:

1. Host-side CLI runs still create no work item, execution plan, lease or approval record. Only the governed
   mission path above does.
2. After start, the CLI's own tool calls are not routed through ACS. Containment is still the CLI's permission mode
   plus the worktree.
3. Reconciliation terminates a surviving process rather than re-adopting it and its output.
4. Jev observations are not correlated to run or action IDs, because Jev is not consulted for runs at all.

Until (1) and (2) land, ACS must not claim it governs everything an agent does.

## Rejected alternatives

- **Time-bound hash (expiry inside the hash).** Would change the preview/dispatch API and the UI for no extra
  security over a server-held issued record.
- **Mark a no-change edit run as failed.** An agent may legitimately answer a question; `no_changes` is reported and
  left to the reviewer.
- **Let Jev score run results.** Violates ADR 0020: advisory evidence must not decide an outcome.
