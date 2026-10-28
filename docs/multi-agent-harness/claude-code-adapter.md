# Claude Code Adapter Specification (`harness-claude-adapter`)

Status: **Proposed. Not implemented.** Implements `harness.adapter.v1` from the [ACS integration contract](acs-integration-contract.md) §10. Evidence tags: **[V]** verified by reading this checkout; **[P]** proposed; **[U]** unverified, must be probed in task T0 before it is relied on.

## 1. Purpose and honest scope

Run the `claude` CLI as an untrusted agent process under ACS authority, translate its output into `RunEvent`s, gate its tool calls through ACS, cancel it truthfully, and reconcile it after failure.

Non-goals: modifying or wrapping Claude Desktop; using undocumented Claude endpoints; depending on internal agent-loop behavior the investigation did not recover. The adapter uses only the documented CLI surface, and anything it needs beyond what this repo already exercises is probed first (T0).

### Governance levels the adapter may claim

Reuses the ADR 0024 vocabulary [V] so the UI and audit stay consistent.

| Level                               | Meaning for Claude Code                                                                                                                                                                                | Milestone |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `acs_guarded`                       | Native tools allowed. A `PreToolUse` hook asks ACS to decide each call (fail closed). Claude runs in a fail-closed sandbox on an isolated worktree. The hook is a deny-list over Bash, not a boundary. | **M1**    |
| `governed`                          | Native tools disabled. Every effect is an MCP call to the ACS bridge using `acs.jc.v1`/`acs.dc.v1` capabilities. Containment is by construction, not pattern.                                          | M2 [P]    |
| `os_sandboxed` / `host_permissions` | Not offered. The adapter refuses to run without a sandbox.                                                                                                                                             | n/a       |

M1 is the default recommendation (PRD open question 1). The adapter must never report `governed` until M2's conformance and bypass tests pass.

## 2. What the repo already establishes and what it does not

| Fact                                                                                                                                                                                                                                                                               | Source                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| The repo already drives `claude` with `-p --output-format json --model --safe-mode --tools "" --permission-mode plan --disable-slash-commands --no-session-persistence --max-budget-usd --system-prompt --json-schema` and a deny-by-default env allowlist                         | `harness/claude-cli-provider.ts` [V]                                                                        |
| ADR 0024 installs a Claude `PreToolUse` hook through `--settings`, logs each call to `tool-calls.jsonl`, denies writes outside the worktree, credential reads, `git push`, network, privilege escalation; asks ACS per call at `POST /api/agent-runs/:id/tool-check`; fails closed | ADR 0024 "Addendum" [V]; `packages/agent-cli/src/tool-guard.ts`, `apps/gateway/src/agent-runs.ts` exist [V] |
| `engine-adapter` runs CLI engines under `EngineIsolation` (authority-bound workspace mount, private `HOME`, one injected credential, scoped egress) but returns one terminal outcome, with **no per-call visibility**                                                              | `packages/engine-adapter/src/types.ts` doc comment [V]                                                      |
| Claude Desktop's own approval gate location is unknown and its config uses a permission bypass                                                                                                                                                                                     | Slice 1 assessment §2 (REA, static analysis only) [L]                                                       |

Not established, to be probed in T0 [U]: the exact `--output-format stream-json` event shapes and ordering; whether a streaming input mode is needed; flags for MCP config isolation and for restricting setting sources; the `PreToolUse` hook payload and decision schema in the installed version; session id availability; how a permission bypass is represented in effective config across user/project/managed settings; exit codes and signals for budget, timeout and auth failure; version string format.

## 3. Launch

1. **Binary.** Absolute path, resolved once at startup and recorded; `spawn` with `shell:false`; never `PATH` lookup at run time. `claude --version` is recorded and checked against an allowlisted range (§5).
2. **Process group.** Started in its own process group/session so cancel can terminate the whole tree. Pid and process start time are recorded in a run record (ADR 0024 orphan rule [V]).
3. **Environment.** Deny-by-default allowlist, modeled on `claudeCliEnvAllowlist` [V] but **without** `ANTHROPIC_API_KEY` by default. Credential handling is decided by PRD open question 3; whichever is chosen, the test in §11 asserts the child environment and mounts contain no host credential file and no long-lived key beyond the decided mechanism.
4. **Home.** A private empty `HOME` inside the sandbox (ADR 0014 [V]). No copy or mount of `~/.claude/.credentials.json` or similar (the prior assessment flagged exactly this as a critical finding in the other worktree [L]; here it is a hard rule).
5. **Working directory.** The pre-created isolated git worktree on its own branch, outside the repository (ADR 0022 pattern [V]). The adapter never creates, commits to, merges or pushes branches.
6. **Isolation.** Through an injected `IsolationLauncher` port. Slice 1 binds it to `EngineIsolation`/Docker per ADR 0010 and 0014 [V]. A launcher that cannot provide a fail-closed sandbox makes `health()` return `unavailable`. bwrap host-root binds are not an acceptable launcher (prior finding S3 [L]); the port's conformance test forbids exposing host root or host unix sockets.
7. **Network.** `network: "none"` by default; if the model API must be reachable, only through an allowlisted audited proxy (ADR 0014 [V]); default egress for this provider is `api.anthropic.com:443` [V per `registry.ts`].
8. **Argv.** Built from a typed option set, never from a string. The prompt is a single argument or stdin, never interpolated into a shell.

