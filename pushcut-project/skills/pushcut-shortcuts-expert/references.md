# Pushcut Expert References

Last verified: 2026-08-02.

## Confirmed platform facts

- API base: `https://api.pushcut.io/v1`; authentication is a revocable `API-Key` header.
- Notification submission returns 200 when sent and 202 when scheduled. Neither proves device delivery or downstream action success.
- Automation Server needs a dedicated powered iOS device with Pushcut visible in the foreground.
- Server actions run strictly sequentially; queued requests older than five minutes fail.
- Default synchronous wait is 10 seconds; Extended supports a requested wait up to 45 seconds.
- `nowait` returns 202 without eventual outcome. A 504 can occur while the Shortcut later completes.
- Keep server Shortcuts under about 60 seconds.
- Base server quota: 100 requests and 10 MB/day. Extended: 5,000 and 100 MB/day.
- Pro is required for dynamic JSON/input, unlimited notification actions/background actions, and Automation Server. Extended is required for periodic/delayed execution and longer waits.
- Multiple devices linked through iCloud share the Pushcut account secret, Shortcuts/integrations/server actions. Delivery can target device names, but device name is not authentication.
- Personal Apple automations are device-specific. Trigger auto-run eligibility does not guarantee every action can run while locked.

## Primary sources

- [Pushcut home/pricing](https://www.pushcut.io/)
- [Pushcut OpenAPI](https://api.pushcut.io/openapi.yaml)
- [Automation Server](https://www.pushcut.io/support/automation-server)
- [Notifications, Shortcuts & Triggers](https://www.pushcut.io/support/notifications)
- [Synchronization, Integrations and API](https://www.pushcut.io/support/integrations)
- [Pushcut App Store listing](https://apps.apple.com/us/app/pushcut-shortcuts-automation/id1450936447)
- [Apple Shortcuts User Guide](https://support.apple.com/guide/shortcuts/welcome/ios)
- [Apple x-callback-url](https://support.apple.com/en-au/guide/shortcuts/apdcd7f20a6f/ios)
- [Apple personal automation controls](https://support.apple.com/en-euro/guide/shortcuts/apd602971e63/ios)
- [Apple Get Contents of URL](https://support.apple.com/en-au/guide/shortcuts/apd58d46713f/ios)
- [Apple JSON dictionaries](https://support.apple.com/en-gb/guide/shortcuts/apd0f2e057df/ios)

For the evaluated community-source table and currency warnings, read `../../research/sources.md`.

## ACS-specific correction

Do not design a bearer “approval token.” In this repository, ACS approval is an authenticated, expiring, action-hash/work-item-bound record that is consumed once transactionally after policy re-evaluation and worker lease checks. Pushcut must not self-approve or bypass that path.
