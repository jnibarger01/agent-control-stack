# Agent dispatch from Mission Control

For approved Change Sets executed through ACS policy, scheduler, capabilities and
leases, use [governed mission dispatch](governed-mission-dispatch.md). The CLI path
below uses each CLI’s own permissions and does not govern its internal tools.

Run your installed CLI coding agents from Mission Control's **Dispatch** page. Design and limits:
[ADR 0022](../adr/0022-human-authorized-agent-runs.md).

## Enable

Set these on the gateway and restart it. Dispatch stays off until both are set.

| Variable                       | Meaning                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ACS_AGENT_DISPATCH_ENABLED=1` | Turns dispatch on.                                                                                                                                           |
| `ACS_AGENT_REPO_ROOTS`         | Colon-separated directories. A run's repository must be a git repo inside one of them. The page suggests the repos directly under each root.                 |
| `ACS_AGENT_RUN_MAX_CONCURRENT` | Active runs allowed at once. Default 3, range 1 to 16.                                                                                                       |
| `ACS_AGENT_WORKTREE_ROOT`      | Where run worktrees go. Default `~/.acs/agent-worktrees`. Keep it outside your repos.                                                                        |
| `ACS_AGENT_GUARD_URL`          | Optional. Gateway base URL (https, or http on loopback) so ACS decides and audits each Claude tool call. Unset: the guard enforces its local deny-list only. |
| `ACS_AGENT_RUN_OUTPUT_ROOT`    | Where redacted output is kept. Default `~/.acs/agent-runs`.                                                                                                  |

The gateway process also needs to find the CLIs. A systemd user service starts with a bare `PATH`, so add the
directories that hold them (for example `~/.local/bin` and the Homebrew `bin`) to the unit's `Environment=PATH=...`.
If a CLI is missing from the gateway's `PATH`, the roster shows `executable_not_found` and Dispatch shows it as
not installed.

## Roster heartbeats

The gateway re-probes each CLI (`<cli> --version`) every 60 s and refreshes its heartbeat, so the roster stays
**online**. `ACS_ACTOR_DISCOVERY_INTERVAL_MS` changes the cadence; `0` turns the loop off, after which agents expire to
offline once the 15-minute heartbeat TTL passes.

Sign in to Mission Control with a human operator credential (`actor: user`, `operator` role, `acs:approve`).
Click **Add to roster** once to list the CLIs under Agents.

## Use

1. Open **Dispatch**. Each card shows whether the CLI is installed, its version, whether a login was found, and
   whether it can be dispatched. **Test connection** sends a harmless prompt to prove it works.
2. Pick an agent, repository and mode, describe the task, and choose **Review & dispatch**.
3. Read the confirmation (mode, repository, branch, containment, prompt, command hash) and confirm.
4. Watch the run. Output refreshes live and is redacted. **Cancel run** stops the process group.
5. A finished run shows what ACS verified (`resultCheck`) and, if it succeeded, is **pending review**. Accept or
   reject it with `POST /api/agent-runs/<id>/review` (`{"decision":"accept"|"reject","note":"..."}`, human operator
   only). A confirmation expires after 10 minutes and works once: submitting it again returns the same run.
   An exit code of 0 is not enough to succeed: see [ADR 0024](../adr/0024-governed-agent-run-lifecycle.md).
6. Review the result on the run's branch: `git -C <worktree path> diff`. ACS never merges or pushes it.
   Remove a finished worktree with `git worktree remove <path>` and delete its `acs/agent/*` branch.

## Status of the nine CLIs

Verified by real runs on 2026-10-02 (versions in `packages/agent-cli/src/catalog.ts`).

| CLI          | Dispatchable | Notes                                                                                               |
| ------------ | ------------ | --------------------------------------------------------------------------------------------------- |
| claude       | yes          | `--permission-mode acceptEdits` (edit) or `plan` (read-only).                                       |
| codex        | yes          | `exec --sandbox workspace-write` or `read-only`.                                                    |
| opencode     | yes          | Read-only uses the `plan` agent.                                                                    |
| hermes       | yes          | Edit only. Slow to start (about 25 s).                                                              |
| cursor-agent | yes          | `--trust` marks only the new worktree trusted. `ask` mode is read-only.                             |
| gemini       | blocked      | Google rejects the account (IneligibleTierError). Sign in with a supported account or key.          |
| cline        | blocked      | Needs re-authentication: run `cline` and sign in.                                                   |
| goose        | blocked      | Provider returns 401 Invalid API key (and still exits 0). Run `goose configure`.                    |
| openclaw     | blocked      | `agent exec` crashes while the OpenClaw Gateway owns its state dir; `--isolated` loses credentials. |

A blocked reason is stored in the catalog (`dispatchBlockedReason`). After you fix the cause, use **Test
connection**; if it passes, remove the reason from the catalog in a PR.

## Safety notes

- Edit mode lets the CLI change files in its worktree under its own permission rules. Cline and Hermes run
  their own tools without ACS-level gating. Read the containment line in the confirmation.
- Claude Code runs also carry the ACS tool guard (ADR 0024): every tool call is logged and a deny-list blocks writes
  outside the worktree, `git push`, network and privilege tools. It is not a sandbox, and no other CLI has it.
- The CLI uses your real `HOME` and saved logins. It does not receive `ACS_*` variables or unrelated tokens.
- Everything is in the audit log under `agent_run.*`. Prompts are kept in `prompt.txt` beside the output, not in
  the audit log; only a hash and a redacted 240-character preview are.
