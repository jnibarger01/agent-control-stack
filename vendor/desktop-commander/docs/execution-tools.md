# Desktop Commander execution-plane tools

> **Desktop Commander mechanical capability does not imply caller authorization.**
>
> **Desktop Commander emits execution evidence. ACS remains the authority for approval,
> capability issuance, and policy decisions.**

These tools make Desktop Commander (DC) a better *execution/data plane*: bounded
primitives, explicit preconditions, structured errors and evidence. None of them
issues approvals, authorizes callers, or makes allow/deny decisions:

- In **managed mode**, every call still requires a per-call ACS capability, verified
  by `ManagedAcsGuard` against the exact bound arguments (acs.dc.v1
  `authorizationArguments`, see ACS `docs/protocol/dc-authorization-arguments.md`).
- In **standalone mode**, the pre-existing enforcement pipeline still applies. The new
  tools are classified like their existing counterparts: `run_command` argv goes through
  the same destructive/secret/network patterns and network-binary blocklist as
  `start_process`, and the mutating tools are classified as local writes.

`origin` (`"ui"|"llm"`) is accepted on every tool as transport metadata. It is never
part of the authorization arguments.

## Common result and error model

Success results are JSON text. Every result carries `_meta.dcExecution.requestId` and
`correlationId`. A correlation id is taken from `_meta.correlationId` or `_meta.requestId`
when the caller supplies one.

Failures return `isError: true` with
`{"error": {code, requestId, correlationId, stage, message, retryable, causeCategory, errno?, ruleId?, details?}}`.
Failures of existing tools keep their original first text item and gain a second item,
`{"dcError": {...}}`. Every failure is recorded for `last_error`. Messages are
secret-redacted and never include stack traces.

| code | meaning |
| --- | --- |
| `DC_INVALID_ARGUMENT` | schema/shape violation (strict schemas: unknown keys rejected) |
| `DC_PATH_OUTSIDE_ALLOWED_SCOPE` | resolved (symlink-free) path outside `allowedDirectories` |
| `DC_PATH_NOT_FOUND` | target missing |
| `DC_PATH_CHANGED` | target changed between validation and commit; nothing written (retryable) |
| `DC_HASH_MISMATCH` | supplied sha256 precondition failed; nothing written |
| `DC_HEAD_MISMATCH` | supplied git HEAD precondition failed |
| `DC_NOT_A_GIT_REPOSITORY` | repoPath is not in a work tree |
| `DC_PROCESS_NOT_OWNED` | pid is not a DC-spawned, tracked session |
| `DC_PROCESS_NOT_FOUND` | owned/recovered session no longer the same process |
| `DC_COMMAND_FORBIDDEN` | blocked by DC `blockedCommands` (argv[0] and resolved path) or `DC_NETWORK_PROFILE=none` |
| `DC_COMMAND_NOT_FOUND` | executable not found (no shell lookup) |
| `DC_TIMEOUT` | bounded operation timed out (retryable) |
| `DC_PATCH_REJECTED` | malformed, non-matching, ambiguous or multi-file patch |
| `DC_SNAPSHOT_INVALID` | snapshot seal, object hash, runtime binding or path check failed |
| `DC_SNAPSHOT_TOO_LARGE` | snapshot limits exceeded (5000 entries / 256 MiB / 64 MiB per file / depth 32) |
| `DC_PERMISSION_DENIED` | EACCES/EPERM |
| `DC_SUBSYSTEM_UNAVAILABLE` | dependency (config, git, ripgrep) unavailable (retryable) |
| `DC_INTERNAL_ERROR` | unclassified |

## Tools

Classification columns: **R/W** is read/write; **risk** is the mechanical risk class
from `capability_manifest`; **managed** is the ACS disposition (`cap` means capability
with no approval, `cap+approval` means capability plus approval, `unsupported` means
ACS denies it with `managed_tool_unsupported`).

| tool | R/W | risk | managed | preconditions |
| --- | --- | --- | --- | --- |
| `health` | read | read | cap | none |
| `last_error` | read | read | cap | none |
| `run_command` | write | process | cap+approval | `expectedHeadSha` |
| `wait_for_process` | read | read | cap | DC-owned pid |
| `terminate_process` | write | process_control | cap+approval | DC-owned pid |
| `apply_patch` | write | write | cap+approval | `expectedSha256` (required), `expectedHeadSha` |
| `git_state` | read | read | cap | none |
| `verify_head` | read | read | cap | `expectedSha` |
| `snapshot_path` | write (DC state area) | write | cap+approval | none |
| `restore_snapshot` | write | write | cap+approval | `snapshotId`, `expectedCurrentSha256` |
| `capability_manifest` | read | read | cap | none |
| `operation_preview` | read | read | cap (nested paths contained by ACS) | none |
| `secret_scan` | read | read | cap | none |
| `service_status` | read | network_read | **unsupported** (ACS defines no network-capable managed DC tool) | none |

