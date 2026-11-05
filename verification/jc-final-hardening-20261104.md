# Jace Commander final hardening — 2026-11-04

## Verified source and findings

Native branch pre-evidence HEAD: `51fbc2d5dc00ed42d69882ef24398461b65a9fd0`; release-gate ancestor: `318c5f25`. The requested code changes are already present in native-branch commits following that ancestor; no duplicate source edits were required.

1. **Dedicated credential:** `current-authority.ts` accepts only `JC_ACS_AUTHORITY_TOKEN` or `JC_ACS_AUTHORITY_TOKEN_FILE`. The bridge checks the dedicated credential for readiness. Missing, blank, and unreadable credential cases fail closed even with `JC_ACS_TOKEN` or a worker token.
2. **Real ACS least privilege:** The E2E harness provides a distinct `acs:read`-only authority credential, separate from the worker token. Tests cover operator approval, audited execution, denied mutations, revocation, lease expiry, replay protection, and principal isolation.
3. **Installed runtime:** The CachyOS unit template sets `JC_RUNTIME_DIR=%h/.local/lib/jace-commander/current` and `JC_REQUIRE_INSTALLED_RELEASE=1`. Tests verify startup, readiness, correct reported path, and rejection of development checkout and writable releases.

## Verification

| Command | Result |
| --- | --- |
| `npm test -w apps/jace-commander` | PASS — 30/30 suites |
| `node --test apps/dc-mcp-gateway/test/jc-authority-credential.test.mjs apps/dc-mcp-gateway/test/jc-installed-release.test.mjs` | PASS — 16/16 tests |
| `ACS_DC_E2E=1 npx vitest run tests/e2e/acs-jc-mcp` | PASS — 30/30 tests |
| `npx vitest run apps/gateway/src/jc-capability-issue.test.ts apps/gateway/src/execution-admission.test.ts apps/gateway/src/admin-mode-allow-authority.test.ts` | PASS — 66/66 tests |
| `npm run jc:verify-release` | PASS — installed 30/30 suites, masked 27/27 suites, MCP session PASS, zero reported shipped audit vulnerabilities; see `verification/jc-release-standalone-evidence.json` |

## Operational boundary and verdict

After `0497b505`, `npm run jc:verify-release` passed again (evidence commit records that hash). The user service was restarted onto `~/.local/lib/jace-commander/releases/1.0.0-0497b505a9c2` (`previous` remains `1.0.0-3662ddf96d50`). The unit is active and not enabled. The native JC child is that read-only release. `ExecStart` is still the checkout's `apps/dc-mcp-gateway/bridge.js`; that process is the loopback MCP adapter, not Desktop Commander, and the managed JC profile refuses a `DC_ARGS` override.

`/health` is 200. `/ready` is 503 because `~/.config/acs/jc-authority.token` does not exist. ACS is not listening on 127.0.0.1:3000. An unauthenticated `/mcp` initialize returns 401 `gateway attestation required`. No production credential was created, and no Tailscale or public ingress was enabled.

**BLOCK for live governed execution.** Local build, tests, clean-install verification, and the pinned native runtime pass. An operator must add a dedicated ACS credential (`id` distinct, `actor` `agent`, `roles` `["service"]`, `scopes` `["acs:read"]` only, `token` at least 32 characters) to `ACS_GATEWAY_CREDENTIALS_JSON`, put only that token in `~/.config/acs/jc-authority.token` (0600), and have ACS reachable at the configured gateway URL. Do not reuse the worker token or an operator token.
