# LoopTrace Query MCP (`looptrace-query/1`)

Read-only cross-agent execution **evidence and verification** over the ACS control-plane store.
Invariant: **No evidence, no verified success.** Agent-asserted completion is never independent verification.
Verification never authorizes, approves, retries or changes anything.

- Shared implementation: `packages/looptrace-query` (`@agent-control-stack/looptrace-query`)
- MCP adapter (stdio): `apps/looptrace-mcp` (bin `acs-looptrace-mcp`)
- Tools: `looptrace_trace`, `looptrace_gaps`, `looptrace_verify` (closed schemas, readOnly annotations)

## Architecture

```
caller (Hermes/JC/agent) --stdio JSON-RPC--> acs-looptrace-mcp --> LoopTraceQueryService
                                                                     |- authz (HMAC grant, scopes, visibility)
                                                                     |- AcsReadStore  (node:sqlite readOnly + query_only)
                                                                     |- correlate (dedupe/conflict/order/skew)
                                                                     |- gaps (stage requirements -> typed gaps)
                                                                     `- verify (bounded assertion registry)
```

Evidence sources: ACS tables (work_items, approvals, plan admissions, attempts/leases/results, validation runs,
evidence manifests, verification decisions, routing/assignments, capability issuances, publication records),
the hash-chained `audit_events`, and the `trace_outbox` (trace-event/1) projection.
Optional observers: installed-release (`RELEASE.json`) and allow-listed health targets.

Trust classes: `authoritative` (ACS decided/recorded), `observed` (independent machine observation),
`asserted` (worker/tool self-report). Only authoritative/observed evidence can yield PASS.
Verdict precedence: FAIL > ERROR > INCONCLUSIVE > PASS. Chain/manifest-hash violations => ERROR + blocking gap.
A missing observation is INCONCLUSIVE, never FAIL.

## Evidence model (`looptrace-evidence/1`)

Fields: trace_id, request_id, work_item_id, parent_span_id, event_id, timestamp, observed_at, actor, source,
event_type, decision, tool_name, capability_id, release_sha, status, evidence_ref, integrity, trust, facts.
Stages: REQUEST -> ROUTING -> POLICY -> APPROVAL -> DISPATCH -> TOOL_EXECUTION -> RESULT -> OBSERVATION -> VERIFICATION
(required only when the operation needs them). Payloads are sanitized (secret redaction, control/bidi stripping,
size/depth bounds); instruction-like text is flagged and stays inert data.

## Tool contracts

All inputs are strict (unknown keys rejected); at least one of `trace_id`, `request_id`, `work_item_id`,
`execution_id` is required. No unrestricted dump: results are bounded (<=25 work items, <=1500 events/item,
page_size <=200, 8s deadline, 768KB response cap).

| Tool | Extra input | Output |
|---|---|---|
| `looptrace_trace` | `page_size`, `cursor` | `work_items`, ordered `events` (with trust, evidence_ref), `trust_summary`, `anomalies`, `sources`, `page` |
| `looptrace_gaps` | – | per work item: `completeness`, `required_stages`, `observed_stages`, `gaps[{code,severity,affected_stage,description,required_evidence,evidence_refs}]` |
| `looptrace_verify` | `assertions[]` (<=12) | `verdict`, per-assertion `{type,verdict,reason,evidence_refs,trust_basis}`, `evidence_refs`, `completeness`, `blocking_gaps`, `caveats` |

Assertion types (unknown types => `UNSUPPORTED_ASSERTION`): `operation_completed`, `approval_valid`,
`release_matches {scope: acs_producer|installed, expected_sha, component?}`, `service_healthy {target}`,
`artifact_exists {manifest_hash}`, `expected_state_observed {key,...}` (bounded enum keys, incl. `publication_recorded`).
`installed` means "present on disk", not "running". `service_healthy` uses operator-configured targets only,
no redirects, 2s timeout, never reads the body. `verify` requires exactly one work item.

Errors (structured `{error:{code,message}}`, `isError:true`): INVALID_ARGUMENT, NOT_FOUND, AMBIGUOUS_IDENTIFIER,
UNAUTHENTICATED, SOURCE_NOT_CONFIGURED, SOURCE_UNAVAILABLE, UNSUPPORTED_ASSERTION, DEADLINE_EXCEEDED, INTERNAL.

## Security

- DB opened `readOnly` + `PRAGMA query_only=ON`; never through the migrating store. Caller input is only bound parameters.
- Grant = `base64url(payload).base64url(HMAC-SHA256)`, bound at **process start** from env (never from tool args).
  Scopes `looptrace:trace|gaps|verify`; visibility `all | work_items | roots | requester_subjects | assigned_to`.
- Out-of-scope resources are indistinguishable from nonexistent (same NOT_FOUND). Authz precedes ambiguity checks.
- No shell/SQL/path inputs. Key file must be mode 0600/0400 and >=16 bytes.

## Configuration (env)

| Var | Purpose |
|---|---|
| `LOOPTRACE_ACS_DB` | path to ACS control DB (required) |
| `LOOPTRACE_GRANT` / `LOOPTRACE_GRANT_FILE` | caller grant |
| `LOOPTRACE_GRANT_KEY_FILE` | HMAC key file |
| `LOOPTRACE_RELEASE_ROOTS` | roots scanned for `<component>/.../RELEASE.json` (optional) |
| `LOOPTRACE_HEALTH_TARGETS` | JSON `{name: http(s)-url}` allow-list (optional) |
| `LOOPTRACE_JC_TRACE_ROOTS` | operator-configured directories of Jace Commander traces, e.g. `~/.jace-commander/traces` (`jc-mcp-<pid>-<epoch>.jsonl`, hash-chained; path-list separated like `PATH`) |
| `LOOPTRACE_HERMES_STATE_DB` | reserved; Hermes adapter NOT implemented |

Issue a grant (operator action; prints the token, keep it secret):
`LOOPTRACE_GRANT_KEY_FILE=<key> node apps/looptrace-mcp/dist/cli.js issue-grant --sub hermes --scopes trace,gaps,verify --visibility all --ttl-seconds 3600`

Hermes registration snippet (**documentation only – not applied anywhere**):
```yaml
mcp_servers:
  looptrace:
    command: node
    args: [<release>/apps/looptrace-mcp/dist/cli.js]
    env: { LOOPTRACE_ACS_DB: <path>, LOOPTRACE_GRANT_FILE: <path>, LOOPTRACE_GRANT_KEY_FILE: <path> }
