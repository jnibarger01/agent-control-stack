# Threat Model

## Boundaries

- HTTP requests enter through `apps/gateway`.
- Durable state is the SQLite audit log in `storage/local.db` by default.
- Worker execution must only consume approved work-item events.
- Sandbox execution is currently dry-run only.
- HTTP authentication is still deferred. Layer 2 records `approvedBy` and approval reasons at the tool seam, but caller identity is local-dev supplied until gateway or MCP hardening binds it to authenticated users.

## Controls

- Zod validates public request bodies and event shapes.
- Sensitive keys such as tokens, passwords, API keys, and secrets are redacted before audit events are created.
- The policy gate fails closed for requested actions and denies sudo, destructive root removal, credential-file reads, unapproved network, and path-escape writes.
- File writes, package installs, service restarts, git commits, and long-running commands require approval.
- The worker only starts rows that are already `approved`; the sandbox only accepts `running` work items.
- Work-item state changes and audit events are written in one SQLite transaction.
- Policy decisions are audited as `policy.decided`; approvals are stored by work item and exact action hash as `approval.granted` with approver and reason.
- Running work has a worker lease; startup reaps expired leases as failed.
- The eval harness checks for `work_item.running` events that appear before approval.

## Deferred Hardening

Gateway and MCP hardening must bind approvals to authenticated approvers and result submission to worker identity. Real plugin or command execution also needs process isolation before enablement: firejail, nsjail, bubblewrap, Docker, or equivalent. Add that behind `packages/sandbox` instead of teaching callers about the runtime.

Before live long-running execution, add lease renewal and a true cross-process claim contention check.

Layer 2 should also treat `draft` as a reserved ingestion state until a draft creation endpoint exists.
