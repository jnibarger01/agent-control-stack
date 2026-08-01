# Troubleshooting Workflow

## Start with evidence

Record non-secret request ID, timestamp/time zone, endpoint class, HTTP status, Pushcut submitted notification ID, intended device/reference name, Automation Server status, and downstream ACS/audit correlation. Never record the API key, webhook-secret URL, Authorization header, SSH material, or unrestricted payload.

## Notification not received

1. Confirm the client actually executed rather than dry-ran.
2. Distinguish DNS/TLS/connect error from Pushcut HTTP response.
3. 401/403: key missing/revoked/invalid; do not print it.
4. 404: notification/reference name not found.
5. 400: validate JSON and device names.
6. 200 only proves Pushcut accepted the submission. Check iOS notification permission, Focus/time-sensitive settings, target device, Pushcut account synchronization, and the app’s notification log.
7. Coalesce further alerts; do not flood retries.

## Notification action does not run

Confirm whether the action is a tapped Shortcut, background web request, or server action. A Shortcut action may need the device unlocked or permission. Apple Watch does not support every action type. Validate the fixed URL/method/body and check the downstream service by correlation ID.

## Automation Server timeout/offline

1. Confirm the dedicated device is powered, online, and Pushcut is visible in the foreground.
2. Confirm the desired Shortcut is imported, enabled as a server action, and requires no interaction.
3. Inspect pending requests/history without clearing or restarting unless approved.
4. Check for a prior hanging Shortcut; execution is sequential.
5. Treat 202/504 as ambiguous. Query the authoritative downstream state; never repeat a mutation.
6. Keep normal synchronous work under 10 seconds; do not purchase Extended merely to hide an architectural timeout.

## JSON/input failure

Validate content type, size, top-level dictionary, schema version, required fields, enum values, RFC 3339 timestamps, and expiration before doing work. In Shortcuts, use **Get Dictionary from Input** and explicit **If** branches. Stop on unknown actions or extra privileged fields.

## SSH failure

Check Tailscale reachability, DNS, host-key fingerprint, dedicated username, forced-command/allowlist configuration, and timeout. Do not disable host-key checks, add sudo, forward an agent, broaden firewall rules, or change SSH configuration as a troubleshooting shortcut.

## Duplicate or loop

Look up the idempotency key before execution. Return the stored result for an exact duplicate; reject same key with different content. Check origin/correlation/hop count and terminal state. Disable the alert adapter before investigating a live loop, but obtain approval before changing a running service/configuration.

## Approval failure

Verify authenticated actor, work item, action hash, scope, expiry, revocation, use count, policy decision, current lease, and target binding. Any mismatch fails closed. Never “fix” approval by accepting a notification tap, device name, Tailscale source address, or caller-supplied identity as sufficient authority.

## Test checklist

- schema accepts each example and rejects malformed/extra fields;
- dry-run reveals no secret and makes no request;
- missing-key execution fails before network;
- display-only Shortcut renders mock data;
- timeout produces an explicit unknown/ambiguous state;
- duplicate request executes at most once;
- expired and rejected approvals never execute;
- approved harmless action is exact, audited, and not retried;
- logs and Git scan contain no secret values.
