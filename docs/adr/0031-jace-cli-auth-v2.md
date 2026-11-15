# ADR 0031: JACE CLI AUTH V2 (DPoP, OS Credential Storage, and RFC 8628 `/jc` Login)

## Status

Accepted

## Context

Prior authentication across the Jace Commander CLI (`apps/jace-commander`), the `/jc` OAuth edge (`apps/dc-mcp-gateway`), and the ACS gateway (`apps/gateway`) had four structural gaps:

1. **Bearer-only `/jc` tokens without sender constraint.** Both `apps/dc-mcp-gateway/server.js` and `apps/jace-commander/src/mcp-auth.ts` / `mcp-http-client.ts` issued and sent plain `Authorization: Bearer` tokens. A stolen access token or refresh token could be replayed from another host or process without holding the client's key.
2. **In-memory OAuth state and uncoordinated CLI refresh.** `dc-mcp-gateway` kept authorization codes in an in-memory `Map` and refresh tokens in `tokens.json` with no persistent `jti` replay cache across restarts. On the CLI side, `mcp-auth.ts` relied on an in-process `refreshInFlight` map without a cross-process file lock or pre-send rotation journal, and `connect()` did not validate the RFC 9207 `iss` callback parameter.
3. **Plaintext local token files and missing OS keyring abstraction.** `apps/jace-commander` stored tokens in plaintext JSON (`0600`), had no OS credential-storage integration (Linux Secret Service / KWallet, macOS Keychain, Windows Credential Manager) or encrypted headless fallback, and lacked a unified `jace auth` command namespace.
4. **Incomplete `/jc` headless login and `device-login.ts` PoP divergence.** Headless terminals could not authenticate to `/jc/mcp` via RFC 8628 without local loopback browser access, and `apps/jace-commander/src/device-login.ts` still sent unauthenticated `grant_type=refresh_token` requests against ACS despite [ADR 0030](0030-device-bound-refresh-and-recovery-envelopes.md).

At the same time, hosted MCP clients (ChatGPT via DCR, Claude via CIMD) and legacy CI/service overrides (`JC_MCP_TOKEN`) must remain compatible, `apps/jace-commander` standalone releases (`npm install --omit=dev --ignore-scripts`) cannot depend on native N-API keychain addons such as `keytar`, and ACS must remain the sole execution and approval authority.

## Decision

### 1. Strict Domain and Authority Separation

- `apps/dc-mcp-gateway/server.js` remains the OAuth 2.1 authorization server and resource gateway for `/jc` (`ISSUER = JC_ISSUER`, `RESOURCE = JC_RESOURCE`, e.g., `${PUBLIC_ORIGIN}/jc` and `${PUBLIC_ORIGIN}/jc/mcp`). `jace-auth` is separate and not part of `/jc`.
- `apps/gateway` remains the authoritative ACS execution, policy, and approval system.
- `/jc` tokens are never accepted by ACS APIs, and ACS device tokens are never accepted by `/jc/mcp` or `/mcp`. `/jc` CLI login establishes user identity for `/jc/mcp` (`scope: "mcp"`) only and never grants admin, root, or ACS execution privileges.

### 2. Device Identity and RFC 9449 DPoP (Shared by `/jc` and ACS)

- **Key algorithm:** Ed25519 / `EdDSA` (`OKP` JWK `{ kty: "OKP", crv: "Ed25519", x }`, RFC 7638 SHA-256 base64url thumbprint `jkt`). The CLI generates keys using Node's built-in `node:crypto` with zero external runtime dependencies and maintains separate keypairs per domain (`jc-mcp` vs `acs`). Gateways accept `["EdDSA", "ES256"]` and reject `none`, `HS*`, and `RS*`.
- **Proof structure (`DPoP: <compact-jws>`):**
  - Header: `typ: "dpop+jwt"`, `alg` in `["EdDSA", "ES256"]`, and public `jwk` only (reject if `d` or any private key parameter is present).
  - Claims: `jti` (`>= 128` bits entropy), uppercase `htm`, `htu` (`origin + pathname`, no query or fragment, validated strictly against configured canonical origin such as `PUBLIC_ORIGIN` / `JC_ISSUER` / `ACS_PUBLIC_ORIGIN` — never trusting `Host` or `X-Forwarded-*` headers), `iat` (`±60s` skew), `ath` (base64url SHA-256 of the ASCII access token on all protected-resource requests, omitted/ignored on `/token`), and `nonce`.
