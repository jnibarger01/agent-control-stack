# Build “Send Pushcut Notification” Manually

## Preferred design

Do not put a Pushcut API key on the phone. The preferred Shortcut calls a narrow authenticated server-side alert adapter that stores the Pushcut key and accepts a strict notification template ID plus bounded, non-secret values.

## Construction

1. Create **Send Pushcut Notification** and accept a dictionary.
2. Require `template` in a fixed allowlist such as `health-alert`, `task-summary`, `repair-result`.
3. Require a bounded `request_id`, `title`, and redacted `text`; reject unknown keys, URLs, actions, or credential-like fields.
4. Show a complete preview.
5. Choose from Menu: **Send harmless notification** / **Cancel**.
6. On Send, use **Get Contents of URL** with POST to fixed `<ALERT_ADAPTER_URL>/v1/notifications` and the validated dictionary.
7. Use a separately approved, narrowly scoped mobile authentication mechanism. Never use `<PUSHCUT_API_KEY>` in the Shortcut.
8. Display the adapter’s request/submitted-notification ID. Treat it as submission evidence, not proof of delivery.
9. On timeout, query by request ID. Do not recursively call this Shortcut or automatically resend.

## Direct API variant for private experimentation

Only if the user explicitly accepts storing a scoped Pushcut key on the device, use `POST https://api.pushcut.io/v1/notifications/<NOTIFICATION_NAME>` with `API-Key` header. This is less safe because Shortcut details can be inspected/shared. Never use the URL-embedded account secret. Do not use this variant for ACS approvals or repair actions.
