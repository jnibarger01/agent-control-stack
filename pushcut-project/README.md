# Pushcut Infrastructure Command Center

Last verified: 2026-08-02

This project is a research-backed, mock-tested foundation for using Pushcut and Apple Shortcuts as a mobile presentation and interaction layer for infrastructure and agent operations. It deliberately keeps authorization, repair execution, audit, and idempotency in Agent Control Stack (ACS).

## Current status

- Research and architecture: implemented and source-linked.
- Reusable `pushcut-shortcuts-expert` skill: implemented and locally validated.
- Payload schemas and examples: implemented and locally validated.
- Notification clients: implemented with dry-run as the default.
- Manual Shortcut construction guides: implemented; no unverifiable `.shortcut` binary is included.
- Live Pushcut notification: not sent. It requires explicit approval and a locally supplied API key.
- Live diagnosis or repair: not connected. No infrastructure, ACS, SSH, Tailscale, Telegram, or service configuration was changed.

## Safety boundary

Pushcut is not an approval authority. A notification action is only a request to ACS. ACS must authenticate the actor, bind the decision to the work item and immutable action hash, enforce expiration and one-time consumption, recheck policy, fence the worker lease, and append audit events before execution.

The project uses `<PUSHCUT_API_KEY>`, `<NOTIFICATION_NAME>`, `<DEVICE_NAME>`, and similar placeholders. Never replace them in tracked files.

## Architecture

There are two separate Pushcut paths:

```text
Human decision path
Agent or monitor -> Pushcut Web API -> actionable notification
-> human taps Diagnose / Approve / Reject -> authenticated ACS endpoint
-> ACS policy + approval + audit + worker -> Pushcut and/or Telegram result

Unattended Shortcut path (optional)
Agent or monitor -> Pushcut Execute API -> Pushcut cloud
-> dedicated, powered, foreground iOS Automation Server -> read-only Shortcut
-> HTTPS/SSH diagnostic -> bounded response or separately correlated callback
```

The first path is the recommended foundation. The second is optional because it requires a dedicated foreground iOS device and has sequential execution, queue, timeout, and reconnect limitations.

## Start safely

1. Read `research/recommendations.md` and the Shortcut guides.
2. Keep every client in its default dry-run mode.
3. Choose a Pushcut notification name and device name locally.
4. Store the API key in a protected environment variable, never in a Shortcut screenshot or repository.
5. Validate a display-only Shortcut using mock JSON.
6. Ask for explicit approval before the first harmless live notification.
7. Connect read-only health endpoints before designing any repair action.

## Dry-run examples

```bash
PUSHCUT_API_KEY='<PUSHCUT_API_KEY>' \
  ./scripts/send-pushcut.sh \
  --notification '<NOTIFICATION_NAME>' \
  --payload examples/health-alert.json

python3 scripts/pushcut-client.py \
  notify --notification '<NOTIFICATION_NAME>' \
  --payload examples/health-alert.json
```

Neither command sends a request unless `--execute` is added. `--execute` is intentionally a conspicuous opt-in and is not used by the test plan.

## Directory guide

- `research/`: findings, evaluated sources, use cases, and recommendations.
- `skills/`: reusable agent skill and supporting references.
- `shortcuts/`: exact manual Apple Shortcuts construction instructions.
- `scripts/`: dry-run-first shell, PowerShell, Python, and TypeScript clients.
- `schemas/`: strict JSON Schema 2020-12 contracts.
- `examples/`: non-secret sample payloads.
- `tests/`: test matrix and validation record template.