- **Server nonces (`DPoP-Nonce`):** When `DPOP_NONCE_REQUIRED=1` (default enabled for `jace-commander-cli` and DPoP endpoints, configurable for tests), missing/invalid/expired nonces return `401` (`WWW-Authenticate: DPoP error="use_dpop_nonce"`) on resource endpoints or `400` (`error: "use_dpop_nonce"`) on `/token` with a fresh `DPoP-Nonce` header. The CLI retries once with a fresh proof containing the server nonce before upstream MCP dispatch.
- **Persistent replay protection:** Both `apps/dc-mcp-gateway` (`DATA_DIR/gateway.db` via `node:sqlite`) and `apps/gateway` (SQLite migration) persist seen `(jti, jkt, exp)` entries so `jti` replay fails closed even across gateway restarts.
- **Sender constraint and no Bearer downgrade:** Access tokens bound to a proof key carry `cnf: { jkt }` and are issued with `token_type: "DPoP"`. Protected endpoints reject `Authorization: Bearer <dpop-bound-token>` (`401`, `WWW-Authenticate: DPoP error="invalid_token"`). Clients without `cnf.jkt` (ChatGPT, Claude, non-DPoP DCR/CIMD connectors, and explicit `JC_MCP_TOKEN` legacy env overrides) retain `Authorization: Bearer` compatibility.

### 3. `/jc` OAuth 2.1, `jace-commander-cli` Policy, and RFC 8628 Device Flow

- **Static built-in client (`jace-commander-cli`):** `oauth_lane: "jc"`, `token_endpoint_auth_method: "none"`, loopback-only redirects (`http://127.0.0.1:<port>/callback`, `http://[::1]:<port>/callback`, RFC 8252 §7.3), mandatory PKCE `S256`, `state`, RFC 9207 `iss` validation, optional `dpop_jkt` binding on `/authorize` verified at `/token`, mandatory DPoP on `/token`, refresh, device flow, and `/jc/mcp`, `600s` access TTL (overridable under `EDGE_TEST_MODE=1`), `30d` refresh TTL with `7d` inactivity window, and non-privileged `mcp` scope.
- **Headless RFC 8628 device flow on `/jc`:**
  - `POST /jc/oauth/device/code` issues `{ device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }`.
  - `GET /jc/device` and `POST /jc/device` perform single-use owner approval.
  - `POST /jc/oauth/token` (`grant_type=urn:ietf:params:oauth:grant-type:device_code`) enforces `interval` / `slow_down`, requires valid `DPoP` proof (matching `dpop_jkt` if registered), registers the device in `jc_devices`, and returns `{ access_token, refresh_token, token_type: "DPoP", expires_in, scope, device_id }`.
- **Per-device management:** `GET /jc/devices`, `POST /jc/devices/:deviceId/revoke`, and `DELETE /jc/devices/:deviceId` (all requiring a DPoP-bound `/jc` token for the owning `sub`) list active/revoked devices and immediately revoke a device and its refresh family across `/jc/mcp` and `/token`.

### 4. Refresh Rotation, Replay Detection, and Crash Recovery

