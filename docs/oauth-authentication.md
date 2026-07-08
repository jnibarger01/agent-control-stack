# MCP Connector Authentication

The gateway is an OAuth 2.1 resource server for MCP clients. WorkOS AuthKit is the authorization server. The gateway does not implement an authorization server or issue tokens.

## Runtime Model

- Public MCP methods: `initialize`, `ping`, `notifications/*`, and `tools/list`.
- Protected MCP methods: every other method requires bearer authentication or a configured trusted tunnel identity.
- `tools/call` also requires the scope mapped to the requested tool.
- Local development can use `ACS_MCP_BEARER_TOKEN` when `NODE_ENV` is not `production`.
- Production uses OAuth bearer JWTs verified with `jose` and a remote JWKS, or signed tunnel-session assertions from a trusted local tunnel proxy.

Authentication order is signed tunnel session, local bearer token, then OAuth JWT. Tokens or tunnel sessions that do not match a configured path are rejected.

## WorkOS AuthKit

Configure a WorkOS AuthKit application for the ChatGPT MCP connector client. Use the gateway MCP URL as the resource indicator/audience, for example:

```sh
ACS_OAUTH_ISSUER=<WorkOS AuthKit issuer>
ACS_OAUTH_AUDIENCE=https://gateway.example.com/mcp
ACS_OAUTH_JWKS_URI=<WorkOS JWKS URI>
```

The gateway publishes protected resource metadata at:

```text
/.well-known/oauth-protected-resource
/.well-known/oauth-protected-resource/mcp
```

The `resource` metadata value is `ACS_OAUTH_AUDIENCE`. `authorization_servers` contains `ACS_OAUTH_ISSUER`.

## Scopes

| Tool | Required scope |
| --- | --- |
| `create_work_item` | `acs:work:create` |
| `get_work_item` | `acs:work:read` |
| `list_work_items` | `acs:work:read` |
| `approve_work_item` | `acs:work:approve` |
| `unblock_work_item` | `acs:work:approve` |
| `cancel_work_item` | `acs:work:approve` |

Worker claim and result submission tools are not exposed on the public MCP gateway in `v0.1.0-alpha`. They remain local worker/store paths only.

## Local Development

```sh
ACS_DB_PATH=storage/local.db \
ACS_MCP_BEARER_TOKEN=local-dev-token \
npm run start:gateway
```

Use `Authorization: Bearer local-dev-token` for protected MCP tool calls. Do not set `NODE_ENV=production` for local bearer testing; production ignores the local bearer path.

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
NODE_ENV=production \
ACS_DB_PATH=/var/lib/agent-control-stack/control.db \
ACS_OAUTH_ISSUER=<WorkOS AuthKit issuer> \
ACS_OAUTH_AUDIENCE=https://gateway.example.com/mcp \
ACS_OAUTH_JWKS_URI=<WorkOS JWKS URI> \
npm run start:gateway
```

If OAuth and tunnel auth are both missing in production, startup logs a warning and protected MCP calls fail closed. Never put bearer tokens, JWTs, tunnel IDs, session IDs, signatures, or private keys in logs.

## ChatGPT MCP Connector

1. Expose the gateway over HTTPS.
2. Configure WorkOS AuthKit for the connector client and scopes above.
3. Set the gateway production OAuth environment variables.
4. Register the MCP endpoint as `https://gateway.example.com/mcp`.
5. Let the client discover `/.well-known/oauth-protected-resource/mcp`.
6. Request the narrowest tool scopes needed by the connector.

Authenticated MCP requests are written to the audit chain as `connector.requested` events with auth method, subject, issuer, connector id, tunnel id, session id, scopes, request id, and work item id when a tool call creates or returns one. The gateway never stores bearer tokens or JWTs.