## 4. Preflight and `health()`

`health()` runs these checks and returns `unsafe` if any safety check fails, `degraded` for non-safety problems, `unavailable` if it cannot run at all. It never throws and never includes secret values.

| Check                  | Fails when                                                                                                                                                                                                                                                     | Result                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `binary`               | Path missing, not executable, or not owned by an expected user                                                                                                                                                                                                 | `unavailable`                                  |
| `version`              | Outside allowlisted range                                                                                                                                                                                                                                      | `degraded`; `start` refuses unless allowlisted |
| `no_permission_bypass` | **Any** of: argv contains `--dangerously-skip-permissions` or `--allow-dangerously-skip-permissions`; effective settings from any source contain a bypass permission mode or `skipDangerousModePermissionPrompt`; the adapter's own option set requests bypass | **`unsafe`**                                   |
| `settings_sources`     | Effective settings cannot be fully enumerated or neutralized (see §5)                                                                                                                                                                                          | `unsafe`                                       |
| `hook_installed`       | M1 only: the ACS hook is not present in the effective settings or does not fail closed in a canary call                                                                                                                                                        | `unsafe`                                       |
| `sandbox`              | Launcher not available or fails its self-test                                                                                                                                                                                                                  | `unavailable`                                  |
| `credentials_absent`   | Child environment or mounts would contain a host credential file or a disallowed long-lived key                                                                                                                                                                | `unsafe`                                       |
| `gate_reachable`       | ACS gate unreachable                                                                                                                                                                                                                                           | `degraded`                                     |

Rule (INV-6): the adapter **refuses** unsafe configuration. It does not override the user's settings to make a run work, and it does not tolerate a bypass "because the sandbox is on". The bypass names above come from the Claude Desktop investigation [L]; the exact set of keys and flags in the installed CLI is a T0 output, and the check list must be regenerated from it.

## 5. Configuration identity and settings isolation

`adapterConfigHash` = sha256 over a canonical record of: resolved binary path and version; the full argv minus the prompt; the effective settings after isolation (hooks, permission mode, allowed/denied tools, MCP servers); sandbox profile id and mount list; egress allowlist; model; limits. It goes into `RunBinding` and, once G2 lands, into the approved action hash and the per-call invocation hash. A change to any of those changes the hash and invalidates outstanding approvals.

Isolation of settings: the adapter passes an explicit settings object and must prevent user, project and local settings files from changing effective behavior. T0 determines the supported mechanism (a flag restricting setting sources, a private `HOME`/config dir, or both). If no mechanism is verified, the adapter relies on the private `HOME` plus a config scan and `health()` returns `unsafe` whenever a project-level settings file exists in the worktree that it cannot account for.

## 6. Event translation

Provisional mapping, to be finalized from recorded fixtures (T0, T9). Shapes marked [U] are the expected stream-json form, not verified.

| Claude output (expected [U])                   | `RunEvent`                       | Notes                                                                                       |
| ---------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------- |
| System/init message (session id, model, tools) | `run.started` (adapter part)     | Session id stored as `adapterRunId`; tool list recorded and compared with the expected set  |
| Assistant text block (partial)                 | `message.delta`                  | Redacted before append                                                                      |
| Assistant message end                          | `message.complete`               |                                                                                             |
| Assistant `tool_use` block                     | `tool.requested`                 | Carries tool name, arguments hash, and redacted arguments                                   |
| Hook decision (from the ACS gate)              | `tool.decision` (`source:"acs"`) | Not translated from Claude output; emitted by the gate path with `auditRef`                 |
| User `tool_result` block                       | `tool.result`                    | Success/error flag, output hash, redacted truncated preview                                 |
| Usage/cost fields                              | `usage`                          | Tokens and cost; never used for authorization                                               |
| Final result message                           | recorded, not terminal           | Reported outcome kept as `reportedOutcome` in evidence, per ADR 0024 [V]; never sets status |
| Process exit                                   | `adapter.exited {code, signal}`  | Process fact only                                                                           |
| Anything unrecognized or schema-invalid        | `adapter.warning {hash, kind}`   | Never dropped silently; repeated invalid output beyond a threshold fails the run            |

`tool.requested` without a later `tool.result` or `tool.decision: deny` at exit means a tool call was in flight; this feeds `inFlightToolCalls` and `outcome_unknown`.

## 7. Tool gating

### M1 (`acs_guarded`)

