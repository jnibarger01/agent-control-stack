---
name: pushcut-shortcuts-expert
description: Design, review, test, and troubleshoot safe Pushcut and Apple Shortcuts workflows, including Web API notifications, Automation Server actions, JSON payloads, SSH/API calls, approvals, retries, idempotency, and integrations with OpenClaw, Hermes, ACS, Telegram, GitHub, Uptime Kuma, Tailscale, and homelab infrastructure. Use when a request mentions Pushcut, actionable iOS notifications, remotely triggered Shortcuts, Pushcut Automation Server, or mobile approval workflows.
---

# Pushcut Shortcuts Expert

Version: 1.0.0  
Last verified: 2026-08-02

Design Pushcut as a notification and interaction edge, not as an authorization authority. Prefer official Pushcut and Apple documentation and label community behavior as anecdotal.

## Required inputs

Gather only what the design needs. Never request a secret through chat.

- desired outcome and read-only versus state-changing boundary;
- Pushcut plan, receiving device names, notification/reference name;
- whether a dedicated foreground Automation Server device exists;
- server endpoints, Tailscale reachability, and timeout needs;
- allowed targets/services/actions and authoritative approval system;
- local secret location, expressed as an environment-variable name only;
- result/audit destinations and retention/redaction needs.

Use `<PUSHCUT_API_KEY>`, `<NOTIFICATION_NAME>`, `<DEVICE_NAME>`, `<ACS_BASE_URL>`, and `<SHORTCUT_NAME>` in artifacts.

## Non-negotiable safety rules

1. Never place Pushcut secrets, webhook-secret URLs, SSH keys, durable ACS credentials, Telegram tokens, or GitHub tokens in prompts, screenshots, repositories, examples, notification bodies, or logs.
2. Prefer revocable `API-Key` headers and environment variables over the URL-embedded account secret.
3. Read-only checks are allowed by default. Repair, restart, update, delete, send, deploy, or configuration change requires explicit, current approval.
4. Before approval, show target, exact structured command/API action, expected effect, risk, rollback, and expiration.
5. Approval must bind authenticated principal, work item, immutable action hash, scope, expiration, revocation state, and one-time consumption. A notification tap alone is not approval.
6. The receiver must deduplicate by idempotency key. Duplicate callbacks must not duplicate work.
7. Never automatically retry a destructive or ambiguous action. A Pushcut `202` or `504` is not proof of success or failure.
8. Never create an unbounded Pushcut -> Shortcut -> webhook -> Pushcut loop. Require a hop limit, correlation ID, suppression window, and terminal state.
9. Treat Shortcut input, HTTP input, notification payloads, target names, and callback data as untrusted. Validate schemas and map enums to fixed operations.
10. Never concatenate untrusted text into an SSH/shell command. Use fixed commands, structured arguments, allowlists, a non-privileged account, and short timeouts.
11. Preserve existing configuration before any approved modification. Stop before modifying a real system unless the user has explicitly authorized it.
12. Test dry-run/mock paths first. Never claim delivery, execution, approval, or success without observed evidence.

## Decision tree

```text
Is the goal only an alert or menu?
  yes -> Pushcut notification API; no Automation Server required
  no  -> Does it need an iOS-local Shortcut without a tap?
          yes -> dedicated foreground Automation Server; bounded read-only work first
          no  -> use an authenticated server/API action

Does the action change state?
  no  -> validate -> dedupe -> bounded diagnostic -> redacted result
  yes -> create proposal -> authenticate approver -> exact action-hash approval
         -> recheck policy/expiry/lease -> execute once -> audit -> report

Did the call time out or return 202/504?
  read-only -> query by request ID, then capped retry if safe
  state-changing -> never repeat; reconcile against authoritative audit/state
```

## Pushcut terminology

