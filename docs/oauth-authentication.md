# MCP Connector Authentication

The gateway is an OAuth 2.1 resource server for MCP clients. An external OAuth/OIDC provider is the authorization server. The gateway does not implement an authorization server, issue tokens, or store connector client secrets.

## Runtime Model

- Local-only development can use unauthenticated MCP discovery when the gateway is bound to loopback and MCP auth is not configured.
- Remote, production, tunneled, or MCP-authenticated gateway requests require bearer authentication or a configured trusted tunnel identity for all `/mcp` methods, including `initialize`, `ping`, `notifications/*`, and `tools/list`.
- `tools/call` also requires the scope mapped to the requested tool.
- Local development can use `ACS_MCP_BEARER_TOKEN` when `NODE_ENV` is not `production`.
- Production uses OAuth bearer JWTs verified with `jose` and a remote JWKS, or signed tunnel-session assertions from a trusted local tunnel proxy.

Authentication order is signed tunnel session, local bearer token, then OAuth JWT. Tokens or tunnel sessions that do not match a configured path are rejected.

## OAuth Provider

Configure an OAuth/OIDC application for the MCP connector client. WorkOS AuthKit is one supported provider; any provider that issues JWT access tokens and publishes a JWKS can work. Use the public gateway MCP URL as the resource indicator/audience, for example:

```sh
ACS_OAUTH_ISSUER=<OAuth issuer>
ACS_OAUTH_AUDIENCE=https://gateway.example.com/mcp
ACS_OAUTH_JWKS_URI=<OAuth JWKS URI>
```

The gateway publishes protected resource metadata at:

```text
/.well-known/oauth-protected-resource
/.well-known/oauth-protected-resource/mcp
```

The `resource` metadata value is `ACS_OAUTH_AUDIENCE`. `authorization_servers` contains `ACS_OAUTH_ISSUER`.

## Scopes

| Tool                | Required scope     |
| ------------------- | ------------------ |
| `create_work_item`  | `acs:work:create`  |
| `get_work_item`     | `acs:work:read`    |
| `list_work_items`   | `acs:work:read`    |
| `approve_work_item` | `acs:work:approve` |
| `unblock_work_item` | `acs:work:approve` |
| `cancel_work_item`  | `acs:work:approve` |

Worker claim and result submission tools are not exposed on the public MCP gateway in `v0.1.0-alpha`. They remain local worker/store paths only.

## Local Development

```sh
ACS_DB_PATH=storage/local.db \
ACS_MCP_BEARER_TOKEN=local-dev-token \
npm run start:gateway
```

Use `Authorization: Bearer local-dev-token` for protected MCP tool calls. Do not set `NODE_ENV=production` for local bearer testing; production ignores the local bearer path.

## Public Plugin Configuration

Public marketplace/plugin config should ship with the local loopback URL:

```json
{
  "mcpServers": {
    "acs": {
      "transport": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

To use a remote ACS instance, replace the URL with your own authenticated endpoint. Do not point this at someone else's tunnel. Do not expose ACS publicly without auth.

## Signed Tunnel Session Mode

Signed tunnel session mode is for deployments where a sidecar or tunnel proxy authenticates its upstream tunnel session and injects a signed local assertion:

```http
X-ACS-Connector-ID: chatgpt-prod
X-ACS-Tunnel-ID: tunnel_abc123
X-ACS-Session-ID: session_789
X-ACS-Issued-At: 2026-07-05T21:10:00.000Z
X-ACS-Signature: ed25519=<base64url signature>
```

Configure the gateway behind that local proxy:

```sh
ACS_AUTH_MODE=tunnel_id
ACS_TRUSTED_TUNNEL_PROXY=127.0.0.1
```

Register connectors and sessions in SQLite through the authenticated gateway routes:

```text
POST /connectors
POST /connectors/:id/tunnel-sessions
POST /connectors/:id/tunnels/:tunnelId/sessions/:sessionId/heartbeat
POST /connectors/:id/tunnels/:tunnelId/sessions/:sessionId/revoke
```

The connector registration stores an Ed25519 public key and allowed MCP scopes. The tunnel proxy signs `acs-tunnel-v1`, `connector_id`, `tunnel_id`, `session_id`, and `issued_at` joined by newlines. ACS verifies that the request came from `ACS_TRUSTED_TUNNEL_PROXY`, the signature matches the registered connector key, the session exists, the connector and session are active, the session has not expired, and the requested tool is covered by the connector scopes.

`ACS_ALLOWED_TUNNEL_IDS` is still accepted as a legacy compatibility allowlist for local experiments when explicitly enabled outside production. Prefer persistent connector records for production. Do not grant `acs:work:approve` to ChatGPT connector tunnels unless a separate operational review says those protections are no longer needed.

Only use tunnel ID mode when the gateway is bound to a local interface and the tunnel proxy is the sole external ingress. Public clients must not be able to send `X-ACS-Tunnel-ID` directly.

## Production Deployment

```sh
npm run build

