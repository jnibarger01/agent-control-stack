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

## Troubleshooting

- **A client is missing.** Connect events are throttled to one per minute per client; calls appear immediately.
  Check the edge log for `client observation ... failed`.
- **"Earlier callers without a client ID".** Calls recorded before this feature. They cannot be labelled.
- **Label button fails.** Labelling needs a human operator credential with `acs:approve`, and the client must
  have been seen by this gateway.
- **Counts look low after a restart.** The index is rebuilt from the retained audit log (up to 20,000 events
  per event type).
