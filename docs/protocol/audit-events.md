# Protocol Specification: Audit Events

## Purpose

Audit events provide the replayable record of requests, policy decisions, approvals, leases, executions, and results.

## Event envelope

```json
{
  "event_id": "evt_...",
  "timestamp": "2026-07-05T18:00:00.000Z",
  "schema_version": 1,
  "event_type": "tool.intent",
  "actor": "connector:chatgpt:user",
  "request_id": "req_...",
  "body": {},
  "prev_hash": "sha256:...",
  "event_hash": "sha256:..."
}
```

## Event types

| Event type | Meaning |
|---|---|
| `tool.intent` | Tool call was received and normalized. |
| `policy.decision` | Policy classified and decided the action. |
| `approval.requested` | Approval request was created. |
| `approval.granted` | Human approved out-of-band. |
| `approval.denied` | Human denied out-of-band. |
| `approval.consumed` | Approval token was used. |
| `execution.started` | Command/tool mutation began. |
| `execution.finished` | Execution completed. |
| `execution.failed` | Execution failed before completion. |
| `work.created` | Work item created. |
| `work.claimed` | Worker claimed work and received lease. |
| `work.result_submitted` | Worker submitted result. |
| `audit.verify` | Audit verification was run. |

## Hashing

`event_hash` is computed as:

```text
sha256(canonical_json(event_without_event_hash))
```

The event body includes `prev_hash`, making the log tamper-evident.

## Redaction

Sensitive values must be redacted before hashing and persistence.

Redact at minimum:

- Bearer tokens
- API keys
- OpenAI keys
- GitHub tokens
- SSH private keys
- JWTs
- Password-like env values
- `.env` values

Redaction must use stable placeholders when possible:

```text
[REDACTED:openai_key]
[REDACTED:github_token]
[REDACTED:private_key]
[REDACTED:secret]
```

## Execution result body

```json
{
  "tool": "cmd_run",
  "cwd": "/home/user/project",
  "command": "npm",
  "args": ["test"],
  "exit_code": 0,
  "duration_ms": 8421,
  "stdout_preview": "tests passed",
  "stderr_preview": "",
  "stdout_truncated": false,
  "stderr_truncated": false,
  "changed_files": []
}
```

## Verification requirements

Audit verification must detect:

- Missing event
- Reordered event
- Edited event
- Broken `prev_hash`
- Invalid `event_hash`
- Schema version mismatch if unsupported

## Mutation safety rule

For mutating tools, the pre-execution intent and policy decision must be written before execution begins. If they cannot be written, execution is denied.