```

## Example (live, real ACS work item, read-only)

`looptrace_verify {work_item_id, assertions:[operation_completed]}` -> `INCONCLUSIVE`, trust_basis `asserted`:
"success is recorded, but only the worker's own report supports it; no independent observation exists".
`looptrace_gaps` -> `MISSING_OUTCOME_EVIDENCE (medium)`, `MISSING_RELEASE_IDENTITY (low)`, completeness `partial`.
`release_matches acs_producer` -> `INCONCLUSIVE` ("ACS producer ran an unpinned build 'unreleased'").
Tests use clearly synthetic fixtures (`test/fixture.ts`, outside `src/` so it is never compiled into the shipped build) to stage tamper/contradiction states ACS triggers normally prevent.

## Known limitations

- **Hermes** session correlation is **not implemented** (reported `not_configured`).
- **Jace Commander (JC)** trace correlation reads the format JC really writes (checked against `vendor/desktop-commander/src/jace-commander`
  and all 34 real traces on the build host): one hash-chained file per MCP **process**, `run_id` = `jc-mcp-<pid>-<epoch>`, holding
  `tool_call_finished {tool, argumentsSha256, ok, code?, workItemId?}` (the work item id comes from the ACS authorization for that call).
  - Three levels are kept apart. *Session integrity* (`jc.session`: did the whole process chain verify, how many events could not be
    attributed), *tool-call outcome* (`jc.tool.finished`: JC's own `ok`/`code` for one call), and *work-item completion*, which is
    **never** taken from JC: a successful JC call does not show the mission succeeded.
  - Events match a work item only by `payload.workItemId` (exact). Events without it, or with an invalid one, are counted on the
    session event (`jc_events_without_work_item`, flag `jc_events_unattributed`), never guessed. Other work items' events are not emitted.
  - JC events are `asserted`, use the lifecycle stage (so they cannot satisfy a required ACS stage) and can add gaps or block a PASS,
    never create one. Gaps: `JC_CHAIN_BROKEN` (contents then unused), `JC_TRACE_MALFORMED`, `JC_COVERAGE_INCOMPLETE` (unreadable
    root, oversize/non-regular file, files beyond the scan bound), `JC_OUTCOME_MALFORMED`, `JC_TOOL_CALL_FAILED` (low, per call) and
    `JC_ACS_OUTCOME_CONFLICT` (ACS says succeeded while the only JC outcomes for it are failures; `operation_completed` is then INCONCLUSIVE).
  - `run_completed` / `run_failed` are **not required**. JC writes no head anchor (no chain head, no event count, and in practice
    no `trace_sealed`), so a JC trace truncated from the tail still verifies. Only a session whose verified chain ends in
    `trace_sealed` proves its own end; any other non-empty session in the configured roots (including one that no longer names the
    work item, since truncation can remove exactly those records) is reported as `jc.coverage` with status
    `completeness_unproven` / gap `JC_COMPLETENESS_UNPROVEN` (low), and an `operation_completed` that would otherwise PASS returns
    INCONCLUSIVE with a reason starting `completeness unproven:`. Deleting a whole JC session file remains undetectable.
  - Remaining gaps: JC's `tool_call_started` carries no work item id, so a crash mid-call cannot be attributed to a work item (only the
    session-level `jc_unmatched_starts` fact); JC records neither attempt nor lease ids, so JC evidence cannot be tied to a specific ACS
    attempt; a valid chain shows no edit but not completeness (a truncated tail is undetectable) nor that effects occurred; the
    work item ids in the real traces were not present in any ACS database on the build host, so ACS-side correlation is untested live.
- Integrity gate: before any stored-evidence assertion is evaluated (everything except the live `service_healthy` and
  `release_matches` scope `installed` observers), `looptrace_verify` fails closed with ERROR if the ACS source is unreadable, any
  evidence event has a broken chain or hash mismatch, any audit/trace-projection row for the work item failed verification, or a
  chain tail was truncated below its stored head.
- Head anchors: the global audit chain's newest `sequence` must equal SQLite's own AUTOINCREMENT high-water mark
  (`sqlite_sequence`, never lowered by DELETE), and the newest `trace_outbox` row must sit at `trace_chain_state.seq` and hash to
  its `head_hash`. A shortfall is `audit_tail_truncated` / `trace_tail_truncated` (ERROR). When no stored head exists the state
  carries `audit_head_unproven` / `trace_head_unproven` and a would-be PASS becomes INCONCLUSIVE (`completeness unproven: ...`).
  These anchors live in the same database: a writer able to rewrite rows, re-hash the chain and also lower `sqlite_sequence` /
  rewrite `trace_chain_state` can still forge a consistent shorter history. Only an external anchor would close that.
- ACS does not record the executor's release identity (`MISSING_RELEASE_IDENTITY`); `installed` != running.
- `installed` release observation expects `RELEASE.json` under configured roots; the live `~/releases/acs/<sha>-name`
  layout was not matched (reports INCONCLUSIVE, not a false PASS).
- 14 live audit events per item have names with no evidence mapping (surfaced in `notes`).
- Tool is detective: ACS write guards prevent most illegal states, so FAIL/ERROR paths are proven on fixtures.
- stdio only; no network listener. Deployment/registration is an operator step and has not been performed.
