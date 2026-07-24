# Protocol Specification: MCP Tools

## Status

**Rewritten 2026-07-23.** The previous version of this document described a single unified tool surface (`fs_write`, `fs_patch`, `fs_move`, `service_status`, `service_restart`, `work_create`, `work_claim`, `work_submit_result`, `approval_list`, and an `approval_token` field on mutating requests) that was never implemented. No ADR, planning doc, or code reference points to any of those tools as near-term work — grepping `apps` and `packages` for their names returns nothing. This revision documents the two tool surfaces that actually exist, matching `apps/mcp/src/server.ts` and `apps/gateway/src/mcp.ts` as of this date. See [ADR 0004](../adr/0004-request-bound-approval-tokens.md) and [approval-lifecycle.md](approval-lifecycle.md) for why approval no longer involves a token at all, in either surface.

## Purpose

This document defines the MCP tool contracts exposed by `agent-control-stack`.

The protocol is intentionally narrow. A broad generic shell tool is not a feature; it is a way to turn documentation into an apology letter.

## Two tool surfaces

There is no single tool catalog. Two independent MCP servers exist, with different transports, different tool names, and different backing state:

| | Local stdio MCP | Gateway MCP |
|---|---|---|
| Entry point | `apps/mcp/src/server.ts` (`McpStdioServer`) | `apps/gateway/src/mcp.ts` (`handleMcpHttpRequest`) |
| Backed by | `MachineController` (`packages/machine-controller`) | work-item tools (`packages/policy-gate/src/tools.ts`, `packages/work-items`) |
| Transport | stdio, `Content-Length`-framed JSON-RPC | HTTP JSON-RPC (`apps/gateway`), per [ADR 0007](../adr/0007-chatgpt-https-mcp-transport.md) |
| Tool naming | dotted (`system.status`, `fs.read`, ...) | snake_case (`create_work_item`, `approve_work_item`, ...) |
| What it does | Reads the local machine directly (files, command previews, one read-only command execution) | Creates and manages governed work items that a separate worker later claims and executes |
| Auth | none (local process, trusted caller) | `authorizeMcpRequest` — bearer/OAuth scopes, per `apps/gateway/src/auth.ts` |

There is no naming convention that unifies the two — the local server's tool names are the literal `MachineController.callTool` dispatch keys (dots), and the gateway's are the literal `createWorkItemTools` keys (underscores). Do not assume one implies the other.

## Common envelope

Both surfaces speak plain JSON-RPC 2.0. There is no `{ok, data, error, audit_event_id}` envelope anywhere in the implementation — that shape does not exist in this codebase.

Success (`tools/call`):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "<tool.name> completed." }],
    "structuredContent": { }
  }
}
```

`structuredContent` is the tool's actual return value (or `{ "result": <value> }` if the return value isn't a plain object).

Failure is a JSON-RPC error, not a result with `ok: false`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32000,
    "message": "path is outside allowed roots: /etc/passwd"
  }
}
```

`code` is `-32602` for a Zod schema validation failure, `-32000` for a thrown `ControlStackError`, `-32601` for an unsupported JSON-RPC method, `-32603` for anything else. The gateway additionally uses `-32001` (actor not registered), `-32002` (MCP identity attempted `approve_work_item`), and returns a matching HTTP status per error alongside the JSON-RPC body. `message` is the `ControlStackError`'s own message text — by convention some throw sites lead with the machine-readable code (`"approval_action_hash_required: actionHash is required"`), others just describe the failure (`"path is outside allowed roots: ..."`); the machine-readable `code` itself is a property on the server-side exception object, not a separate field in the JSON-RPC response.

## Error codes

Error codes are `ControlStackError.code` values, not a fixed enum owned by this doc — the canonical list lives in the source and will drift out of sync with anything duplicated here. Identify which one occurred from the `message` text in the JSON-RPC error. The ones a caller of the tools below can actually hit:

| Code | Surface | Meaning |
|---|---|---|
| `path_outside_allowlist` | local fs.* | Resolved path is outside `paths.allow`. |
| `path_denied` | local fs.* | Resolved path matches `paths.deny`. |
| `path_restricted` | local fs.* | Path looks credential-like (`.env`, `id_rsa`, `.ssh/`, `.aws/credentials`, etc.) and wasn't explicitly allowed. |
| `fs_not_file` | local fs.read | Target is not a regular file. |
| `fs_too_large` | local fs.read | File exceeds `security.max_output_bytes`. |
| `fs_binary_refused` | local fs.read | File looks binary; refused rather than dumped. |
| `command_refused` | local cmd.run | Command did not classify as `read_only` (see below — `cmd.run` never executes anything else). |
| `work_item_not_found` | gateway | No work item with the given `id`. |
| `approval_action_hash_required` | gateway approve_work_item | Caller omitted `actionHash`. |
| `approval_action_mismatch` | gateway approve_work_item | `actionHash` doesn't match a currently-evaluated action on the work item. |
| `approval_not_required` | gateway approve_work_item | `actionHash` matches an action that policy didn't flag as `require_approval`. |
| `invalid_work_item_transition` | gateway | Requested transition isn't legal from the item's current status. |
| `direct_agent_not_configured` | gateway test.agent.run | Gateway wasn't wired with a direct-agent controller. |

