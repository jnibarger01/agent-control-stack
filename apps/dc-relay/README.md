# Own-relay control plane (`apps/dc-relay`)

> Extracted from the Desktop Commander fork's `src/control-plane` (ADR 0019).
> The device-side client stays in Desktop Commander
> (`vendor/desktop-commander/src/remote-device/oauth-relay.ts`). The relay is a
> transport: it routes calls to paired devices and never authorizes a
> privileged action. Desktop Commander still verifies every ACS capability.

The plane lets `desktop-commander remote --managed` pair with and run against your own Supabase project instead of `mcp.desktopcommander.app`. It never holds or returns a user or device token. During pairing it relays a single Supabase OAuth authorization code from the browser to the device that proved PKCE, and the device exchanges that code itself.

## Run

From the monorepo root:

```text
npm ci
npm run build                      # tsc -b builds apps/dc-relay/dist
npm test -w apps/dc-relay          # relay test suite
npm start -w apps/dc-relay         # sources ~/.config/dc-relay/relay.env; listens on 127.0.0.1:${PORT:-3100}
```

The entrypoint moved from `<desktop-commander>/dist/control-plane/server.js`
to `apps/dc-relay/dist/server.js`; a host service that starts the old path must
be repointed during the systemd cutover.

Port 3000 belongs to `acs-gateway`, and the server refuses to start on it. Expose the plane publicly only through Tailscale Funnel (`:8443 → 127.0.0.1:3100`), and only while you use it.

## Environment

Keep secrets in `~/.config/dc-relay/relay.env` (mode 600, outside git). All of these are required:

| Variable | Notes |
| --- | --- |
| `SUPABASE_URL` | e.g. `https://wwtjwgugizlgmhpbxlpp.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | Public. Returned by `/api/mcp-info` and used by the consent page. |
| `SUPABASE_SECRET_KEY` | **Server-only.** Used for the `*_server` RPCs, which only `service_role` can execute. Never logged or serialized. |
| `DEVICE_OAUTH_CLIENT_ID` | The public OAuth client registered for devices (`dc-relay-device`). |
| `CONTROL_PLANE_URL` | Public HTTPS origin, e.g. `https://jacen-ubuntu.tailaa6d41.ts.net:8443`. |
| `PAIRING_STATE_KEY` | base64, ≥32 bytes. HMAC key for the OAuth `state`. |
| `PAIRING_CODE_KEY` | base64, exactly 32 bytes. AES-256-GCM key for the authorization code at rest. |
| `PORT` | Optional, default `3100`. `HOST` is optional too, default `127.0.0.1`. |
| `MCP_ALLOWED_CLIENT_IDS` | Optional, comma-separated OAuth `client_id`s allowed on `/mcp`. Unset means any OAuth client except the device client. |

There is no `PRESENCE_AUTHORITY_*`: the plane reads Supabase Realtime Presence directly (`supabase-store.ts#readPresence`) using the caller's own token.

## Supabase dashboard state

In **Authentication → OAuth Server**:
- The OAuth 2.1 server is enabled.
- Authorization path is `/oauth/consent`.
- Site URL is `CONTROL_PLANE_URL`.
- Dynamic client registration is on, so Claude can register itself.
- The public client `dc-relay-device` is registered with redirect URI `<CONTROL_PLANE_URL>/device/callback`.

The consent page (`/oauth/consent`) serves every OAuth client, whether that's device pairing or Claude. It shows the requesting client's name, website host, client ID, the signed-in account and each requested scope, all taken from `getAuthorizationDetails`. The consent page signs users in with `signInWithOtp({ shouldCreateUser: false })`, so create your user under **Authentication → Users** first. Magic links return to `<CONTROL_PLANE_URL>/oauth/consent?...`, so add `<CONTROL_PLANE_URL>/oauth/consent**` to **Authentication → URL Configuration → Redirect URLs**. The one-time code in the email works without it.

## Migrations (in order)

1. `supabase/migrations/20260924204925_control_plane_v1.sql`: devices, sessions, calls, Realtime policies.
2. `supabase/migrations/20260924204948_oauth_pairing.sql`: drops the v1 browser-token pairing RPCs and adds the sealed-code columns plus four `service_role`-only RPCs (`set_mcp_pairing_nonce_server`, `store_mcp_pairing_code_server`, `reject_mcp_pairing_session_server`, `consume_mcp_pairing_code_server`).

On hosted Supabase, `realtime.messages` is owned by `supabase_realtime_admin` and already has RLS enabled. `supautils` lets `postgres` create policies on it but not `ALTER TABLE`, so v1 enables RLS there only when it is off.

## Pairing

```text
device  POST /device/start {code_challenge (S256)}      -> session_id, verification_uri_complete (/add-device?session_id=…)
browser GET  /add-device?session_id=…                    -> 302 Supabase /auth/v1/oauth/authorize
                                                             (client_id, redirect_uri, the session's code_challenge, S256,
                                                              state = b64url(session_id.nonce.HMAC(PAIRING_STATE_KEY)))
browser GET  /oauth/consent?authorization_id=…           -> sign in (email) + approve / deny
browser GET  /device/callback?code&state                 -> state checked in constant time; code sealed with AES-256-GCM
                                                             (AAD = session_id), 120 s TTL, session VERIFIED
device  POST /device/poll {code_verifier}                -> PKCE first, then one UPDATE consumes + wipes:
                                                             200 {authorization_code, redirect_uri, device_id?}
device  POST SUPABASE/auth/v1/oauth/token (code + verifier) -> device's own access/refresh tokens
device  POST /api/devices/register (Bearer device token) -> device row; the token must carry client_id = DEVICE_OAUTH_CLIENT_ID
```

Poll errors are `authorization_pending`, `expired_token`, `access_denied` (denied, or a replayed callback) and `invalid_grant` (wrong verifier, or already consumed). A second callback for the same session rejects the session and wipes the code.

## Claude-facing MCP

- `POST /mcp` (JSON-RPC over Streamable HTTP, JSON responses; `GET` returns 405). Requests are authenticated with a Supabase access token from any OAuth client, and a live `session_id` is required.
- The token must carry a `client_id` claim, so plain Supabase session tokens are refused. It must not be `DEVICE_OAUTH_CLIENT_ID`, so a device's own token can't drive `/mcp`. If `MCP_ALLOWED_CLIENT_IDS` is set, the client must be on that list. Any other client gets `403 {"error":"client_not_permitted"}`.
- On a missing or invalid token it returns `401` with `WWW-Authenticate: Bearer resource_metadata="<CONTROL_PLANE_URL>/.well-known/oauth-protected-resource"`.
- `GET /.well-known/oauth-protected-resource` returns `{ resource: <CONTROL_PLANE_URL>/mcp, authorization_servers: [<SUPABASE_URL>/auth/v1] }`.
- It exposes exactly three tools: `list_devices`, `get_device` and `call_device_tool`. `call_device_tool` dispatches durably, then polls for at most 60 s.

## Device state

`resolveEffectiveDeviceState` is the single authority. A device is online only when all of these hold:
- It has an active session binding.
- It has exactly one Presence entry on `user:{user_id}:device:{device_id}` keyed by `device_id`, with `transport: "broadcast_v1"`, `local_mcp_ready: true` and a `connection_generation`.
- Its registration carries `capabilities.transport_broadcast_v1 === true`.

The persisted `status` column is never used as evidence.