### health
`{}`. Returns version, build commit, pid, uptime, `configHash`, `allowlistHash`, an
overall `healthy|degraded|unhealthy` status, and per-subsystem `{status, reason, errorCode?}`
for `configuration`, `runtime_identity`, `allowed_directories`, `process_manager`, `search`,
`managed_transport` and `event_sinks`. Each probe is isolated and bounded to 2 s, so a
broken subsystem is reported, never fatal.

### last_error
`{limit?: 1..50, tool?, requestId?, correlationId?}`. Returns the most recent failures:
`requestId, correlationId, timestamp, tool, stage, errorCode, errno, ruleId, message
(sanitized), normalizedArgumentsHash, causeCategory, retryable`. Only argument hashes are
kept; raw arguments are never stored.

### run_command
`{argv: string[], cwd, timeoutMs? (≤15 min, default 60 s), maxStdoutBytes?, maxStderrBytes? (≤4 MiB, default 256 KiB), expectedHeadSha?}`.
argv is executed directly (`shell:false`). There is no shell string, no implicit
`bash -c` and no fallback. stdin is closed, and on timeout the process group gets
SIGTERM, then SIGKILL after 2 s. Returns `exitCode, signal, timedOut, durationMs, stdout,
stderr, stdoutBytes, stderrBytes, truncated{stdout,stderr}, executable, cwd, requestId`.
A relative executable path is resolved against `cwd`, and both `argv[0]` and the resolved
path are checked against `blockedCommands`.
In managed mode ACS validates argv with the `start_process` command policy and binds
`argv[0]` to the fixed-dir absolute executable; DC runs exactly the bound argv.
Example: `{"argv":["git","status","--porcelain"],"cwd":"/repo"}`.
`start_process` remains the tool for interactive or long-lived sessions.

### wait_for_process
`{pid, timeoutMs? (≤10 min, default 30 s), until?: {type: exit|stdout_pattern|stderr_pattern|either_pattern, pattern?}, tailLines?}`.
Event-driven (no polling). Output that is already buffered is checked first
(`matched.alreadyPresent`). Returns `state, exitCode, signal, matched, timedOut,
durationMs, stdoutTail, stderrTail`. Only DC-owned sessions are accepted; others get
`DC_PROCESS_NOT_OWNED`.

### terminate_process
`{pid, graceMs? (default 3000), force? (default true)}`. Sends SIGTERM to the session's
process group, waits `graceMs`, then (if `force`) sends SIGKILL. Returns `signalsSent,
escalated, exited, exitCode, signal`. Arbitrary pids are refused; recovered sessions are
identity-checked (pid-reuse safe) before any signal.

**Decision on `kill_process`:** it is kept unchanged for backwards compatibility and
marked **LEGACY** in its description and in `capability_manifest`. It remains
`unsupported` in managed mode, so no managed caller can reach it. Constraining it in
standalone mode would break existing clients that deliberately kill non-DC processes.
`terminate_process` is the scoped replacement.

### apply_patch
`{path, patch (single-file unified diff), expectedSha256, expectedHeadSha?}`.
The steps, in order:
1. Read the pre-image with `O_NOFOLLOW` and check its sha256 against `expectedSha256`.
2. Parse the patch and apply it in memory with exact context matching. A hunk may
   relocate only to a unique match; ambiguous hunks, multi-file patches, and file
   creates, deletes or renames are rejected.
3. Write a same-directory temp file with the original mode and fsync it.
4. Re-read the target and require the same inode and the same hash, otherwise
   `DC_PATH_CHANGED`.
5. `rename(2)` the temp file over the target and fsync the directory.

Returns `preSha256, postSha256, hunksApplied, linesAdded, linesRemoved, hunkOffsets`.
This closes the read → `edit_block` → write TOCTOU. The residual window is the few
syscalls between the final re-verification and `rename`.

### git_state / verify_head
`git_state {repoPath}` returns `repoRoot, headSha, unbornHead, branch` (informational
only), `detached, dirty, counts{staged,unstaged,untracked,conflicts}`, parsed porcelain v2
`entries`, `stashes, upstream, ahead, behind`. git runs via argv with
`GIT_OPTIONAL_LOCKS=0`.

`verify_head {repoPath, expectedSha}` takes a full 40- or 64-hex SHA and returns
`repoRoot, expectedSha, actualSha, match, dirty`. A mismatch is explicit
(`match:false, code:"DC_HEAD_MISMATCH"`). `run_command` and `apply_patch` reuse the same
primitive, and a mismatch there is a hard failure.