NODE_ENV=production \
ACS_DB_PATH=/var/lib/agent-control-stack/control.db \
ACS_OAUTH_ISSUER=<OAuth issuer> \
ACS_OAUTH_AUDIENCE=https://gateway.example.com/mcp \
ACS_OAUTH_JWKS_URI=<OAuth JWKS URI> \
npm run start:gateway
```

If OAuth and tunnel auth are both missing in production, startup logs a warning and protected MCP calls fail closed. Never put bearer tokens, JWTs, tunnel IDs, session IDs, signatures, or private keys in logs.

## Claude Custom Connector

1. Expose the gateway over HTTPS.
2. Configure an OAuth/OIDC client for Claude and the scopes above.
3. Set the gateway production OAuth environment variables.
4. In Claude, add a custom connector with:
   - Name: `acs`
   - Remote MCP server URL: `https://gateway.example.com/mcp`
   - OAuth Client ID: the client id from your OAuth provider
   - OAuth Client Secret: the client secret from your OAuth provider
5. Let Claude discover `/.well-known/oauth-protected-resource/mcp`.
6. Request the narrowest tool scopes needed by the connector.

Do not use `http://127.0.0.1:3000/mcp` in Claude. Claude needs a public HTTPS URL. Do not use `ACS_MCP_BEARER_TOKEN` for Claude custom connectors unless Claude exposes a way to send `Authorization: Bearer`; that variable is only a local development fallback outside production.

Check the local MCP endpoint with POST JSON-RPC, not GET:

```sh
curl -fsS -X POST http://127.0.0.1:3000/mcp \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer local-dev-token' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

Check the public metadata endpoint before adding the connector:

```sh
curl -fsS https://gateway.example.com/.well-known/oauth-protected-resource/mcp
```

For tunnel-based local exposure, use the tunnel's public HTTPS domain in Claude:

```text
https://<your-public-tunnel-domain>/mcp
```

## ChatGPT MCP Connector

Use the same OAuth resource-server setup as Claude. Register the MCP endpoint as `https://gateway.example.com/mcp` and let the client discover `/.well-known/oauth-protected-resource/mcp`.

Authenticated MCP requests are written to the audit chain as `connector.requested` events with auth method, subject, issuer, connector id, tunnel id, session id, scopes, request id, and work item id when a tool call creates or returns one. The gateway never stores bearer tokens or JWTs.

**Use the "Server URL" connection type, not "Tunnel."** OAuth discovery cannot work over ChatGPT's Tunnel connection: tunnel traffic terminates at an OpenAI-owned hostname (`tunnel-service.gateway.unified-*.internal.api.openai.org`), so `GET /.well-known/oauth-protected-resource(/mcp)` never reaches the ACS origin, and any resource URL ACS derived from that inbound request would advertise the tunnel's hostname instead of the gateway's own. If you need to expose ACS through a tunnel for OAuth-less experiments, use `ACS_AUTH_MODE=tunnel_id` (Signed Tunnel Session Mode, above) instead of OAuth. See [ADR 0015](adr/0015-public-oauth-device-authorization.md).