- `/jc` refresh requests from `jace-commander-cli` include `refresh_token`, `client_id`, a locally persisted `refresh_request_id`, and a matching `DPoP` proof.
- Inside a SQLite `BEGIN IMMEDIATE` transaction in `DATA_DIR/gateway.db`:
  - Mismatched `jkt` or revoked device immediately revokes the token family (`400 invalid_grant`, `refresh_reused`).
  - Active tokens rotate to a successor pair, record `used_request_id` and `successor_hash`, and persist a bounded (`120s`) AES-256-GCM recovery envelope keyed by `JC_REFRESH_RECOVERY_KEY` (or HKDF-derived from `SIGNING_KEY` when unset) with AAD bound to `device_id|family|cnf_jkt|old_token_hash|refresh_request_id`.
  - Re-presenting the consumed token with the same `refresh_request_id`, valid matching DPoP proof, inside `recovery_expires_at`, and before the successor is used/revoked decrypts and returns the exact successor response; any other reuse revokes the entire family and device session.
- Legacy non-DPoP ChatGPT/Claude clients without `refresh_request_id` preserve existing `auth-health.js` rotation behavior.
- ACS device auth integrates [ADR 0030](0030-device-bound-refresh-and-recovery-envelopes.md) and extends protected ACS routes to require Ed25519 DPoP/PoP with persistent `jti` replay protection, canonical external origin `htu` validation, and multi-device listing/revocation, with `apps/jace-commander/src/device-login.ts` updated accordingly.

### 5. CLI Credential Storage, Cross-Process Locking, and `jace auth`

- **Commands (`jace`, `jc`, `jace-commander`):** `jace auth login [--device] [--no-browser] [--mcp-url <url>] [--label <name>]`, `jace auth status [--json]`, `jace auth refresh`, `jace auth logout` (clears local state only and informs the operator that remote devices require `jace auth revoke`), `jace auth devices [--json]`, and `jace auth revoke <device-id>`.
- **Zero-native-addon `SecretStore` (`get`, `set`, `delete`, `backendName`):**
  - Linux: `SecretServiceStore` (`secret-tool` over D-Bus Secret Service, with `kwallet-query` fallback when `secret-tool` is unavailable).
  - macOS: `KeychainStore` (`security`).
  - Windows: `WindowsCredentialStore` (PowerShell DPAPI / Credential Manager).
  - Headless fallback: `EncryptedFileStore` (AES-256-GCM, `0700` state directory, `0600` files, `O_EXCL` + `fsync` + `rename`, symlink/ownership checks). Key material is never stored in the same file as encrypted credentials; the KEK is derived from `JC_KEYRING_PASSPHRASE`, `JC_KEYRING_KEY_FILE`, or a separated OS-restricted runtime/keystore path in explicitly non-interactive headless environments, never plaintext fallback.
- **Concurrency & transport:** Cross-process `O_CREAT | O_EXCL` + `linkSync` lockfile (`<stateDir>/auth.lock`) serializes refresh alongside a `0600` pre-send `pending-refresh.json` journal. `mcp-http-client.ts` consumes a typed `AuthProvider` (`getAuthHeaders`, `handleAuthChallenge`), enforces `DPoP-Nonce` retry-once and expired-token refresh while preserving `tools/call` non-replay rules (`execution_unknown`, exit `7`), honors `JC_MCP_TOKEN` only as an explicit unpersisted `legacy-bearer-env` mode, and redacts all tokens, private keys, PKCE verifiers, and DPoP proofs from logs and errors.

## Threat Model

