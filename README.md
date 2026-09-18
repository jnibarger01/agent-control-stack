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
  - Consent page gated by `CONSENT_PASSPHRASE` (typed by the owner in a browser).
- `bridge.js` — MCP SDK stdio→Streamable HTTP relay, bound to 127.0.0.1 only
  (replaces Supergateway, which cannot bind loopback). One canonical Desktop
  Commander executor; a new client initialize recycles the executor.
- `test-e2e.sh` — end-to-end flow test (run against `GW=<url>`).

## Files that must never be committed (gitignored)

- `.env` (0600): ports, origin, `SIGNING_KEY`, `CONSENT_PASSPHRASE`
- `CONSENT_PASSPHRASE.txt` (0600): owner's copy of the consent passphrase
- `data/` (0700): registered clients + rotating refresh tokens (0600 files)

## Services (systemd user units, linger enabled)

- `desktop-commander-mcp.service` → `node bridge.js` (loopback 8002)
- `desktop-commander-auth-proxy.service` → `node server.js` (loopback 8010)

## Connect from ChatGPT

1. Add remote MCP server: `https://jacen-ubuntu.tailaa6d41.ts.net/mcp`
2. ChatGPT discovers OAuth metadata, registers a client (DCR or CIMD), and
   opens `/authorize` in your browser.
3. Approve by entering the consent passphrase (see `CONSENT_PASSPHRASE.txt`).
