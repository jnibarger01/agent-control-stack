# Build “Infrastructure Command Center” Manually

No binary `.shortcut` file is provided. Action names can vary slightly by iOS locale/version. Build and inspect each step on the device.

## Purpose

Present a reusable menu. Read-only checks call the separate **Diagnose Server** Shortcut. State-changing choices only fetch or review an ACS proposal; they never run a repair locally.

## Prerequisites

- The **Diagnose Server** and **Approve Repair** Shortcuts from the adjacent guides.
- Locally configured `<DIAGNOSTIC_API_BASE>` and `<ACS_REVIEW_URL>` only after their authentication design is approved.
- No Pushcut API key. Notification-sending credentials remain server-side.

## Construction

1. Create a Shortcut named **Infrastructure Command Center**.
2. Add **Dictionary** named `Context` with:
   - `schema_version`: `1.0`
   - `request_id`: initially blank
   - `target`: `all`
   - `operation`: `health_check`
3. Add **Choose from Menu** with these entries:
   - Check all systems
   - Check jacen-ubuntu
   - Check hp-server
   - Check OpenClaw
   - Check Hermes
   - Check ACS
   - Check backups
   - Check disk usage
   - Check Tailscale status
   - View recent failures
   - Request safe diagnosis
   - Propose repair
   - Review pending repair
   - Restart a selected service
   - Open dashboards
   - Send result to Telegram
4. In every read-only **Check** branch, set `target` to the matching allowlisted value and set `operation` to `health_check`; use **Run Shortcut** -> **Diagnose Server** with `Context` as input.
5. For **View recent failures**, set target `all`, operation `recent_failures`, then run **Diagnose Server**.
6. For **Request safe diagnosis**, add **Choose from List** containing only the supported target values. Set target and run **Diagnose Server**. Never use free-form text as a hostname or command.
7. For **Propose repair**, show: “A repair may only be proposed after a current diagnosis. This Shortcut does not execute repairs.” Then open the authenticated ACS work-item review page. Do not accept a command from user input.
8. For **Review pending repair**, run **Approve Repair** with the selected/fetched ACS proposal dictionary.
9. For **Restart a selected service**, show: “Restart requests require an exact ACS proposal and explicit approval.” Then run **Approve Repair**. Do not include an SSH or `systemctl` action here.
10. For **Open dashboards**, use **Choose from List** of fixed HTTPS dashboard URLs. Do not open a URL received from Shortcut Input.
11. For **Send result to Telegram**, show a preview of the already redacted result and ask **Choose from Menu: Send / Cancel**. On Send, call an authenticated server-side relay with the result ID only. Do not store a Telegram token in Shortcuts.
12. End every branch with **Stop This Shortcut** so no branch falls through.

## Pushcut entry

Create a Pushcut notification action named **Command Center** that runs this Shortcut after a user tap. Pass a small dictionary with `request_id`, `target`, and `operation`. The Shortcut must validate these fields before using them. A notification action is navigation, not approval.

## Acceptance test

- Run each branch with local mock input.
- Confirm all target/action choices are fixed lists.
- Confirm repair/restart branches cannot reach SSH, shell, or an execution endpoint.
- Confirm Telegram requires a separate Send confirmation and sends only a result ID.
- Lock the phone and test only after a harmless live notification is separately approved; record which actions request unlock/permission.