## CLI Device Authorization (RFC 8628)

The `acs` CLI (`apps/runtime`, bin name `acs`) authenticates to a remote ACS gateway with the [OAuth 2.0 Device Authorization Grant](https://www.rfc-editor.org/rfc/rfc8628), not Authorization Code + PKCE. The CLI is a **public client with no client secret** (`client_id=acs-cli`); human login always happens in a browser, never in the terminal. See [ADR 0015](adr/0015-public-oauth-device-authorization.md) for the full design and why it's separate from the ChatGPT/Claude MCP OAuth flow above.

```sh
acs auth login [--acs-url <url>] [--no-open]
acs auth status
acs auth logout
```

### `acs auth login`

1. Loads (or generates, on first run) a local Ed25519 keypair under the CLI's credentials file. The private key is generated locally, is never transmitted, and is never logged; only the public key is ever sent to the server.
2. Requests a device code from `POST /oauth/device/code` on the target gateway (`--acs-url` or `ACS_URL`).
3. Prints the verification URL and a short user code, and best-effort opens a browser (`--no-open` to skip; opening a browser is never required for login to succeed).
4. Polls `POST /oauth/token` honoring the server's `interval` and `slow_down` responses (never busy-loops).
5. A human opens the printed URL, authenticates with the gateway's existing Mission Control operator token (the same login used for the dashboard at `/`), reviews the device name/public-key fingerprint/requested scopes, and clicks Approve or Deny.
6. On approval, the CLI receives an access token and refresh token and persists them alongside the device keypair.

### `acs auth status`

Prints only non-secret information: authenticated user, device name/ID, requested scopes, token expiry, the configured ACS endpoint, and a connection state (`authenticated`, `token_expired`, or `not_authenticated`). It never prints the raw access or refresh token.

### `acs auth logout`

Clears the locally stored session (access/refresh tokens) but **keeps the local device keypair**, so a future `acs auth login` is recognized by the server as the same device rather than enrolling a new one. This is **local logout only** — it does not revoke the device server-side. An operator can revoke a device remotely and independently of any human account deletion with:

```sh
curl -X POST https://gateway.example.com/devices/<device-id>/revoke \
  -H "authorization: Bearer <operator token>"
```

### Credential storage

The CLI stores its device keypair and session (`~/.config/acs/credentials.json` by default, override with `ACS_CLI_CREDENTIALS_PATH` or `XDG_CONFIG_HOME`) in a file created with `0600` permissions. No OS keychain integration exists in this workspace today; this is a documented limitation, not a silent gap. Never commit this file, put it in `.env`, or leave it world-readable.

### Server-side model

- **Device identity:** a `devices` table (`storage/migrations/009_device_auth.sql`), separate from `connector_records` (which represents operator-provisioned tunnel-proxy infrastructure, a different trust model — see ADR 0015). Device identity is the Ed25519 public key, not any issued token: refreshing an access token never touches the `devices` table, so a stolen refresh token cannot enroll a second trusted device.
- **Scope:** device tokens are limited to `acs:device` by default. `acs:work:approve` is never granted to a CLI device by this flow.
- **Fail closed:** malformed, expired, denied, or replayed device codes always return an RFC 8628 error (`authorization_pending`, `slow_down`, `access_denied`, `expired_token`, or `invalid_grant`/`invalid_client`) and never issue a token. `device_code` and `user_code` are stored only as SHA-256 hashes.
- Device tokens authenticate the CLI to the ACS gateway's own REST surface. They are issued and verified by ACS itself (a narrowly-scoped authorization-server component for this one grant type), independent of whatever external OAuth/OIDC provider is configured for ChatGPT/Claude MCP access via `ACS_OAUTH_ISSUER`/`ACS_OAUTH_AUDIENCE`/`ACS_OAUTH_JWKS_URI` above — the two flows do not need to share an issuer.
- Secrets (device codes, tokens, private keys) are never written to gateway or CLI logs.
