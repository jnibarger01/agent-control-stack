# Payload Test Plan

No live endpoint is used by these tests.

## Schema mapping

- `examples/approval-request.json` -> `schemas/repair-request.schema.json`
- an inline healthy/degraded result -> `schemas/diagnostic-result.schema.json`
- inline approved/rejected decisions -> `schemas/approval.schema.json`
- `examples/health-alert.json` is a Pushcut notification payload; validate as a JSON object and inspect against the official OpenAPI before a live test.
- `examples/repair-result.json` is a reporting example; it is intentionally not an ACS execution receipt.

## Negative fixtures

Generate in memory or a temporary directory, never tracked files:

1. malformed JSON;
2. missing `action_hash`;
3. extra `command` field in a diagnostic result;
4. action hash with non-hex data;
5. unknown target/service;
6. approval with `one_time_use: false`;
7. expired approval timestamp;
8. same idempotency key with changed content;
9. rejected decision;
10. response larger than the configured maximum.

JSON Schema validates shape and format. Expiry ordering, hash recomputation, identity, one-time consumption, idempotency conflicts, policy, and lease fencing must be tested in ACS runtime code; schemas alone cannot enforce them.

## Harmless-action definition

An “approved harmless action” must be an explicitly approved ACS fixture or demonstration operation that changes only isolated temporary test state and has observed audit evidence. `systemctl restart example-demo.service` in the example is descriptive only and must not be executed unless such an inert fixture really exists and the user approves it.
