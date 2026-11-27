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

- `server.js` — Node HTTP service (`node:http`, `node:crypto`, `node:sqlite`; zero third-party runtime npm deps):
  - OAuth 2.1 authorization server: PKCE S256 (required), Dynamic Client
    Registration (RFC 7591), Client ID Metadata Documents (CIMD),
    RFC 8707 resource binding, RFC 9207 `iss` response parameter,
    refresh-token rotation (single-use + AES-256-GCM recovery envelopes for
    DPoP-bound CLI refreshes), and RFC 8628 headless device authorization
    (`/jc/oauth/device/code`, `/jc/device`, `/jc/oauth/token`).
  - RFC 9449 DPoP (`dpop.js`): `EdDSA` / `ES256` proof verification, `DPoP-Nonce`
    challenge/rotation (`DPOP_NONCE_REQUIRED`), canonical external origin `htu`
    validation (ignoring `Host` and `X-Forwarded-*`), `ath` SHA-256 binding,
    persistent `dpop_jtis` replay table in `DATA_DIR/gateway.db`, and
    fail-closed `cnf.jkt` verification (no `Bearer` downgrade). ChatGPT, Claude,
    and other non-`cnf.jkt` clients remain `Bearer`-compatible.
  - Built-in `jace-commander-cli` policy (`oauth_lane: "jc"`, loopback-only
    redirects, mandatory PKCE S256 + DPoP, `scope: "mcp"`, 600s access / 30d
    refresh / 7d inactivity TTL) and per-device management (`GET /jc/devices`,
    `POST /jc/devices/:deviceId/revoke`, `DELETE /jc/devices/:deviceId`).
  - Persistent SQLite store (`store.js`, `DATA_DIR/gateway.db`, WAL, `0600`)
    for `dpop_jtis`, `auth_codes`, `refresh_tokens`, `jc_devices`, and
    encrypted recovery envelopes (`JC_REFRESH_RECOVERY_KEY` or HKDF from
    `SIGNING_KEY`), with non-destructive migration of legacy `tokens.json`.
  - RFC 9728 protected-resource metadata + RFC 8414 AS metadata discovery
    (including `dpop_signing_alg_values_supported` and
    `device_authorization_endpoint`).
  - `/mcp` and `/jc/mcp` proxies: validate `DPoP` (for `cnf.jkt` tokens) or
    `Bearer` HS256 JWT (`iss`, `exp`, `aud == RESOURCE`) before forwarding;
    stream responses (SSE preserved); never log tokens, keys, proofs, or args.
  - Identity forwarding: on each authorized `/mcp` request the gateway
    attests the authenticated identity to the executor (`x-dc-agent`,
    `x-dc-client`, `x-dc-attestation` — short-lived HMAC over the identity,
    keyed by `GATEWAY_EXECUTION_TOKEN`). The bearer/DPoP token is never
    forwarded; client-supplied `x-dc-*` headers are always stripped.
  - Consent page gated by `CONSENT_PASSPHRASE` (typed by the owner in a browser).
  - See [ADR 0031](../../docs/adr/0031-jace-cli-auth-v2.md) and the
    [JACE CLI AUTH V2 migration runbook](../../docs/runbooks/jace-cli-auth-v2-migration.md).
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

## Jace Commander lane (`/jc/mcp`)

Optional second lane (`JC_ENABLED=1`). It serves the Jace Commander MCP server
with its own OAuth audience (`…/jc/mcp`) and is always ACS-managed through
`POST /jc/capability/issue` using a dedicated bridge credential
(`ACS_JC_GATEWAY_TOKEN`, distinct from `ACS_GATEWAY_TOKEN`). Root commands
(`privileged_exec`) need a human approval in ACS for each run. See
[docs/jace-commander-lane.md](docs/jace-commander-lane.md).

```
https://<host>/jc/mcp ─► server.js (Bearer <redacted> == JC_RESOURCE)
                          │ managed tools/call: POST ACS /jc/capability/issue
                          │ (ACS_JC_GATEWAY_TOKEN, x-jc-actor) → acs.jc.v1 envelope
                          │ injected at params._meta.acsCapability
                          ▼
   bridge.js BRIDGE_PROFILE=jace-commander  127.0.0.1:8003  (jace-commander-mcp.service)
                          ▼ stdio
   node <dc>/dist/jace-commander/cli.js serve   (managed; never --standalone)
```

- `/jc/mcp` is a separate RFC 8707 resource (`JC_RESOURCE`, default
  `${PUBLIC_ORIGIN}/jc/mcp`) with its own metadata at
  `/.well-known/oauth-protected-resource/jc/mcp`, so `/mcp` and `/jc/mcp`
  tokens are not interchangeable.
- Same Bearer <redacted>, hop-header stripping, identity attestation and client
  `_meta.acs*`/`capability` stripping as `/mcp`. Any ACS failure, or an
  envelope whose `version`/`audience` is not `acs.jc.v1`/`jace-commander`, is a
  503 and nothing is forwarded. `/mcp` likewise rejects `acs.jc.v1` envelopes.
  A JSON-RPC batch containing `tools/call` is rejected fail-closed
  (`batched_tools_call_rejected`): the gateway cannot attribute ACS issuance
  or strip spoofed authority fields per batch element.
- `/ready` reports only the primary DC lane. `GET /jc/ready` independently
  checks managed JC configuration, ACS `/readyz`, and the initialized managed
  JC bridge with capability verification and gateway attestation configured.
  It returns 200 when ready or 503 otherwise, with booleans only. `/authority`
  includes a `jcBridge` section when the lane is enabled.
- Managed JC requires `DC_GATEWAY_EXECUTION_TOKEN` at bridge startup (matching
  the edge `GATEWAY_EXECUTION_TOKEN`). Every bridge `/mcp` request requires a
  valid short-lived gateway attestation, including initialize, discovery,
  notifications, GET and DELETE. Rejection precedes session creation. Tool
  execution still requires an ACS-issued `acs.jc.v1` capability.
- Unit and env template: `deploy/systemd/jace-commander-mcp.service`,
  `deploy/jace-commander-bridge.env.example`.

## Files that must never be committed (gitignored)

- `.env` (0600): ports, origin, `SIGNING_KEY`, `CONSENT_PASSPHRASE`
- `CONSENT_PASSPHRASE.txt` (0600): owner's copy of the consent passphrase
- `data/` (0700): registered clients + rotating refresh tokens (0600 files)

## Services (systemd user units, linger enabled)

- `desktop-commander-mcp.service` → `node bridge.js` (loopback 8002)
- `desktop-commander-auth-proxy.service` → `node server.js` (loopback 8010)
- `jace-commander-mcp.service` → `BRIDGE_PROFILE=jace-commander node bridge.js` (loopback 8003; optional)

## Connect from ChatGPT

1. Add remote MCP server: `https://jacen-ubuntu.tailaa6d41.ts.net/mcp`
2. ChatGPT discovers OAuth metadata, registers a client (DCR or CIMD), and
   opens `/authorize` in your browser.
3. Approve by entering the consent passphrase (see `CONSENT_PASSPHRASE.txt`).
