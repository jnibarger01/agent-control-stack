# Safe Examples

All examples use placeholders. Keep credentials in protected local secret storage.

## Curl: dry-run-shaped notification request

```bash
curl --fail-with-body --silent --show-error \
  --connect-timeout 5 --max-time 15 \
  -X POST \
  -H 'Content-Type: application/json' \
  -H 'API-Key: <PUSHCUT_API_KEY>' \
  --data-binary @health-alert.json \
  'https://api.pushcut.io/v1/notifications/<NOTIFICATION_NAME>'
```

Do not paste the resulting command with a real header into chat, shell history, or CI logs. Prefer the project clients, which read the key from `PUSHCUT_API_KEY` and dry-run by default.

## PowerShell

```powershell
$headers = @{ 'API-Key' = $env:PUSHCUT_API_KEY }
Invoke-RestMethod -Method Post `
  -Uri 'https://api.pushcut.io/v1/notifications/<NOTIFICATION_NAME>' `
  -Headers $headers `
  -ContentType 'application/json' `
  -InFile '.\health-alert.json' `
  -TimeoutSec 15
```

## Read-only diagnostic input

```json
{
  "schema_version": "1.0",
  "request_id": "diag-20260802-001",
  "idempotency_key": "diag:all:20260802T120000Z",
  "target": "all",
  "operation": "health_check",
  "requested_at": "2026-08-02T17:00:00Z"
}
```

Map `target` and `operation` to fixed server-side functions. Do not accept a `command` field for diagnosis.

## Two-stage approval

```text
1. Monitor creates read-only diagnostic work.
2. ACS returns evidence and an optional repair proposal.
3. Pushcut shows a redacted summary and an authenticated “Review” link/action.
4. Authenticated mobile surface fetches the proposal from ACS.
5. User sees exact action, effect, risk, rollback, and expiration.
6. Approve/Reject posts only work_item_id, action_hash, decision, and fresh authentication context.
7. ACS validates and records; the worker rechecks policy and consumes approval once.
8. Result is audited and a new result notification is sent.
```

## Loop guard

Include `origin`, `correlation_id`, `hop_count`, and `terminal`. Reject `hop_count > 3`; do not generate a new alert for an event whose `origin` and terminal correlation were already acknowledged inside the suppression window.
