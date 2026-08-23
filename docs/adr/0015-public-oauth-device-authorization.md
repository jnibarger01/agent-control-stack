# ADR 0015: Public HTTPS OAuth resource + RFC 8628 CLI device authorization

## Status

Accepted

## Context

Two separate authentication needs were being conflated:

1. ChatGPT/MCP clients need to authenticate to the ACS gateway's `/mcp` endpoint.
2. A human operator running the `acs` CLI on a workstation needs to authenticate to a
   remote ACS gateway without a client secret and without pasting bearer tokens by hand.

An attempt to make (1) work over the ChatGPT "Tunnel" connection type failed: tunnel
transport terminates at `tunnel-service.gateway.unified-*.internal.api.openai.org`, so
`GET /.well-known/oauth-protected-resource(/mcp)` never reaches the ACS origin, and any
resource URL derived from that inbound request would advertise OpenAI's tunnel hostname,
not the ACS gateway. OAuth discovery cannot complete through that transport. See prior
session note; not reproduced here since it isn't a durable artifact.

### What Phase 1 inspection found already owns each concern

```text
Authorization server (external, MCP):  none configured; ACS verifies JWTs from an
                                        external issuer (docs/oauth-authentication.md
                                        names WorkOS AuthKit as one supported provider).
                                        apps/gateway/src/auth.ts:resolveMcpOAuthFromEnv
Token issuer (MCP):                    the external OAuth/OIDC provider named above.
Resource server:                       apps/gateway/src/auth.ts (verifyJwt, JWKS via
                                        `jose`, audience/issuer checks) + server.ts routes.
Human authentication:                  apps/gateway/src/server.ts already has a working,
                                        single-operator browser login: POST /session/login
                                        exchanges a bearer token (ACS_GATEWAY_TOKEN or an
                                        entry in ACS_GATEWAY_CREDENTIALS_JSON) for an
                                        HMAC-signed session cookie (sessionCookieValue /
                                        gatewayCredentialForSessionCookie), rendered by
                                        renderLoginPage(). This is "Mission Control" and
                                        is the only human-auth mechanism ACS has.
MCP authentication:                    apps/gateway/src/auth.ts, three methods: signed
                                        tunnel session, local bearer, OAuth JWT.
CLI/device authentication:             did not exist. apps/runtime is the `acs` binary
                                        (package.json bin: "acs" -> dist/cli.js) but its
                                        only subcommand is `serve` (start the local
                                        runtime). No remote-login capability.
Device persistence:                    connector_records + tunnel_sessions
                                        (storage/migrations/001_audit_log.sql) already
                                        implement almost the target `devices` shape:
                                        stable id, PEM public key, status, key rotation
                                        (POST /connectors/:id/rotate-key). But it is
                                        operator-provisioned infrastructure (a human with
                                        an existing mutation credential calls POST
                                        /connectors to register a trusted tunnel proxy's
                                        key) and scoped to MCP_SCOPES
                                        (acs:work:create/read/approve). It has no
                                        principal_id column and no self-enrollment path.
Session persistence:                   tunnel_sessions table (connector-scoped); the
                                        Mission Control cookie session is stateless
                                        (HMAC-signed, not stored).
Token verification:                    apps/gateway/src/auth.ts (jose jwtVerify + remote
                                        JWKS cache) for OAuth; HMAC constant-time compare
                                        for session cookies and local bearer tokens.
Public origin:                         no single canonical setting exists, but
                                        ACS_OAUTH_AUDIENCE already IS the canonical
                                        public MCP resource URL (README documents it as
                                        "usually public /mcp URL"), and
                                        ACS_MCP_RESOURCE_METADATA_URL already overrides
                                        Host-header-derived metadata URLs when set
                                        (mcpResourceMetadataUrl, server.ts). The
                                        `/.well-known/oauth-protected-resource(/mcp)`
                                        response body itself (protectedResourceMetadata)
                                        was already Host-header-independent - it is built
                                        from mcpAuth.oauth, not from the request. The
                                        Host-derived fallback is used only for the
                                        WWW-Authenticate challenge header hint, and only
                                        when ACS_MCP_RESOURCE_METADATA_URL is unset.
```

## Decision

Use a public HTTPS ACS Server URL and standards-based OAuth. Reject OAuth over ChatGPT
Tunnel as a production transport.

- **MCP flow:** Authorization Code + PKCE against an external OAuth/OIDC provider, unchanged
  from the existing `ACS_OAUTH_ISSUER` / `ACS_OAUTH_AUDIENCE` / `ACS_OAUTH_JWKS_URI`
  resource-server design. No changes to JWT verification, audience checks, or scope
  enforcement.
- **CLI flow:** RFC 8628 Device Authorization Grant, newly implemented, with ACS itself as
  a narrowly-scoped authorization server for this one grant type only. This is new code
  because nothing in ACS previously issued tokens; extending the JWT _verifier_ to also be
  a device-code _issuer_ would blur resource-server and authorization-server roles inside
  the same module, so the device-grant logic lives in new, separate files
  (`apps/gateway/src/device-auth-store.ts`, `apps/gateway/src/device-auth.ts`), following
  the existing pattern of narrowly-scoped store/route modules (`rate-limit.ts`,
  `metrics.ts`, `execution-read.ts`) rather than growing `auth.ts` or `server.ts`.
