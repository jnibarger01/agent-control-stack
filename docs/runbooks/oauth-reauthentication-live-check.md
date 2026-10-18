# Live compatibility check: reauthentication detection with real ChatGPT and Claude

Purpose: confirm, with the real apps, what the automated tests only assume. Uses a **disposable lab** (throwaway directory, freshly generated
secrets, short token lifetimes). It never touches production services, tokens or keys.

Status as of 2026-10-17: **not run.** It needs your accounts and, for ChatGPT, a public HTTPS URL, so it has to be done by you or with your explicit go-ahead.

## Start the lab

```bash
cd <a built checkout of this branch>      # needs: npm install && npx tsc -b
node scripts/oauth-compat-lab.mjs --access-ttl 120 --refresh-ttl 900 [--public-origin https://<your-tunnel-host>]
```

It prints the connector URL, a one-time consent passphrase, a Mission Control URL and a disposable operator token, and writes
`<labdir>/evidence.jsonl` (edge request lines with status and `error` presence, never tokens; every Mission Control state change).

- **Claude / local clients:** loopback is enough.
- **ChatGPT:** needs a public HTTPS origin. Starting a tunnel to the printed edge port, and adding a connector in either app, is an account-level action
  that only you should authorize. Stop the tunnel when finished. The consent page is gated by the printed passphrase.

## Scenarios (record the observed result for each app separately)

| #   | Do                                                                                                   | Expect in Mission Control                                                                                     | Record about the app                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A   | Connect; use it; wait past the access lifetime (120 s); use it again                                 | No warning. Evidence shows a 401 with `error="invalid_token"` then a refresh then 200.                        | Did the app refresh silently, or ask you to reconnect?                                                            |
| B   | Connect; leave it unused past the refresh lifetime (900 s)                                           | Row flips to **Reauthentication required** (`refresh_expired`) by itself, with the correct last-success time. | What does the app show when you next use it?                                                                      |
| C   | Stop the lab, delete the client's record from `<labdir>/edge-data/tokens.json`, restart, use the app | Immediate **Reauthentication required** (`refresh_rejected`).                                                 | Does the app prompt to reconnect on its own?                                                                      |
| D   | Click **Reconnect** in Mission Control for the flagged row, follow its steps in the app              | Warning clears by itself after you sign in.                                                                   | Same `client_id` or a new one? (A new one leaves the old row flagged.)                                            |
| E   | Stop the edge for 3 minutes, start it again                                                          | **No** warning at any time.                                                                                   | Does the app recover without reconnecting?                                                                        |
| F   | Connect and leave it idle within the lifetimes                                                       | **No** warning.                                                                                               | -                                                                                                                 |
| G   | Throughout                                                                                           | -                                                                                                             | Did the app ever send a second refresh with an already-used token (a `refresh_reused` flag with no real problem)? |

## What to bring back

`evidence.jsonl`, a screenshot of Mission Control for B/C/D, and for each app and scenario: pass or fail plus the app's own behaviour. Delete the lab
directory afterwards. Do not enable `ACS_MCP_AUTH_EVENTS` anywhere else on the strength of this check without approval.