- **Notification definition**: named/reference-ID configuration stored in Pushcut.
- **Smart notification**: a delivered notification whose dynamic payload may override title, text, actions, input, devices, image, sound, or schedule.
- **Action**: a user-selectable Shortcut, URL, background request, integration, HomeKit scene, or server action.
- **Background action**: a Pushcut-managed web/integration/server action that may run without opening UI; not proof of downstream success.
- **Automation Server**: Pushcut running visibly on a dedicated powered iOS device and executing enabled Shortcuts sequentially.
- **Server action**: enabled Shortcut or HomeKit scene exposed by Automation Server.
- **API key**: revocable credential sent in the `API-Key` header.
- **Webhook secret**: broader account secret embedded in legacy URLs; avoid where feasible.
- **Identifier**: replacement/cancellation key for scheduled notifications/actions, not a universal idempotency guarantee.

## Workflow

1. Classify the workflow: alert, interactive menu, read-only diagnostic, or mutation.
2. Draw both trust and data flows. Identify Pushcut cloud, APNs, receiving device, dedicated server device, callback service, ACS, and target host.
3. Choose notification versus Automation Server using the decision tree.
4. Define strict request/result schemas with timestamps, bounded fields, `request_id`, and `idempotency_key`.
5. Keep powerful credentials and execution on the server. Use Pushcut only for minimum necessary presentation/input.
6. Build the Shortcut manually with validation, explicit failure branches, timeouts, and no arbitrary URL/command construction.
7. Test in order: schema, mock, dry-run, malformed, missing credential, timeout, duplicate, expired/rejected approval, approved harmless action, audit/redaction.
8. Only after explicit approval, send one harmless live notification and capture non-secret evidence.

## API patterns

Use `https://api.pushcut.io/v1` with `API-Key: <PUSHCUT_API_KEY>`.

- `GET /devices`: list active devices.
- `GET /notifications`: list definitions.
- `POST /notifications/{notificationName}`: send/schedule a smart notification.
- `DELETE /submittedNotifications/{notificationId}`: cancel/remove a submitted notification.
- `POST /execute?shortcut=<SHORTCUT_NAME>`: execute a server Shortcut.
- `POST /cancelExecution?identifier=...`: cancel a delayed server request.
- `/subscriptions`: manage outbound online-action webhooks.

Default all generated clients to dry-run. Never print request headers. Percent-encode path/query components. Enforce connect/read timeouts and payload-size limits. See `examples.md` for language patterns and `references.md` for exact official constraints.

## Shortcut construction pattern

Build this spine in Apple Shortcuts:

1. Accept Shortcut Input; otherwise use a local mock dictionary.
2. Get Dictionary from Input.
3. Validate required keys, allowed target/action, timestamp, expiry, and version with nested **If** actions.
4. Derive no URLs or shell commands from raw input.
5. For read-only work, call one fixed HTTPS endpoint with a JSON body and timeout-aware failure branch.
6. For a mutation, display exact proposal and call only an authenticated ACS decision endpoint; never execute the repair locally.
7. Parse the bounded JSON response, render result, and optionally send a redacted result to an approved destination.
8. Stop with a clear error for malformed, duplicate, expired, or mismatched input.

## Troubleshooting

Read `troubleshooting.md` when delivery, action execution, Automation Server, JSON, callback, or SSH behavior fails. Never “fix” a timeout by adding uncontrolled retries or a broader credential.

## Output contract

For a design/review, return:

```text
Verdict: SAFE TO MOCK | READY FOR HARMLESS TEST | BLOCKED
Confirmed facts:
Assumptions/unknowns:
Trust and data flow:
Notification/API payload (redacted):
Manual Shortcut steps:
Approval and idempotency controls:
Failure/timeout behavior:
Test evidence:
Inputs still needed (secret locations, never values):
```

For a repair proposal, return exactly:

```text
Target machine:
Exact command or API action:
Expected effect:
Risk:
Rollback:
Approval expires:
Work item / action hash:
```

## References

Read `references.md` for current limits and sources, `examples.md` for safe language/API/workflow examples, and `troubleshooting.md` for diagnostic procedures.
