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
| `LOOPTRACE_JC_TRACE_ROOTS`, `LOOPTRACE_HERMES_STATE_DB` | reserved; adapters NOT implemented |

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
Tests use clearly synthetic fixtures (`src/fixture.ts`) to stage tamper/contradiction states ACS triggers normally prevent.

## Known limitations

- Jace Commander local-chain correlation and Hermes session correlation are **not implemented**; they are reported
  as `not_configured` in `sources`. JC outcomes are visible only as ACS-recorded capability/tool events.
- ACS does not record the executor's release identity (`MISSING_RELEASE_IDENTITY`); `installed` != running.
- `installed` release observation expects `RELEASE.json` under configured roots; the live `~/releases/acs/<sha>-name`
  layout was not matched (reports INCONCLUSIVE, not a false PASS).
- 14 live audit events per item have names with no evidence mapping (surfaced in `notes`).
- Tool is detective: ACS write guards prevent most illegal states, so FAIL/ERROR paths are proven on fixtures.
- stdio only; no network listener. Deployment/registration is an operator step and has not been performed.
