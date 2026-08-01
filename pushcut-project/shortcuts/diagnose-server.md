# Build “Diagnose Server” Manually

## Contract

Input dictionary:

```json
{
  "schema_version": "1.0",
  "request_id": "diag-20260802-001",
  "idempotency_key": "diag:hp-server:20260802T170000Z",
  "target": "hp-server",
  "operation": "health_check",
  "requested_at": "2026-08-02T17:00:00Z"
}
```

Allowed targets: `all`, `jacen-ubuntu`, `hp-server`, `openclaw`, `hermes`, `acs`, `backups`, `disk`, `tailscale`. Allowed operations: `health_check`, `recent_failures`. No command field is accepted.

## Display-only build (first test)

1. Create **Diagnose Server** and enable it to receive input from other Shortcuts.
2. Add **If**: if Shortcut Input has no value, use a local **Dictionary** with the mock contract above.
3. Add **Get Dictionary from Input**.
4. Add **Get Dictionary Value** for each required field.
5. Use **If** actions to require schema version `1.0`, non-empty request/idempotency keys, an allowed target, an allowed operation, and a parseable requested timestamp.
6. If any check fails, **Show Alert** “Invalid diagnostic request” and **Stop This Shortcut**.
7. For the display-only version, create a mock diagnostic result matching `schemas/diagnostic-result.schema.json`.
8. Render Target, Health status, Evidence, Suspected cause, Recommended action, and Risk level with **Text**, then **Quick Look**.
9. Do not add networking until this version passes malformed-input tests.

## Read-only HTTPS build (later)

1. Replace the mock-result action with **Get Contents of URL** for the fixed `<DIAGNOSTIC_API_BASE>/v1/diagnostics` endpoint.
2. Method: POST. Request body: JSON dictionary containing only the validated contract fields.
3. Authentication must use an approved, narrowly scoped mobile design. Do not paste a durable Pushcut, ACS, SSH, Telegram, or GitHub credential into the action.
4. Parse the response as a dictionary and validate the required diagnostic-result fields before displaying.
5. If the request times out, show “Outcome unknown; query by request ID. No repair was attempted.” Do not start a repair or recursively rerun.
6. For an exact duplicate, the server must return the prior result by idempotency key.

## Optional SSH variant

Only use **Run Script over SSH** for read-only checks after separate approval of the SSH design. Select a fixed host/account and a fixed forced command such as a server-owned `health-summary` wrapper. Never concatenate `target` or user text into the script. Do not add sudo, an unrestricted shell, agent forwarding, or repair commands.

## Output

Return the validated diagnostic dictionary so the Command Center can preview or submit a redacted result ID to an approved relay.
