# Runbook: JACE CLI AUTH V2 Migration and Rollback

This runbook covers migrating `/jc` edge OAuth (`apps/dc-mcp-gateway`), `jace-commander` CLI (`apps/jace-commander`), and ACS device auth (`apps/gateway`) to JACE CLI AUTH V2 ([ADR 0031](../adr/0031-jace-cli-auth-v2.md) and [ADR 0030](../adr/0030-device-bound-refresh-and-recovery-envelopes.md)), and rolling back safely if needed.

## 1. Pre-Flight & Compatibility Guarantees

- **Node runtime:** Verify Node `>= 24.16.0` on all gateway and CLI hosts (`node:sqlite` and Ed25519 `node:crypto` are required).
- **Hosted & legacy clients preserved:**
  - ChatGPT (DCR + PKCE S256 + `Bearer`) and Claude (CIMD + PKCE S256 + `Bearer`) continue working without `cnf.jkt` or `DPoP` changes.
  - Explicit `JC_MCP_TOKEN` environment overrides for CI/automation continue working in `legacy-bearer-env` mode.
  - `jace-auth` is separate from `/jc` and requires no changes.
- **Backups before upgrading:**
  - Snapshot `apps/dc-mcp-gateway` `DATA_DIR` (`clients.json`, `tokens.json`) to an offline `0700` backup directory.
  - Snapshot the ACS SQLite database (`ACS_DB_PATH`) per [sqlite-backup-restore.md](sqlite-backup-restore.md).
  - Back up any existing CLI state directory (`~/.jace-commander` and `~/.config/acs/credentials.json`, mode `0700`/`0600`).

## 2. Gateway Migration (`apps/dc-mcp-gateway`)

1. **Verify canonical origin and lane environment variables** in the edge service env file:
   - `PUBLIC_ORIGIN` (canonical `https://...` URL — never rely on `Host` or `X-Forwarded-*` for DPoP `htu`)
   - `JC_ENABLED=1`, `JC_ISSUER=${PUBLIC_ORIGIN}/jc`, `JC_RESOURCE=${PUBLIC_ORIGIN}/jc/mcp`
   - `ACS_GATEWAY_URL` and distinct `ACS_JC_GATEWAY_TOKEN`
2. **Configure V2 security variables:**
   - `JC_REFRESH_RECOVERY_KEY` (optional 32-byte base64/hex secret for AES-256-GCM refresh recovery envelopes; if unset, derived via HKDF from `SIGNING_KEY`).
   - `DPOP_NONCE_REQUIRED=1` (default enabled for `jace-commander-cli` and DPoP endpoints).
3. **Restart `dc-mcp-gateway` (`server.js`):**
   - On startup, `store.js` creates `DATA_DIR/gateway.db` (`0600`, SQLite WAL) with `dpop_jtis`, `auth_codes`, `refresh_tokens`, `jc_devices`, and recovery envelope tables.
   - Legacy `DATA_DIR/tokens.json` records are imported non-destructively into `gateway.db`; `tokens.json` is preserved on disk for rollback safety.
4. **Verify edge readiness & metadata:**
   - `GET /healthz` and `GET /jc/ready` return `200`.
   - `GET /.well-known/oauth-authorization-server?oauth_lane=jc` advertises `dpop_signing_alg_values_supported: ["EdDSA", "ES256"]` and `device_authorization_endpoint`.

## 3. ACS Gateway Migration (`apps/gateway`)

1. **Provision required recovery key:**
   - Generate a dedicated 32-byte key (`openssl rand -base64 32`) and set `ACS_DEVICE_REFRESH_RECOVERY_KEY` (plus optional `ACS_DEVICE_REFRESH_RECOVERY_KEY_ID`). Do **not** reuse `ACS_GATEWAY_TOKEN`. Without this key, `grant_type=refresh_token` fails closed (`503 recovery_unavailable`).
   - Set `ACS_PUBLIC_ORIGIN` (or `ACS_PUBLIC_URL`) so DPoP `htu` validation uses the configured external origin rather than `Host` headers, and set `ACS_DPOP_NONCE_REQUIRED=1` + `ACS_DPOP_NONCE_SECRET` if strict server-issued nonces are required on ACS device endpoints.
