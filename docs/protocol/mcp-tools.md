# Protocol Specification: MCP Tools

## Purpose

This document defines the ChatGPT-facing MCP tool contract for `agent-control-stack`.

The protocol is intentionally narrow. A broad generic shell tool is not a feature; it is a way to turn documentation into an apology letter.

## Naming convention

Tool names use snake_case for compatibility with function-style clients.

Conceptual dotted names may appear in design docs, but protocol names must use snake_case.

Examples:

| Conceptual name | Protocol name |
|---|---|
| `system.status` | `system_status` |
| `fs.list` | `fs_list` |
| `cmd.preview` | `cmd_preview` |
| `work.create` | `work_create` |

## Common envelope

Every response uses this shape:

```json
{
  "ok": true,
  "data": {},
  "error": null,
  "audit_event_id": "evt_..."
}
```

Failure shape:

```json
{
  "ok": false,
  "data": null,
  "error": {
    "code": "policy_denied",
    "message": "Path is outside configured allow roots.",
    "details": {}
  },
  "audit_event_id": "evt_..."
}
```

## Error codes

| Code | Meaning |
|---|---|
| `invalid_request` | Request failed schema validation. |
| `unauthenticated` | Connector identity/authentication missing or invalid. |
| `policy_denied` | Policy rejected the action. |
| `approval_required` | Request needs out-of-band approval before execution. |
| `approval_invalid` | Approval token missing, expired, consumed, or mismatched. |
| `path_denied` | Path failed allow/deny/realpath checks. |
| `command_denied` | Command or arguments are forbidden. |
| `execution_failed` | Tool ran but failed. |
| `timeout` | Execution exceeded limit. |
| `output_truncated` | Output exceeded response cap. |
| `audit_failed` | Required audit event could not be written. |
| `internal_error` | Unexpected server-side failure. |

## Risk levels

| Risk | Meaning |
|---|---|
| `read_only` | Inspects state without expected mutation. |
| `sensitive_read` | Reads potentially sensitive data and may require approval. |
| `safe_mutation` | Low-risk mutation, still approval-gated by default for MVP. |
| `requires_approval` | Mutating or potentially dangerous action. |
| `destructive` | High-impact operation; approval may not be sufficient depending on policy. |
| `forbidden` | Categorically denied. |

## Tools

## `system_status`

Returns local control plane and host health.

### Request

```json
{}
```

### Response data

```json
{
  "server_version": "0.1.0",
  "mode": "local_stdio|https_connector",
  "hostname": "machine",
  "platform": "linux",
  "uptime_seconds": 1234,
  "memory": {
    "total_bytes": 0,
    "free_bytes": 0
  },
  "policy_version": "2026-07-05",
  "audit_head": "sha256:..."
}
```

## `fs_list`

Lists entries under an allowed directory.

### Request

```json
{
  "path": "/home/user/project",
  "max_depth": 2,
  "include_hidden": false
}
```

### Policy

- Must resolve under an allowed root.
- Denylist overrides allowlist.
- Symlink escapes are denied.

## `fs_read`

Reads a text file with line-numbered output.

### Request

```json
{
  "path": "/home/user/project/package.json",
  "start_line": 1,
  "end_line": 200
}
```

### Policy

- Must resolve under an allowed root.
- Restricted file patterns are denied or approval-gated.
- Binary files are denied by default.
- Output is redacted before response and audit persistence.

## `fs_stat`

Returns metadata for a path.

### Request

```json
{
  "path": "/home/user/project"
}
```

## `fs_search_name`

Searches filenames under an allowed root.

### Request

```json
{
  "root": "/home/user/project",
  "query": "package",
  "max_results": 50,
  "max_depth": 5
}
```

## `cmd_preview`

Classifies a command without execution.

### Request

```json
{
  "cwd": "/home/user/project",
  "command": "npm",
  "args": ["test"]
}
```

### Response data

```json
{
  "normalized": {
    "cwd": "/home/user/project",
    "command": "npm",
    "args": ["test"]
  },
  "risk": "read_only",
  "decision": "allow_readonly",
  "reasons": ["known_readonly_subcommand"],
  "requires_approval": false
}
```

