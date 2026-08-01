# Pushcut and Apple Shortcuts Research

Verified 2026-08-02. “Confirmed” means supported by current official documentation or the current App Store listing. Community reports are observations, not guarantees.

## Confirmed Pushcut model

Pushcut is an iPhone/iPad/Apple Watch app that adds remotely triggered, dynamic, actionable notifications, widgets, local triggers, background web actions, and an optional Automation Server to Apple Shortcuts and HomeKit. A normal iOS notification primarily presents information. A Pushcut notification can include actions that open a URL, invoke a Shortcut after a tap, make a background HTTP request, trigger an integration, or ask a separate Pushcut Automation Server device to run a Shortcut.

The Web API is cloud-hosted at `https://api.pushcut.io/v1` and uses a revocable `API-Key` header. Its OpenAPI document confirms endpoints to list devices and notification definitions, send/cancel notifications, execute/cancel Automation Server actions, and create/delete outbound webhook subscriptions. The older webhook form embeds a single account secret in the URL; Pushcut explicitly warns that anyone holding it can send notifications or execute server actions. Prefer separately revocable API keys in headers.

“Incoming” and “outgoing” webhooks mean different things:

- Incoming to Pushcut: a server calls the notification or execute API.
- Outgoing from Pushcut: notification/background actions or API subscriptions cause Pushcut/device infrastructure to call another webhook.
- Local URL subscriptions can be triggered by a device on its local network, but their availability and trust boundary differ from a public cloud callback.

## Notification actions and Shortcut input

Notifications can have a default action and named actions. Supported patterns include a Shortcut name, URL, background HTTP request, online integration, HomeKit scene, or Automation Server action. Dynamic JSON can override title, text, image, devices, input, actions, sound, scheduling, identifiers, and time-sensitive delivery when the plan supports it.

A user-tapped Shortcut action receives the configured `input`. An Automation Server `/execute` request can pass a string or JSON object; the Shortcut can use **Get Dictionary from Input**. A Shortcut can return text, HTML, or a dictionary. A returned dictionary becomes JSON when the caller waits for a response.

Notification delivery is not proof that an action executed. HTTP 200 means Pushcut accepted/sent the notification; it does not prove APNs delivery, human interaction, downstream webhook success, ACS approval, or repair completion.

## Automation Server

Confirmed requirements and limits:

- A dedicated iOS device running iOS 14 or later with internet connectivity.
- Pushcut must remain visible in the foreground and the device must remain powered/online.
- Shortcuts must complete without user interaction so control returns to Pushcut.
- Requests execute strictly one at a time; queued requests older than five minutes fail.
- Default synchronous wait is 10 seconds. Extended permits a longer requested wait, but the maximum is 45 seconds.
- `nowait` returns HTTP 202 without reporting eventual success or failure.
- A 504 is ambiguous: the Shortcut may still finish, so a destructive action must not be retried automatically.
- Pushcut recommends keeping Shortcuts under about 60 seconds; longer runs can make the server appear disconnected.
- Pro includes 100 Automation Server requests and 10 MB input/results per device-local day. Server Extended raises this to 5,000 and 100 MB and enables interval schedules, delayed execution, and longer waits.

The dedicated server device can run while physically locked only if the Pushcut app remains the active foreground app and the particular Shortcut actions require no unlock or interaction. This is action-dependent, not a blanket guarantee. Actions that open UI, request permissions, show prompts, or depend on another app foregrounding can stall the server.

Current release notes show active maintenance but also recent fixes for network reconnection, “Ready” servers timing out, and iOS 26.5 breaking x-callback-url import. Community reports describe hanging Shortcuts and reconnect failures. Therefore Automation Server is useful for convenience-grade bounded work, but production-critical infrastructure control needs an independent server-side source of truth, health monitoring, timeout handling, and manual fallback.

## Plans and pricing

The official site listed these US prices on 2026-08-02:

| Plan                       | Current boundary                                                                                                                                | Listed price                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Free                       | 3 notification definitions, 1 action/notification, 2 background actions; predefined/basic webhook use without dynamic content or online actions | $0                                           |
| Pro                        | Unlimited notification definitions/actions/background actions, dynamic JSON/input, web actions, widgets, Automation Server with base quota      | $1.99/month, $17.99/year, or $39.99 lifetime |
| Automation Server Extended | 5,000 requests/day, 100 MB/day, periodic schedules, delays, longer synchronous waits                                                            | $2.49/month or $22.49/year                   |