## Risk levels

Both surfaces share the same risk vocabulary (`riskLevelSchema` in `packages/machine-controller/src/command.ts`, `PolicyRiskLevel` in `packages/policy-gate/src/rules.ts`):

| Risk | Meaning |
|---|---|
| `read_only` | Inspects state without mutation. |
| `safe_mutation` | Low-risk mutation. Currently only ever produced by the policy gate's agent-prompt-dispatch rule (`packages/policy-gate/src/rules.ts`) — no local `cmd.*` classification path returns it today. |
| `requires_approval` | Mutating action; a gateway work item classified this way moves to `needs_approval` until `approve_work_item` is called with a matching action hash. |
| `destructive` | High-impact operation (`rm`, `dd`, `mkfs`, `--force`, ...). |
| `forbidden` | Categorically denied — includes anything with shell metacharacters, a `/` in the command name, or on the deny list. |

## Local stdio MCP tools

Backed by `MachineController`. All paths are resolved and validated by `resolveSafePath` (`packages/machine-controller/src/path.ts`) before any read.

### `system.status`

Returns host OS/process info. No input required.

```json
{ "os": { "platform": "linux", "release": "...", "cpus": 8 },
  "uptimeSeconds": 1234,
  "memory": { "totalBytes": 0, "freeBytes": 0 },
  "loadAverage": [0, 0, 0],
  "server": { "name": "personal-machine-controller", "version": "0.1.0", "transport": "stdio" } }
```

### `fs.list`

```json
{ "path": "/home/user/project", "max_depth": 1 }
```

`max_depth` is 0–5, default 1. Returns `{ path, entries: [{ name, path, kind, size, modifiedAt }] }`.

### `fs.stat`

```json
{ "path": "/home/user/project" }
```

Returns a single `{ name, path, kind, size, modifiedAt }`.

### `fs.read`

```json
{ "path": "/home/user/project/package.json", "start_line": 1, "end_line": 200 }
```

Text files only (binary refused). Output is line-numbered and redacted line-by-line — env-style secret assignments, `Bearer` tokens, GitHub/OpenAI-shaped tokens, credential URLs, and PEM private-key blocks are replaced with `[redacted]` before the response is built (not just before audit persistence).

### `fs.search_name`

```json
{ "path": "/home/user/project", "query": "package", "max_depth": 3, "limit": 50 }
```

Filename substring search (case-insensitive), depth 0–8, limit up to 200.

### `cmd.preview`

Classifies a command without executing it.

```json
{ "cwd": "/home/user/project", "command": "npm", "args": ["test"] }
```

Returns `{ cwd, command, args, risk, reason }`. `risk` is one of the levels above.

### `cmd.run`

```json
{ "cwd": "/home/user/project", "command": "npm", "args": ["test"] }
```

**Important divergence from the old spec:** this tool has no approval path and no `approval_token` field. It classifies the command exactly as `cmd.preview` does and throws `command_refused` for anything that doesn't classify as `read_only`. There is currently no MCP tool, local or gateway, that executes a mutating shell command directly — mutating work only happens through the gateway's work-item/worker-claim flow, which is a separate execution path entirely (see [approval-lifecycle.md](approval-lifecycle.md)). Environment is allowlisted to `HOME, PATH, SHELL, TMPDIR, USER`; timeout and output caps are enforced (`security.command_timeout_ms`, `security.max_output_bytes`); stdout/stderr are redacted the same way `fs.read` output is.

## Gateway MCP tools

Backed by `createWorkItemTools` (`packages/policy-gate/src/tools.ts`) over a `WorkItemStore`. These tools create and manage work items; they do not execute anything themselves. Execution happens later, out of band, when a worker calls `claim_next_approved_work_item` and `submit_work_result` — those two are **not** exposed as MCP tools (neither locally nor remotely); they're internal harness/worker calls, reached through the gateway's own HTTP endpoints, not `tools/call`.

