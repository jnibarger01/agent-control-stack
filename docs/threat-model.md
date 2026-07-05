# Threat Model

## Boundaries

- HTTP requests enter through `apps/gateway`.
- Durable state is the SQLite audit log in `storage/local.db` by default.
- Worker execution must only consume approved work-item events.
- Sandbox execution is currently dry-run only.
- Layer 1 has no HTTP authentication. `approvedBy` and result submission identity are caller-supplied local-dev fields until Layer 2 adds real approver and worker identity.

## Controls

- Zod validates public request bodies and event shapes.
- Sensitive keys such as tokens, passwords, API keys, and secrets are redacted before audit events are created.
- High-risk work requires an approval reason.
- The worker only starts rows that are already `approved`; the sandbox only accepts `running` work items.
- Work-item state changes and audit events are written in one SQLite transaction.
- Running work has a worker lease; startup reaps expired leases as failed.
- The eval harness checks for `work_item.running` events that appear before approval.

## Deferred Hardening

Layer 2 must bind approvals to authenticated approvers and result submission to worker identity. Real plugin or command execution also needs process isolation before enablement: firejail, nsjail, bubblewrap, Docker, or equivalent. Add that behind `packages/sandbox` instead of teaching callers about the runtime.
