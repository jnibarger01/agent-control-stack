# See and label who connects to /jc/mcp and /mcp

Design: [ADR 0023](../adr/0023-mcp-client-visibility.md). In Mission Control open **Connectors** and find the
**MCP clients** panel. An alert bar appears on every page when an unrecognized client is active.

## What each column means

| Column             | Source                                                   | Trust                                 |
| ------------------ | -------------------------------------------------------- | ------------------------------------- |
| Client ID, subject | OAuth token, verified by the edge                        | Verified                              |
| Says it is         | `initialize.clientInfo` and `User-Agent`                 | **Self-declared. Do not rely on it.** |
| Lane               | Jace Commander (`/jc/mcp`) or Desktop Commander (`/mcp`) | Verified                              |
| Activity           | connects, capabilities issued, denied, last tool         | ACS audit log                         |
| Looks like X       | guess from the claims                                    | Suggestion only, never applied        |

## Identify ChatGPT, Muse and Grok

1. Have each client connect once (add the connector and run any tool, or just let it initialize).
2. It appears within seconds as **Unrecognized**, usually with a suggestion such as "Looks like Muse".
3. Click **Label…**, pick the kind, name it (for example `Muse (Jacen)`) and save.
4. Each client has its own `client_id` only if it registered its own OAuth client. If two clients share one id
   they will show as one row. Check the "Says it is" and subject columns, and register separate OAuth clients
   if you need them apart.

## Block unlabelled clients (optional)

Set on the ACS gateway and restart:

```
ACS_MCP_CLIENT_POLICY=require_label
```

Unlabelled clients then receive `mcp_client_unlabelled` (403) on capability issuance for both lanes. Labelled
clients are unaffected, and approvals, policy and leases still apply to every call. Label your trusted clients
first, because switching this on blocks everyone else immediately. The default is `observe` and an unknown value
refuses to start.

## Edge deployment

The edge must be the version that forwards `x-mcp-client-*` headers and reports to
`/mcp-clients/observe`. Its ACS bridge credentials are the same ones it already uses for issuance
(`ACS_JC_GATEWAY_TOKEN`, `ACS_GATEWAY_TOKEN`); no new secret. If ACS is unreachable the edge keeps serving; only
the visibility is lost. Until the edge is upgraded, calls are still attributed on the ACS side through the
issuance request, but without client names.

## Client IDs that look like `sha256:...`

Ids that are very long (over 256 characters) or that contain secret-shaped text (for example a client-metadata
URL with an `sk-...` segment) are shown as `sha256:<digest>` so they keep one stable identity. Label that row as
usual; the original id passes the gate.

## Troubleshooting

- **A client is missing.** Connect events are throttled to one per minute per client; calls appear immediately.
  Check the edge log for `client observation ... failed`.
- **"Earlier callers without a client ID".** Calls recorded before this feature. They cannot be labelled.
- **Label button fails.** Labelling needs a human operator credential with `acs:approve`, and the client must
  have been seen by this gateway.
- **Counts look low after a restart.** The index is rebuilt from the retained audit log (up to 20,000 events
  per event type).

## Reauthentication required

Design: [ADR 0027](../adr/0027-oauth-reauthentication-detection.md). When a client's authorization is gone, its row shows
**Reauthentication required** with the reason and the last successful authentication, the alert bar on every page names
the client, and **Reconnect** lists the steps. Nothing is sent from the page; the row clears when the client signs in again.

It is never raised for inactivity, outages, a dropped connection, an expired-but-refreshable access token or missing
permissions. A client that is merely quiet shows as not live, not as needing reauthentication. Stored refresh-token
expiry is informational: best-effort reports may miss a successful rotation. Only a confirmed permanent edge failure
raises the warning, normally on the next refresh attempt. Outcomes and reporting throttles are isolated by lane and
authorization family; a newer grant supersedes the old family on that lane.

### Switch (default off, set on the edge)

| Variable                | Effect                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `ACS_MCP_AUTH_EVENTS=1` | The edge reports auth outcomes to ACS. Without it Mission Control shows no auth health. |

RFC 6750 challenges and refresh classification are always on and are not behind either switch.

### Activation gates (do not enable in production until all pass and the operator approves)

1. `cd apps/dc-mcp-gateway && node --test test/*.test.mjs` (authentication, token-replay and outage cases).
2. `npx vitest run apps/gateway/src/mcp-client-auth-health.test.ts apps/gateway/src/mcp-auth-e2e.test.ts apps/vercel-mcp-ingress apps/control-ui` (reconnect, outage classification, UI).
3. `npm run contracts:check`.
4. Isolated live check, with a throwaway edge and ACS (not the production data directory):
   - ChatGPT: connect, then let the access token expire. Expect no warning and a silent refresh.
   - Claude: same.
   - For each, expire or revoke a known refresh record on the throwaway edge, then use the client so it attempts refresh. Expect **Reauthentication required** after the attributable refusal, and clearance after reconnecting. Deleting a record makes the token unattributable and cannot safely flag the client.
   - Stop the edge for several minutes, and separately leave a connected client idle. Expect no warning in either case.
   - Record which `WWW-Authenticate` response each app acted on; this is what confirms their `invalid_token` behaviour.