2. **Run ACS migrations & start gateway:**
   - Startup (`applyControlPlaneMigrations`) applies `storage/migrations/079_device_auth_refresh_recovery.sql` and `storage/migrations/080_device_auth_dpop.sql` additively.
   - Existing ACS devices without DPoP refresh/access re-enroll or re-login with `acs auth login` / updated `jace-commander` `device-login`.

## 4. CLI Migration (`apps/jace-commander`)

1. **Install/upgrade the `jace-commander` package** (exposes `jace`, `jc`, and `jace-commander` binaries).
2. **Verify OS credential storage or configure headless fallback:**
   - **Linux desktop (GNOME Keyring / KDE KWallet Secret Service):** Verify `secret-tool` (or `kwallet-query`) and an unlocked `org.freedesktop.secrets` session (`DBUS_SESSION_BUS_ADDRESS`).
   - **macOS:** Uses `security` against the user Keychain.
   - **Windows:** Uses PowerShell DPAPI / Windows Credential Manager.
   - **Headless Linux / SSH / containers / CI (no D-Bus Secret Service):** Set `JC_KEYRING_PASSPHRASE` or `JC_KEYRING_KEY_FILE` (mode `0600` outside `JC_STATE_DIR` or in a separate `0700` key path). Plaintext fallback is never used.
3. **Re-authenticate CLI sessions to obtain DPoP-bound tokens:**
   - Interactive workstation:
     ```sh
     jace auth login --label "$(hostname)"
     ```
   - Headless terminal / SSH:
     ```sh
     jace auth login --device --no-browser --label "$(hostname)-headless"
     ```
   - Verify status (non-secret output only):
     ```sh
     jace auth status --json
     jace auth devices --json
     ```
4. **Legacy `mcp-token.json`:** Pre-V2 Bearer `mcp-token.json` files are not accepted as DPoP sessions; re-running `jace auth login` replaces local state with a DPoP-bound credential and `SecretStore` entry.
5. **CI / automation:** Keep `JC_MCP_TOKEN` explicitly set where a static legacy Bearer token is intentionally used; `jace auth` never persists `JC_MCP_TOKEN` and never auto-downgrades DPoP sessions to Bearer.

## 5. Verification Checklist

- `jace auth status --json` shows `auth_mode: "dpop"`, `device_id`, `jkt`, `issuer`, `audience`, and `storage_backend` (`linux-secret-service`, `linux-kwallet`, `macos-keychain`, `windows-dpapi`, or `encrypted-file`), with zero raw tokens or private keys printed.
- `jace auth refresh` succeeds and preserves the same `device_id` and `jkt`.
- `jace auth devices --json` lists active devices; `jace auth revoke <device-id>` revokes the device immediately and subsequent requests fail closed.
- ChatGPT and Claude custom connectors continue passing `/mcp` and `/jc/mcp` calls.

## 6. Rollback Procedure

### CLI Rollback

1. Reinstall the previous `jace-commander` release (`install-user-release.sh` / re-point `current` symlink).
2. Restore the backed-up `~/.jace-commander` / `~/.config/acs/credentials.json` if needed, or run `jc connect` against a pre-V2 edge.
3. If immediate CI continuity is needed during rollback, set `JC_MCP_TOKEN` explicitly.

### `/jc` Edge Gateway Rollback

1. Stop `dc-mcp-gateway` (`server.js`).
2. Restore the backed-up `DATA_DIR/tokens.json` and `clients.json` (existing `tokens.json` was not deleted during V2 upgrade; rename or archive `gateway.db` if downgrading across incompatible schemas).
3. Deploy and start the previous `apps/dc-mcp-gateway` revision.
4. Any V2 CLI sessions minted with `cnf.jkt` will be rejected by a pre-V2 edge or treated as invalid; CLI users simply run `connect` / `login` again after rollback.

### ACS Gateway Rollback

1. Stop `apps/gateway`.
2. Restore the pre-migration `ACS_DB_PATH` SQLite backup taken in Section 1 (do **not** run a downgraded gateway against a forward-migrated database without restoring the backup).
3. Deploy and start the previous `apps/gateway` revision and re-run `acs auth login` on CLI hosts if needed.

## Owner consent through Jace Auth (single owner)