### snapshot_path / restore_snapshot
`snapshot_path {path, reason?}` covers a file or a bounded tree. Snapshots are stored under
`<state>/snapshots/<snapshotId>/` (mode 0700) as content-addressed objects plus a sealed
`manifest.json` (`schema, snapshotId, runtimeId, requestId, createdAt, reason (redacted),
originalPath, kind, contentSha256, entries[{relPath,type,mode,size,mtimeMs,sha256|target}]`).
Symlinks are recorded, never followed.

`restore_snapshot {snapshotId, expectedCurrentSha256?}` works as follows:
1. Verify the seal, every object hash, the runtime binding and the entry paths.
2. Re-validate the target against the current allowed directories.
3. Honour the `expectedCurrentSha256` guard.
4. Snapshot divergent current data first (`preRestoreSnapshotId`).
5. Materialize into a staging sibling, verify it, and swap it in by rename.

Returns `beforeSha256, afterSha256`. For a file, `contentSha256` is the file's sha256; for
a directory it is a tree hash that excludes mtimes.

### capability_manifest
`{tool?}`. Per tool: `category, riskClass, mutating, mechanicallyAvailable,
availabilityReason, supportedPreconditions, requiresCwd, filesystemScope, processScope,
shellExecution, emitsExecutionEvidence, authorization:"external", managedDisposition,
legacy`. It never reports `authorized`.

### operation_preview
`{tool, arguments}`. Returns `mechanically_valid, authorization:"external", problems[],
normalizedArguments` (origin removed), `normalizedArgumentsHash` (equal to what ACS binds
before semantic normalization), resolved `cwd` and `paths` with `insideAllowedDirectories`,
`command` (argv, resolved executable, `usesShell`, DC command-restriction result),
`mutation, riskClass, preconditions`. Nothing is executed and no authorization decision is
made. In managed mode ACS contains every nested path first.

### secret_scan
`{target: text|file|diff, text?|path?|patch?}`. Detects private keys; GitHub, GitLab,
Slack and npm tokens; OpenAI, Anthropic, Stripe and Google keys; AWS and Azure
credentials; JWTs; bearer and authorization headers; URL credentials; and `.env`/JSON
secret assignments. Returns `detector, category, line, column, length` only, never values.
Files must be in scope and are capped at 4 MiB. For diffs, only added lines are scanned.
The same redactor (`redactText`/`redactValue`) sanitizes `last_error`, error bodies,
snapshot reasons and every execution event.

### service_status
`{checks: [...≤25], timeoutMs? (100..10000)}` with check types `systemd_user|systemd_system {name}`,
`process {pid|name}` (Linux /proc: state, uid, owned by current user), `port {host?, port}`,
`http {url, expectStatus?}` and `executable {name}`. The tool is read-only and
time-bounded. Network probes are limited to loopback/private addresses (unless
`DC_SERVICE_STATUS_ALLOW_PUBLIC=1`), pin the resolved address (no DNS rebinding), follow no
redirects, accept no caller headers or URL credentials, and return a redacted 512-byte body
snippet. Port/HTTP probes are refused when `DC_NETWORK_PROFILE=none`.

## Search subsystem improvements (start_search / get_more_search_results)
There is no new search tool; the existing engine is hardened:
- a global result cap (`maxResults`, hard ceiling 10 000; ripgrep's `-m` is per file), and
  scanning stops when it is reached (`resultsTruncated`)
- a default 120 s timeout with a 5 min maximum (`timedOut`)
- `--max-filesize 16M` per file
- symlinks never followed, and the root is resolved via `validatePath`
- invalid regex reported as `DC_INVALID_ARGUMENT`; path scope violations as
  `DC_PATH_OUTSIDE_ALLOWED_SCOPE`
- an additive `structured: true` option that returns JSON

## Execution events (dc.execution-event.v1)
One event per tool call, with these fields: `eventId, requestId, correlationId, timestamp,
runtimeId, tool, operationClass, outcome (success|error|refused),
normalizedArgumentsHash, origin, durationMs, cwd?, repoHeadSha?, preconditions?, results?`
(hashes, sizes and codes, never output text or file contents), `exitCode?, signal?,
truncated?, errorCode?, errorCategory?, mechanical{riskClass, authorization:"external"}`,
and `acs{workItemId, attemptId, leaseId}` (relayed only from a verified capability).

Sinks: an in-memory ring (always on), an append-only JSONL file when
`DC_EXECUTION_EVENTS_FILE` is set to an absolute path, and in-process subscribers
(`executionEvents.subscribe`) for an ACS/LoopTrace forwarder. Every event is redacted
before reaching any sink. A failing sink never changes a tool result; `health` reports it
as degraded. ACS/LoopTrace remain the authoritative audit and session layer.
