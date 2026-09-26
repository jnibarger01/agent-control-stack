# desktop-commander-mcp-gateway

Production edge for the Desktop Commander MCP server, exposed via Tailscale Funnel.

```
ChatGPT ──HTTPS──► https://jacen-ubuntu.tailaa6d41.ts.net/mcp
                     │ Tailscale Funnel (443)
                     ▼
       auth gateway  127.0.0.1:8010   (server.js: OAuth 2.1 AS + authenticating proxy)
                     ▼ authenticated only
       MCP bridge    127.0.0.1:8002   (bridge.js: stdio ⇄ Streamable HTTP, MCP SDK)
                     ▼ stdio
       Desktop Commander dist/index.js --standalone
```

## Components

- `server.js` — zero-dependency Node HTTP service:
  - OAuth 2.1 authorization server: PKCE S256 (required), Dynamic Client
    Registration (RFC 7591), Client ID Metadata Documents (CIMD),
    RFC 8707 resource binding, refresh-token rotation (single-use).
  - RFC 9728 protected-resource metadata + RFC 8414 AS metadata discovery.
  - `/mcp` proxy: validates HS256 JWT (iss, exp, aud == RESOURCE) before
    forwarding; streams responses (SSE preserved); never logs tokens or args.
  - Identity forwarding: on each authorized `/mcp` request the gateway
    attests the authenticated identity to the executor (`x-dc-agent`,
    `x-dc-client`, `x-dc-attestation` — short-lived HMAC over the identity,
    keyed by `GATEWAY_EXECUTION_TOKEN`). The bearer token is never forwarded;
    client-supplied `x-dc-*` headers are always stripped.
  - Consent page gated by `CONSENT_PASSPHRASE` (typed by the owner in a browser).
- `bridge.js` — MCP SDK stdio→Streamable HTTP multiplexer, bound to 127.0.0.1
  only (replaces Supergateway, which cannot bind loopback). It owns one
  long-lived `StdioClientTransport` and therefore one canonical Desktop
  Commander executor (lease-claimed by DC itself), while creating one
  downstream HTTP transport and session record per client.
  - Downstream request ids are rewritten to gateway-generated upstream ids and
    restored on response, so independent clients may reuse JSON-RPC ids.
  - Downstream `initialize` handshakes are virtualized from the single
    canonical upstream initialization; notifications are forwarded without
    response routes. An unexpected upstream client-directed request or orphan
    response fails closed because it has no deterministic downstream owner.
  - Unknown/mismatched `Mcp-Session-Id` gets HTTP 400
    'session unknown; reconnect and re-initialize'; closing one session leaves
    other sessions live. If the executor crashes, the pair is respawned once
    and existing sessions must re-initialize.
- `test-e2e.sh` — end-to-end flow test (run against `GW=<url>`).

## Jace Commander (`/jc/mcp`)

Optional second MCP resource behind the same OAuth AS and consent passphrase:

```
https://<host>/jc/mcp ─► server.js (bearer aud == JC_RESOURCE)
                          │ managed tools/call: POST ACS /jc/capability/issue
                          │ (ACS_JC_GATEWAY_TOKEN, x-jc-actor) → acs.jc.v1 envelope
                          │ injected at params._meta.acsCapability
                          ▼
   bridge.js BRIDGE_VARIANT=jc  127.0.0.1:8003  (jace-commander-mcp.service)
                          ▼ stdio
   node <dc>/dist/jace-commander/cli.js serve   (managed; never --standalone)
```

- Enabled only when `JC_UPSTREAM` is set in the gateway env. `/jc/mcp` is a
  separate RFC 8707 resource (`JC_RESOURCE`, default `${PUBLIC_ORIGIN}/jc/mcp`)
  with its own metadata at `/.well-known/oauth-protected-resource/jc/mcp`, so
  `/mcp` and `/jc/mcp` tokens are not interchangeable.
- Managed mode requires `ACS_JC_GATEWAY_TOKEN` (a JC bridge worker identity,
  distinct from `ACS_GATEWAY_TOKEN`) or the gateway refuses to start.
- Same bearer check, hop/`x-dc-*` header stripping, identity attestation and
  client `_meta.acs*`/`capability` stripping as `/mcp`. Any ACS failure, or an
  envelope whose `version`/`audience` is not `acs.jc.v1`/`jace-commander`, is a
  503 and nothing is forwarded. `/mcp` likewise rejects `acs.jc.v1` envelopes,
  and each route checks its bridge's `/authority` `variant` before issuing.
- Unit and env template: `deploy/systemd/jace-commander-mcp.service`,
  `deploy/jace-commander-bridge.env.example`.

## Files that must never be committed (gitignored)

- `.env` (0600): ports, origin, `SIGNING_KEY`, `CONSENT_PASSPHRASE`
- `CONSENT_PASSPHRASE.txt` (0600): owner's copy of the consent passphrase
- `data/` (0700): registered clients + rotating refresh tokens (0600 files)

## Services (systemd user units, linger enabled)

- `desktop-commander-mcp.service` → `node bridge.js` (loopback 8002)
- `desktop-commander-auth-proxy.service` → `node server.js` (loopback 8010)
- `jace-commander-mcp.service` → `BRIDGE_VARIANT=jc node bridge.js` (loopback 8003; optional)

## Connect from ChatGPT

1. Add remote MCP server: `https://jacen-ubuntu.tailaa6d41.ts.net/mcp`
2. ChatGPT discovers OAuth metadata, registers a client (DCR or CIMD), and
   opens `/authorize` in your browser.
3. Approve by entering the consent passphrase (see `CONSENT_PASSPHRASE.txt`).