- **Human authentication for `/device/verify`:** reuse Mission Control's existing session
  mechanism verbatim (same cookie, same `/session/login`, same bearer-token credential
  model) rather than inventing a second login system. ACS has exactly one human-auth
  mechanism today; ADR 0001 makes the local control plane (not the client) the trust
  boundary, and Mission Control's operator token _is_ that boundary's human-facing form.
  Approval binds the authenticated Mission Control credential's `actorId`/`actor` to the
  device authorization record.
- **Device identity:** a new `devices` table, not a repurposed `connector_records`.
  `connector_records` encodes a different trust relationship (an already-mutation-authorized
  operator vouches for infrastructure - a tunnel proxy - via `POST /connectors`) from what
  CLI devices need (an _unauthenticated_ process generates its own keypair, requests a code,
  and only becomes trusted after a human approves it in a browser). Reusing the same table
  would either weaken tunnel-connector semantics or force CLI devices through the
  operator-provisioning API, defeating the point of a self-service device flow. The new
  table mirrors `connector_records`' column shape (id, display name, PEM public key, status,
  timestamps) and adds `principal_id` (FK to `actors.id`) plus `last_seen_at`/`revoked_at`,
  per the target schema.
- **Device keypair / proof of possession:** Ed25519 via Node's built-in `node:crypto`
  (`generateKeyPairSync("ed25519", ...)`), the same primitive already used for tunnel
  connector signature verification (`apps/gateway/src/auth.ts`, `createPublicKey` /
  `verify` with an `ed25519=...` signature prefix). No new cryptography is introduced. The
  CLI generates its keypair locally before requesting a device code, sends only the public
  key in `POST /oauth/device/code`, and never transmits the private key. Device identity is
  therefore derived from the keypair, not from any issued token: refreshing an access token
  never touches the `devices` table, so a stolen refresh token cannot mint a second trusted
  device - it can only be used against the device row the original keypair already earned.
- **Scopes:** add `acs:device` to the existing `MCP_SCOPES` union in `apps/gateway/src/auth.ts`
  rather than inventing a parallel scope system. No `acs:admin`/`*`/`full_access` scope is
  added. `acs:work:approve` is not granted to CLI devices or ChatGPT connectors by this work.

## Rejected alternatives

### OAuth discovery over ChatGPT Tunnel

Rejected. Discovery resolves against the requesting client's connection hostname
(`tunnel-service.gateway.unified-*.internal.api.openai.org`), not the ACS origin. No
server-side fix changes where the client sends its discovery request.

### Build a general password/account system for `/device/verify`

Rejected. ACS is a local-first, single-operator control plane (ADR 0001); it has never had
multi-user accounts and this feature does not need them. The existing Mission Control
bearer-token/session-cookie mechanism already is "the normal ACS human authentication
mechanism" the RFC 8628 spec asks for.

### Repurpose `connector_records` as the device table

Rejected. See Decision above - different trust model, different scope namespace, would
entangle CLI-device revocation with tunnel-proxy revocation.

### Vendor an OS-keychain dependency (e.g. keytar) for CLI credential storage

Rejected for this pass. No such dependency exists anywhere in this workspace today, and
adding one is disproportionate to "smallest coherent implementation." CLI credentials
(access/refresh token + local Ed25519 private key) are stored in a file under
`~/.config/acs/credentials.json` created with mode `0600`. This is a documented limitation,
not a silent gap: `acs auth status` and the docs both say so.

## Consequences

- `apps/gateway/src/auth.ts` gains one scope (`acs:device`); JWT verification, audience
  checks, and the tunnel/local-bearer paths are unchanged.
- New SQLite migration `storage/migrations/009_device_auth.sql` (registered in
  `packages/shared/src/migration.ts`), applied through the existing
  `applyControlPlaneMigrations` path already run by `SqliteWorkItemStore`'s constructor.
- New gateway routes: `POST /oauth/device/code`, `POST /oauth/token`,
  `GET /device/verify`, `POST /device/verify`. All are additive; no existing route's
  behavior changes.
- `apps/runtime` (the `acs` binary) gains `auth login|status|logout` alongside the existing
  `serve` subcommand.
- Public HTTPS deployment (a real `https://<domain>` origin, external IdP registration) is
  out of scope for this change to actually stand up - no deployment was authorized. The
  code is written so that setup is only configuration (env vars + DNS/TLS), not further
  code changes; the end-to-end acceptance test's public-origin leg is marked BLOCKED for
  that reason, not because the mechanism is unproven locally.

## Implementation notes

- Fail closed: any malformed/expired/replayed/wrong-client device code request returns the
  RFC 8628 error codes (`authorization_pending`, `slow_down`, `access_denied`,
  `expired_token`, `invalid_client`) and never issues a token.
- `device_code` and `user_code` are stored hashed (SHA-256) in
  `oauth_device_authorizations`; only the hash is persisted, matching the audit log's
  existing practice of never storing raw secrets.
- Nothing added by this ADR grants `acs:work:approve`.