1. ACS hook installed via explicit settings. Hook reads the per-run gate token from the `0600` file, computes `invocationHash` (contract §5.1), and posts to the attempt-keyed gate [P, G3].
2. Decisions: `allow` returns allow to Claude; `deny` returns deny with a reason Claude can read; `approval_required` blocks the hook (and emits `approval.requested` through the adapter's event path) until resolved or expired.
3. Fail closed: parse error, missing token, gate unreachable, timeout, lease lost, token past run end: deny.
4. Local floor retained (workspace-only writes, credential reads denied, no `git push`/remote changes/network/privilege escalation/publishing) as in ADR 0024 [V]. It can tighten, never loosen.
5. Per-run tool-call budget enforced at the gate [V pattern].
6. **Stated limit:** Bash is matched by pattern. The hook is not a sandbox. Containment of effects comes from the sandbox and worktree, and the run is labeled `acs_guarded`, not `governed`.

### M2 (`governed`) [P]

1. Claude started with native tools disabled (the repo already starts it with `--tools ""` for the provider path [V]); the only available tools are MCP tools from a per-run MCP config pointing at the ACS bridge, with MCP config isolation verified in T0.
2. The bridge issues `acs.jc.v1`/`acs.dc.v1` capabilities per call; executors verify offline and, once G4 lands, consume atomically.
3. Open: whether the bridge can carry a per-run actor identity so audit and self-approval rules apply to the right requester (JC takes `x-jc-actor` authenticated as `acs-jc-bridge` [V]); T0 or an ACS slice must answer.

## 8. Cancel and reconcile

**`cancel(runId)`** (called only after ACS has recorded the cancel or the harness is aborting for its own failure):

1. Gate switches to deny-all for this run.
2. Send the CLI's cooperative interrupt (SIGINT; behavior probed in T0 [U]); wait `graceMs`.
3. SIGTERM the process group; wait; then SIGKILL the group.
4. Verify no process in the group and no sandbox container remains. Compute `inFlightToolCalls` from the event log.
5. Return `terminated` only if step 4 holds; otherwise `unconfirmed` (core then records `outcome_unknown`).

**`reconcile(runId)`** is read-only: process liveness by recorded pid plus start time, sandbox container state, last event `seq`, tool calls without a result, workspace `git status` and diff hash versus `baselineHash`, and presence of the run's gate token file. It returns the verdict and evidence per contract §8. It never signals an unverifiable process.

## 9. Workspace, artifacts, limits

- Artifacts per run, `0600`, hashed, referenced by `artifact.created`: redacted transcript, `tool-calls.jsonl`, workspace diff, final report (agent's own, labeled as such).
- Diff and branch are for human review; nothing is promoted.
- Limits enforced: wall clock, max tool calls (at the gate), `--max-budget-usd` [V flag], max output bytes. Hitting a limit is `timed_out` or `failed`, never silently truncated success.
- `resume`: **not advertised** in Slice 1 (`resume: false`). The provider path runs with `--no-session-persistence` [V]; continuing a session is a later, separately specified capability because a resumed transcript can carry unreviewed state.

## 10. Capability report for Slice 1 (M1)

| Field                | Value                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------- |
| `governance`         | `acs_guarded`                                                                         |
| `isolation`          | `{ kind: "container", network: "allowlist" }` (or `"none"` if no model egress needed) |
| `streaming`          | `true` if T0 confirms incremental output, else `false` and the report says so         |
| `toolCallVisibility` | `per_call` only if hook plus stream both prove it in the conformance scenario         |
| `approvals`          | `blocking_gate`                                                                       |
| `cancel`             | `process_group`                                                                       |
| `resume`             | `false`                                                                               |
| `reconcile`          | `true`                                                                                |

## 11. Tests (all written before the code)

1. **Conformance suite** (shared) with a scripted fake `claude` executable: streaming, tool call, approval wait, exit paths.
2. **Bypass refusal:** each seeded bypass (argv, user settings, project settings, managed settings) yields `unsafe` and `start` throws; a clean config yields `ready`.
3. **Credential absence:** the spawned child's environment and mount list contain no host credential file and no disallowed key (assert on the actual spawn arguments).
4. **Translation:** recorded real output fixtures from T0 produce the expected events; unknown event types produce `adapter.warning`; malformed JSON lines do not crash the stream.
5. **Gate behavior:** unreachable, slow, malformed, expired-approval and swapped-argument cases all deny.
6. **Cancel tree:** a fake CLI that spawns grandchildren and ignores SIGINT is fully killed; `terminated` is not returned while any descendant lives.
7. **Reconcile:** `kill -9` of the adapter host mid-tool-call, restart, `reconcile` returns `still_unknown` or `effects_present` as the workspace dictates, never `no_effects_proven` with a changed worktree.
8. **Orphan safety:** a pid reused by an unrelated process is not signalled.
9. **Real-binary smoke** (opt-in, not in CI by default): one trivial read-only task through a real gateway, recorded in `slice-1-evidence.md`.

## 12. Known limits (stated so they are not claimed away)

- `acs_guarded` is weaker than `governed`: Bash is pattern-matched, so effects inside the sandbox on the worktree are contained, not individually authorized.
- The adapter cannot see inside tools that Claude runs in-process without a hook event; `toolCallVisibility` is reported per what the conformance scenario proves.
- Claude subscription logins live in host `HOME` and cannot be isolated; a run that needs them is out of Slice 1 unless PRD open question 3 grants an explicit, recorded waiver.
- Version drift: new CLI versions can change output and hook payloads. The version allowlist and fixtures make drift a failing test, not a silent behavior change.