Prices and plan boundaries can change; verify in the App Store purchase dialog before spending.

No general notification API per-minute rate limit was found in official documentation. The documented numeric limits apply to Automation Server daily requests/data. Treat any claimed five-minute notification interval or other community throughput number as unverified. Apply client-side coalescing and backoff regardless.

## Apple Shortcuts patterns

Apple confirms that Shortcuts can call web APIs with **Get Contents of URL**, including common HTTP methods and JSON bodies; parse JSON as dictionaries/lists; branch with **If**; and use x-callback-url success, cancellation, and error callbacks. Personal automations are device-specific rather than synchronized, and only listed trigger categories can run without “Ask Before Running”; individual actions may still require permission.

The **Run Script over SSH** action is suitable for a bounded read-only command when the host key, user, and narrow command are fixed. For this project, direct SSH from a phone is not the repair path: it would move powerful credentials and authorization logic onto the device. Prefer an authenticated HTTPS diagnostic API or ACS work item. If SSH is used for diagnosis, use a dedicated non-privileged account, forced commands/allowlist, Tailscale reachability, host-key verification, short timeout, no agent forwarding, and no shell text assembled from untrusted input.

Apple Shortcuts does not provide a verified general-purpose programmable secret vault for arbitrary API tokens. Credentials embedded in URL/action fields are visible to someone who can inspect or share the Shortcut. Keep Pushcut API keys on servers. For callbacks, use a narrowly scoped mobile authentication design; do not put a durable ACS bearer secret or approval capability in notification JSON.

## Reliability and failure design

Every workflow should carry `request_id`, `idempotency_key`, target, creation time, expiration, and—for repair proposals—the ACS work item and immutable action hash. The receiver owns deduplication. A Pushcut identifier can replace/cancel a delayed request or notification, but it is not a general exactly-once guarantee.

Recommended state machine:

```text
received -> validated -> accepted_once -> diagnosing -> completed|failed
proposed -> awaiting_approval -> approved|rejected|expired
approved -> ACS_revalidated -> claimed_with_lease -> executed_once -> audited
```

Retry read-only GET-style diagnostics with capped exponential backoff and jitter. Retry a notification submission only when it is known not to have been accepted, and coalesce repeated alerts. Never automatically retry a repair after a timeout, connection reset, 202, or 504; query ACS by idempotency key/work item instead.

Loops must have a finite hop count and terminal states. Do not wire Pushcut notification -> Shortcut -> webhook -> same notification without a correlation record and suppression rule.

## Security findings and recommendations

1. The webhook URL secret grants broad account capability and leaks through history/logs. Use revocable API keys in headers, server-side only.
2. Notification actions can call arbitrary URLs and can be dynamically overridden. Treat notification payloads and Shortcut input as untrusted; validate schema and allowlist destinations/actions.
3. A tap is not sufficient authorization. ACS must authenticate the approver and validate action hash, scope, expiry, revocation, one-time use, policy, and lease fencing.
4. Device names target delivery but do not provide cryptographic device identity.
5. Automation Server timeouts are ambiguous. Never retry state changes automatically.
6. Shortcuts that concatenate shell commands permit injection. Use fixed commands or structured arguments mapped through an allowlist.
7. Notifications may expose command details on a lock screen. Show a safe summary; reveal full exact action only inside an authenticated approval surface.
8. Cloud transit means this is local-first, not cloud-free. Keep sensitive diagnostic evidence and secrets out of Pushcut payloads.

## Fit with OpenClaw, Hermes, Telegram, GitHub, and ACS

- OpenClaw/Hermes: create read-only diagnostic or research work items and return summaries; no direct arbitrary prompt-to-shell bridge.
- ACS: sole authority for policy, approval, action binding, execution, lease fencing, and audit.
- Telegram: optional result channel after redaction; it is not an approval source unless separately authenticated and governed.
- GitHub: send workflow/deployment summaries from GitHub Actions with an encrypted repository secret; do not let a notification button deploy directly.
- Uptime Kuma: call a small alert adapter that deduplicates events, creates diagnostic work, and sends one actionable Pushcut notification.
- Tailscale: private reachability layer, not authorization by itself.
