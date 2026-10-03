# ADR 0022: Mission Control dispatches CLI agents as human-authorized agent runs

## Status

Accepted.

## Context

The operator wants to start their installed coding-agent CLIs (Claude Code, Codex, OpenCode, Hermes,
Cursor Agent and others) from Mission Control. Two existing paths cannot do it:

- The worker and execution-plan path fixes `network: "none"` and two backends (`dry_run`,
  `desktop_commander`) in the hash-bound plan contract. A coding agent needs its model API, so running it there
  would mean changing that contract.
- Engine isolation (ADR 0014) gives each run a private empty `HOME` and exactly one injected API key. These CLIs
  are signed in with saved logins, not API keys, so they would start unauthenticated.

## Decision

Add a separate, narrow path: an **agent run**. It does not touch the plan contract.

- Only an authenticated human operator (`actor: user`, `operator` role, `acs:approve`) can preview, dispatch or
  cancel a run. Agent, worker and service credentials cannot.
- Dispatch is two steps. `preview` validates the request and returns a hash over agent, mode, repository, time
  limit and prompt. `dispatch` is refused unless it carries that exact hash, so the command the operator
  confirmed in the dialog is the command that runs.
- Off by default. The gateway needs `ACS_AGENT_DISPATCH_ENABLED=1` and `ACS_AGENT_REPO_ROOTS`; a repository must
  resolve (by `realpath`) inside an allowed root.
- Every run gets a fresh `git worktree` on its own branch outside the repository. Nothing commits, merges,
  pushes or promotes; the result is a branch for a human to review.
- The CLI runs host-side with the operator's real `HOME` so saved logins work. Its environment is a small base
  plus that CLI's own provider variables; `ACS_*` secrets and unrelated tokens are not passed.
  Containment is the CLI's own sandbox or permission mode plus the worktree. ACS does not claim more, and the
  confirmation dialog states what each CLI enforces.
- Runs are recorded in the hash-chained audit log (`agent_run.requested|started|finished|cancel_requested|
interrupted`) and rebuilt from those events. No migration. Output is redacted line by line and stored
  outside the database with `0600` permissions.
- A concurrency cap (`ACS_AGENT_RUN_MAX_CONCURRENT`, default 3) and per-run timeout bound resource use. Runs
  recorded as active by a previous gateway are marked `interrupted` on startup.
- A CLI that cannot be dispatched today (not installed, or a verified failure such as an expired login) is
  refused with its specific reason rather than failing mid-run.

## Governed mission dispatch

Mission Control also exposes a separate [governed mission dispatch](../runbooks/governed-mission-dispatch.md)
path for existing approved Change Sets. It schedules the existing worker mission
runner, which uses ACS operation permits, scheduler admission, capabilities,
leases and validated results. It does not make these host-side CLI runs governed
or allow Jev to grant authority.

## Consequences

- Admin ("YOLO") mode has no role here: dispatch is always a human click, and a run never approves anything.
- This is weaker containment than Bubblewrap engine isolation. If stronger containment is wanted later, move a
  CLI onto engine isolation once it can authenticate with an injected credential.
- Agent runs are not work items: they have no lease, plan or approval record, and do not appear in the work
  queue. They appear in the Dispatch page and the audit log.

## Rejected alternatives

- **Extend the execution plan with a third backend and network access.** Changes a hash-bound authority
  contract and every consumer of it for one feature.
- **Engine isolation with copied login files.** Loses token refresh and needs each CLI's auth layout verified.
- **Let agents dispatch other agents.** Out of scope; the point is a human operating the control plane.