`/jc/device` can authenticate WHO approves a device. Without it the shared consent passphrase gates approval and every device is
recorded as `jacen`; the passphrase cannot say who approved.

### Enable (all four are required together; a partial set stops the gateway at startup)

| Env | Meaning |
| --- | --- |
| `JC_OWNER_OIDC_ISSUER` | The Jace Auth issuer, exactly as in its discovery document (`https://jace-auth.vercel.app`). https only |
| `JC_OWNER_OIDC_CLIENT_ID` | A **dedicated** OIDC client for this gateway (do not reuse ACS or Toyota clients) |
| `JC_OWNER_OIDC_ALLOWED_SUB` | The one Jace Auth `sub` allowed to approve. Exactly one value at launch |
| `JC_OWNER_OIDC_CLIENT_SECRET` | Optional. Unset = public client with PKCE; set = `client_secret_basic` |

Optional: `JC_OWNER_OIDC_PROMPT_LOGIN=0` (default on: forces a fresh sign-in), `JC_OWNER_OIDC_ALLOW_LEGACY_ENROLLMENT=1` (see below).

Provision in Jace Auth first (not done by this change): register the client with redirect URI
`<PUBLIC_ORIGIN>/jc/device/callback`, authorization code + PKCE S256, scope `openid`, and expose the owner's `sub`.
**A live consent round trip against the real Jace Auth has not been run.** Tests use a fake OpenID Provider.

### What changes

* Browser flow: `jace-commander auth login --device` is unchanged. The page signs you in through Jace Auth (auth code + PKCE, `prompt=login`), verifies
  the ID token (RS256/ES256 via JWKS, `iss`, `aud`/`azp`, `exp`, `iat` freshness, `nonce`), requires `(iss, sub)` to equal the allow-listed owner,
  then shows client, device label, scope, code and expiry. Approval is an explicit POST bound to that session (CSRF token) and to that exact
  pending enrollment (HMAC binding). The session is single use.
* The verified pair is stored as `owner_iss` / `owner_sub` on the device and its refresh tokens, and carried as `oiss` / `osub` access-token claims.
  The ACS-facing `sub` stays `jacen`, so ACS attribution and policy are unchanged. Moving ACS to the verified subject is a separate decision.
* `/jc/devices` and revoke are scoped to the caller's `(oiss, osub)`. Another owner's device answers 404, exactly like a missing one.
* Passphrase approval on `/jc/device` is **off** while owner consent is on. `/authorize/consent` (ChatGPT / Claude Bearer flow) is unchanged.
* A DPoP-bound CLI device can no longer be enrolled from the shared passphrase through the loopback authorization-code path (`jc connect`)
  while owner consent is on; use the device flow. `JC_OWNER_OIDC_ALLOW_LEGACY_ENROLLMENT=1` re-allows it (those devices have no verified owner).

### Existing `jacen` devices: decision

They are **not migrated**. Rows enrolled through the passphrase keep `owner_iss`/`owner_sub` NULL, keep working until their refresh token expires,
and live in their own namespace: a verified owner does not see or manage them, and they do not see owner devices. Re-enroll each device with
`auth login --device`, then revoke the old record with its own legacy credential. Migrating them would attribute devices to an account nobody verified.
Moving them anyway is a one-line SQL `UPDATE jc_devices SET owner_iss=..., owner_sub=...` and must be a deliberate, recorded operator action.

### Rate limiting

* Owner mode: failed code lookups/decisions are throttled **per owner session** (5 per 5 minutes). Unauthenticated traffic only receives a
  redirect to Jace Auth, so there is nothing to lock and nobody can lock anybody else out.
* Passphrase paths (`/jc/device` in legacy mode and `/authorize/consent`): the ingress strips `X-Forwarded-*`, so no caller identity exists. Repeated failures
  add a bounded delay (up to 2 s) and never lock. This slows guessing; it does not make a weak passphrase strong.

### Rollback

Unset the four `JC_OWNER_OIDC_*` variables and restart the gateway: `/jc/device` returns to the (hardened) passphrase form. Devices enrolled under owner
consent keep working and stay manageable by their owner's own tokens, because list/revoke scoping reads the token's `oiss`/`osub`, not the configuration.
The owner columns are additive; a previous gateway revision ignores them and would treat those devices as plain `jacen` devices.

