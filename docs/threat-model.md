# Threat Model

## Boundaries

- HTTP requests enter through `apps/gateway`.
- Durable state is the SQLite audit log in `storage/local.db` by default.
- Worker execution must only consume approved work-item events.
- Sandbox execution is currently dry-run only.

## Controls

- Zod validates public request bodies and event shapes.
- Sensitive keys such as tokens, passwords, API keys, and secrets are redacted before audit events are created.
- High-risk work requires an approval reason.
- The worker only starts rows that are already `approved`; the sandbox only accepts `running` work items.
- The eval harness checks for `work_item.running` events that appear before approval.

## Deferred Hardening

Real plugin or command execution needs process isolation before enablement: firejail, nsjail, bubblewrap, Docker, or equivalent. Add that behind `packages/sandbox` instead of teaching callers about the runtime.
