# Deployment readiness report: OAuth reauthentication detection

Date 2026-10-17. Status: **NOT approved for merge, deployment, flag activation or credential migration.** Nothing has been deployed or changed outside
this branch and throwaway lab directories. Production services on this machine were not touched.

## 1. Test evidence

All runs are on self-contained trees (own `npm install`; see [baseline](oauth-reauthentication-detection-baseline.md)). The feature tree is clean `HEAD`
plus this branch's diff.

| Check                                                                | Clean HEAD                        | Feature tree                                                                                              |
| -------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `npx tsc -b --pretty false`                                          | exit 0, 0 errors                  | exit 0, 0 errors                                                                                          |
| `env -u ACS_GATEWAY_TOKEN npx vitest run`                            | 4325 passed, 91 skipped, 0 failed | **4367 passed, 91 skipped, 0 failed**                                                                     |
| Tests that passed at HEAD and do not now                             | -                                 | **0**                                                                                                     |
| New tests                                                            | -                                 | 42 (all pass): auth health 16, ingress classification 9, end-to-end 8, Mission Control 5, gateway route 4 |
| Edge suite `node --test apps/dc-mcp-gateway/test/*.test.mjs`         | 89 pass                           | **126 pass** (37 new: classification, real-process OAuth, security)                                       |
| JC CLI test, via `npm ci` + full `tsc` in `vendor/desktop-commander` | -                                 | 9 pass; device-login and cli tests still pass                                                             |
| `npm run contracts:check`                                            | current                           | current (additive: one new route)                                                                         |
| ESLint on changed code                                               | -                                 | clean                                                                                                     |

Real browser (built-in browser pane against a disposable lab, not production): a flagged client showed the alert bar, the "1 needs reauthentication" count,
the reason, last successful authentication and **Reconnect**; the Reconnect dialog listed the steps and sent nothing; after the client completed the
real authorize + consent + PKCE flow, the alert and row cleared live, without a page reload.

### Acceptance criteria

| Criterion                                                                        | Evidence                                                                 | Status                                                                  |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Real expired/revoked connection shows reauthentication without manual disconnect | end-to-end tests with a protocol-faithful client; lab run                | **Passes in simulation. Not yet verified with real ChatGPT or Claude.** |
| Outages never warn                                                               | ACS down, edge down (CLI), JWKS/network failure (503 not 401)            | Pass in tests                                                           |
| Idle sessions never warn                                                         | idle test, flag-off test                                                 | Pass in tests                                                           |
| Expired-but-refreshable access token never warns                                 | e2e + edge tests                                                         | Pass in tests                                                           |
| Reconnect works end to end                                                       | real authorize/consent/token flow clears the row (test and real browser) | Pass in tests and lab                                                   |
| No authentication weakening                                                      | [security review](oauth-reauthentication-security-review.md)             | Pass after 3 fixes; one self-review, no independent review yet          |

## 2. Not yet verified (blocks activation)

1. **Real ChatGPT and Claude.** Needs your accounts and, for ChatGPT, a public HTTPS URL; protocol in
   [the live-check runbook](../runbooks/oauth-reauthentication-live-check.md). Unknowns it must settle: do the apps refresh on `401 invalid_token`; do they
   reuse the same `client_id` on reconnect (otherwise the old row stays flagged); do they ever double-submit a refresh.
2. Independent security review (this one was by the implementer).
3. Edge behaviour under the production data directory's real `clients.json` (confidential vs public registrations are not known).

## 3. Remaining risks

| Risk                                                                                                                                                                                   | Impact                                                                                    | Mitigation                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| A reconnect that registers a **new** `client_id` leaves the old row flagged forever                                                                                                    | Stale alert bar                                                                           | Verify in live check; if it happens add an operator "dismiss" action before activation                                |
| Reuse ambiguity (duplicate request vs lost response vs replay) shows as reauthentication required                                                                                      | Possible false alert if an app double-submits and has not yet used its successor          | `refresh_superseded` suppression covers the common case; live check item G                                            |
| Always-on edge changes ship with the deploy, flags or not: `error="invalid_token"`, refresh bound to its `client_id`, confidential-client auth on refresh, atomic `tokens.json` writes | A client that omits `client_id`+secret oddly, or mishandles the new challenge, could fail | Compatible for clients that send `client_id` or the secret as in the code exchange; verify on the lab; rollback below |
| Edge is single-instance                                                                                                                                                                | A second instance sharing `tokens.json` could race                                        | Do not run two                                                                                                        |
| Ingress change (503 for verifier outages)                                                                                                                                              | A client that treats 503 as fatal                                                         | Only for the Vercel ingress path; standard retry semantics                                                            |
| Auth health exists only where the edge reports; Vercel ingress reports nothing                                                                                                         | Gap for that path                                                                         | Documented                                                                                                            |

## 4. Rollout sequence (when, and only when, approved)

1. Independent review and the live check pass; you approve in writing.
2. Deploy the **ACS gateway** (additive route and read model; unknown audit events are ignored by old readers). Flags untouched.
3. Deploy the **edge** with both flags off. Observe a day: `401` responses now carry `error="invalid_token"` for bad tokens; existing clients keep working;
   `tokens.json` shows mode 0600 and new bookkeeping fields (`rotatedAt`, `successor`).
4. Deploy Mission Control (ships with the gateway) and the ingress change if that path is in use.
5. Enable `ACS_MCP_AUTH_EVENTS=1` on the edge **only after approval**, one lane first (JC), restart the edge, watch Mission Control for false alerts for a day.

## 5. Rollback

- Fastest: unset `ACS_MCP_AUTH_EVENTS`, restart the edge. Reporting stops; Mission Control keeps its last state and the derived expiry view remains.
- Edge code: point the release symlink back to the previous release directory and restart. `tokens.json` stays compatible: the new fields are additive and
  ignored by old code; a leftover `*.tmp` file is harmless.
- ACS gateway: revert to the previous release. `mcp_client.auth_event` audit rows are inert for the old version. No migration to undo.
- No credential is rewritten at any step, so there is nothing to roll back in token data.

## 6. Exact configuration defaults

| Setting                                                               | Default                                                                               | Notes                                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `ACS_MCP_AUTH_EVENTS`                                                 | unset = **off**                                                                       | Only `1` enables the edge's reports to ACS                     |
| `EDGE_TEST_MODE`, `EDGE_TEST_ACCESS_TTL_S`, `EDGE_TEST_REFRESH_TTL_S` | unset                                                                                 | Lab only. Production lifetimes: access 3600 s, refresh 30 days |
| `ACS_MCP_CLIENT_POLICY`                                               | `observe`                                                                             | Unchanged                                                      |
| Refresh rotation                                                      | strict                                                                                | Unchanged by default                                           |
| Always on, no flag                                                    | challenges, refresh classification, client binding, atomic writes, 503 classification | See risk table                                                 |

## 7. Decision requested

Approve or adjust: (a) the live check with your accounts and a tunnel you start, (b) an independent security review, (c) whether to add a "dismiss"
action now. Merge, deployment, flags and credential migration remain unapproved.