## `cmd_run`

Runs a command only when policy allows it or a valid approval exists.

### Request

```json
{
  "cwd": "/home/user/project",
  "command": "npm",
  "args": ["test"],
  "approval_token": null,
  "timeout_ms": 120000
}
```

### Policy

- `cwd` must be allowed.
- Command is classified before execution.
- Shell execution is denied by default.
- Environment is allowlisted.
- Timeout and output caps are enforced.
- Mutating or dangerous commands require approval.

## `fs_write`

Writes or overwrites a file.

### Request

```json
{
  "path": "/home/user/project/file.txt",
  "content": "new content",
  "approval_token": "token_once_..."
}
```

### Policy

- Always approval-gated in MVP.
- Path must be allowed.
- Restricted paths denied.
- Existing file backup required before overwrite.

## `fs_patch`

Applies a structured patch.

### Request

```json
{
  "path": "/home/user/project/file.txt",
  "edits": [
    {
      "find": "old text",
      "replace": "new text"
    }
  ],
  "approval_token": "token_once_..."
}
```

### Policy

- Always approval-gated in MVP.
- Fails if match is missing or ambiguous unless caller opts into explicit multiple replacement.
- Path must be allowed.

## `fs_move`

Moves or renames a file.

### Request

```json
{
  "from": "/home/user/project/a.txt",
  "to": "/home/user/project/b.txt",
  "overwrite": false,
  "approval_token": "token_once_..."
}
```

## `service_status`

Returns status for an allowlisted local service.

### Request

```json
{
  "service": "agent-control-gateway"
}
```

## `service_restart`

Restarts an allowlisted local service.

### Request

```json
{
  "service": "agent-control-gateway",
  "approval_token": "token_once_..."
}
```

### Policy

- Service must be allowlisted.
- Restart is approval-gated.
- Result is audited.

## `work_create`

Creates a work item for later worker execution.

### Request

```json
{
  "title": "Run test suite",
  "description": "Run npm test in the project root.",
  "action": {
    "kind": "command",
    "cwd": "/home/user/project",
    "command": "npm",
    "args": ["test"]
  }
}
```

### Response data

```json
{
  "work_item_id": "wrk_...",
  "policy_decision": "allow_readonly|require_approval|deny",
  "approval_request_id": "apr_..."
}
```

## `work_claim`

Allows a worker to claim approved work.

### Request

```json
{
  "worker_id": "worker_local_1",
  "capabilities": ["command", "filesystem"]
}
```

### Response data

```json
{
  "work_item_id": "wrk_...",
  "lease_token": "lease_once_...",
  "lease_expires_at": "2026-07-05T18:00:00Z"
}
```

## `work_submit_result`

Submits a worker result.

### Request

```json
{
  "work_item_id": "wrk_...",
  "worker_id": "worker_local_1",
  "lease_token": "lease_once_...",
  "status": "succeeded|failed|cancelled",
  "summary": "Tests passed.",
  "artifacts": []
}
```

### Policy

- `worker_id` and `lease_token` are required.
- Lease must match the active claim.
- Expired leases are rejected.
- Result submission is audited.

## `approval_list`

Lists pending approval requests visible to the MCP client.

### Request

```json
{
  "status": "pending",
  "limit": 20
}
```

### Important

This tool never grants approval and never returns raw approval tokens.

## Approval-required response

When a tool requires approval and no valid token is present, return:

```json
{
  "ok": false,
  "data": {
    "approval_request_id": "apr_...",
    "request_hash": "sha256:...",
    "risk": "requires_approval",
    "reason": "file_write",
    "expires_at": "2026-07-05T18:00:00Z",
    "human_instruction": "Approve locally using the control UI or CLI."
  },
  "error": {
    "code": "approval_required",
    "message": "This action requires out-of-band human approval.",
    "details": {}
  },
  "audit_event_id": "evt_..."
}
```

## Audit requirements

Every tool call produces at least one audit event.

Mutating tools produce:

1. Intent event before execution.
2. Approval check event, if applicable.
3. Result event after execution.

If intent cannot be audited, mutation must not execute.
