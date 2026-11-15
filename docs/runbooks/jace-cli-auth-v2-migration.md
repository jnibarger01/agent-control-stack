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
   - Set `ACS_PUBLIC_ORIGIN` so DPoP `htu` validation uses the configured external origin rather than `Host` headers.
2. **Run ACS migrations & start gateway:**
   - Startup (`applyControlPlaneMigrations`) applies `storage/migrations/079_device_auth_refresh_recovery.sql` and the DPoP `jti` replay migration additively.
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

- `jace auth status --json` shows `auth_mode: "dpop"`, `device_id`, `jkt`, `issuer`, `audience`, and `storage_backend` (`secret-service`, `kwallet`, `keychain`, `windows-credential-manager`, or `encrypted-file`), with zero raw tokens or private keys printed.
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