Remote (HTTP/OAuth) callers get `remoteMcpToolNames`: everything below except `approve_work_item`. Calling `approve_work_item` over MCP — local or remote — is unconditionally rejected with JSON-RPC error `-32002` ("MCP identities cannot grant approval"); approval must go through an authenticated gateway mutation actor via `/work-items/:id/approve`, per [ADR 0004](../adr/0004-request-bound-approval-tokens.md).

### `create_work_item`

```json
{
  "title": "Run test suite",
  "requester": "user",
  "intent": "Run npm test in the project root.",
  "target": { "cwd": "/home/user/project" },
  "requestedActions": [{ "kind": "command", "description": "npm test", "params": {} }],
  "risk": "medium"
}
```

Over MCP, `requester`/`requesterSubject` are overwritten server-side to `"agent"` / the authenticated actor — caller-supplied identity is not trusted. Runs policy evaluation immediately; the returned `WorkItem.status` reflects the outcome (`pending_policy`, `needs_approval`, `approved`, or `blocked`).

### `get_work_item`

```json
{ "id": "wrk_..." }
```

### `list_work_items`

```json
{ "status": "needs_approval" }
```

`status` is optional; omit to list all.

### `approve_work_item` (not reachable over remote MCP)

```json
{ "id": "wrk_...", "actionHash": "sha256:...", "reason": "looks safe" }
```

No `approval_token`. `actionHash` must exactly match a currently-required action on the work item (`approval_action_mismatch` / `approval_not_required` otherwise). See [approval-lifecycle.md](approval-lifecycle.md) for the full grant/consume lifecycle.

### `unblock_work_item`

```json
{ "id": "wrk_..." }
```

Moves a `blocked` item back to `pending_policy` for re-evaluation.

### `reject_work_item` / `cancel_work_item`

```json
{ "id": "wrk_...", "reason": "no longer needed" }
```

Two distinct terminal states (`rejected` vs `cancelled`).

### `test.agent.run` (gateway only — not part of the local stdio surface)

Runs one direct agent invocation (`pi`, `openclaw`, `codex`, `claude`, `gemini`, `opencode`) from a clean prompt, through the gateway's approval-scoped path. This tool does **not** exist on the local stdio server described above — `apps/mcp/src/server.ts` unconditionally excludes `test.agent.run` from its accepted tool names (`standaloneMcpToolNames`), regardless of any configuration. It exists only here, on the gateway MCP surface (`apps/gateway/src/mcp.ts`).

```json
{ "agent": "codex", "prompt": "list the files in this directory", "cwd": "/home/user/project", "timeoutSeconds": 60, "permissionMode": "read-only" }
```

Requires the `acs:work:approve` OAuth scope — the same scope `approve_work_item` requires, not a separate lower bar. Always forces `permissionMode: read-only`; anything else throws `agent_permission_denied` (`normalizePermissionMode`, `packages/machine-controller/src/direct-agent.ts`) — no write-capable direct run exists through any documented path yet.

Only appears in `tools/list` at all when the gateway was constructed with a direct-agent controller configured, which requires **all** of:

1. `enableTestAgentRunForLocalDevelopment: true` (`GatewayOptions`) or `ACS_ENABLE_TEST_AGENT_RUN_FOR_LOCAL_DEVELOPMENT=1`.
2. `NODE_ENV !== "production"` — if the flag above is set while `NODE_ENV=production`, the gateway refuses to construct at all (`direct_agent_production_forbidden`, thrown at startup, not as a per-call JSON-RPC error).
3. `machineControllerConfigPath` (or `ACS_MACHINE_CONTROLLER_CONFIG`) configured.

If the controller was never configured, calling `test.agent.run` fails with `direct_agent_not_configured` (see the error table above). Treat this as a local-development escape hatch, not a documented-as-stable production surface.

## Audit

There is no separate `audit_event_id` returned per call. Auditing is a side effect, not part of the response envelope, and differs by surface:

- **Local stdio MCP:** every `MachineController.callTool` invocation appends one JSONL line to `audit.log_path` (default `.acs/audit/mcp.jsonl`) with `{ timestamp, tool, args, cwd, risk, approvalStatus, ok, durationMs, exitCode, resultSummary | error }`. `args` is redacted the same way file/command output is before being written.
- **Gateway MCP:** authenticated tool calls are reported via the `auditAuthenticatedRequest` callback (`AuthenticatedMcpRequestAudit`: `requestId, method, toolName, workItemId, resolvedActor, auth`), and work-item state changes are additionally recorded as policy/approval/transition events inside `WorkItemStore` (`policy.decided`, `approval.granted`, `approval.consumed`, etc.) — see [approval-lifecycle.md](approval-lifecycle.md).