| Threat | Mitigation |
| --- | --- |
| Stolen `/jc` or ACS access token replayed elsewhere | Token is `cnf.jkt`-bound; protected endpoints require `Authorization: DPoP` + valid proof signed by the local Ed25519 key and reject `Bearer`. |
| Attacker forces Bearer downgrade on a DPoP session | Protected endpoints fail closed (`401 invalid_token`) when a `cnf.jkt` token is sent with `Bearer`; CLI only sends `Bearer` for explicit `JC_MCP_TOKEN`. |
| DPoP proof replayed across requests or gateway restarts | Server requires unique `jti`, `±60s` `iat`, `DPoP-Nonce`, `ath` SHA-256 binding, and persists `(jti, jkt, exp)` in SQLite. |
| `Host` or `X-Forwarded-*` spoofing bypasses `htu` | `htu` is compared solely against configured canonical external origin (`PUBLIC_ORIGIN` / `JC_ISSUER` / `ACS_PUBLIC_ORIGIN`), ignoring forwarded/host headers. |
| Concurrent CLI refreshes or crash mid-refresh causes lockout | CLI serializes via `auth.lock` + `pending-refresh.json` (`refresh_request_id`); gateway uses `BEGIN IMMEDIATE` + `120s` AES-256-GCM recovery envelope. |
| Stolen refresh token replayed out-of-band | Proof mismatch or mismatched/expired recovery triggers full family & device revocation (`refresh_reused`). |
| Revoked device continues accessing `/jc/mcp` or ACS | Revocation sets `status = 'revoked'` and voids refresh families; `/jc/mcp`, `/token`, and ACS routes check device status on every request. |
| Token confusion between `/mcp`, `/jc/mcp`, and ACS | Distinct issuers, audiences (`RESOURCE` vs `JC_RESOURCE` vs ACS), device tables, and keypairs; cross-lane and cross-domain tokens are rejected. |
| Local disk read or plaintext fallback exposes secrets | OS keyring stores secret material (`SecretServiceStore` / `KeychainStore` / `WindowsCredentialStore`); headless fallback uses `EncryptedFileStore` with separated KEK and `0700`/`0600` modes. |
| Secrets leaked in CLI stdout/stderr or gateway logs | Secret redactor strips access/refresh tokens, private keys, PKCE verifiers, and `DPoP` JWTs; `jace auth status` prints metadata only. |

## Rejected Alternatives

### Native N-API Keyring Addons (`keytar` / `@napi-rs/keyring`)

Rejected. `apps/jace-commander` standalone releases install with `npm install --omit=dev --ignore-scripts` and have no native toolchain dependency. System CLI tools (`secret-tool` / `kwallet-query`, `security`, PowerShell DPAPI) provide OS keyring support with zero native addons.

### Plaintext JSON Fallback in Headless Environments

Rejected. Falling back to unencrypted JSON when D-Bus Secret Service is absent silently downgrades security in CI, containers, and SSH sessions. `EncryptedFileStore` with separated KEK material is mandatory when no OS keyring is available.

### Reusing `jace-auth` or Sharing ACS `devices` Table for `/jc`

Rejected. `/jc` must remain self-contained in `apps/dc-mcp-gateway` for Tailscale Funnel edge deployments and hosted ChatGPT/Claude OAuth compatibility, while ACS must remain isolated so `/jc` user sessions cannot acquire ACS execution or approval privileges.

### Trusting `Host` or `X-Forwarded-*` for DPoP `htu`

Rejected. Reverse proxies and client-supplied headers can be forged or rewritten; canonical configured origins prevent cross-endpoint proof forwarding.

## Consequences

- `apps/dc-mcp-gateway` requires Node's built-in `node:sqlite` (`Node >= 24.16.0`), persists `DATA_DIR/gateway.db` (`0600`), migrates existing `tokens.json` non-destructively, and supports optional `JC_REFRESH_RECOVERY_KEY` and `DPOP_NONCE_REQUIRED`.
- `apps/jace-commander` exposes the `jace` binary alongside `jc` and `jace-commander`, adds the `jace auth` command group, and migrates local CLI auth to DPoP + `SecretStore` (or headless `EncryptedFileStore`).
- `apps/gateway` enforces ADR 0030 refresh PoP plus DPoP/PoP on device-authenticated ACS requests with persistent `jti` replay protection.
- Verification spans 32 independent security and compatibility acceptance checks across `/jc`, `jace-commander`, and ACS; Linux Secret Service (`secret-tool`) and headless `EncryptedFileStore` are verified live on Linux, while macOS Keychain and Windows Credential Manager adapters are verified via mocked command-runner unit/contract tests because CI runs on `ubuntu-latest`.
