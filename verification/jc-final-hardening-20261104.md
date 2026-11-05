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

The installed user service is active; `~/.local/lib/jace-commander/current` resolves to `~/.local/lib/jace-commander/releases/1.0.0-3662ddf96d50`. The *native JC child* is release-pinned, but the bridge `ExecStart` still uses the checkout's `apps/dc-mcp-gateway/bridge.js`; complete bridge packaging independence is not claimed.

The live bridge returns HTTP 503 for `/ready`, because its dedicated ACS authority credential has not been provisioned. No live credentials, services, ARES worktrees, or production authorization were modified.

**PARTIAL — not production-ready for governed execution.** Local source hardening and tested integration pass, but live ACS authority provisioning and production readiness remain blocked pending explicit approval. Existing modified status notes, backup files, and other worktrees are preserved. No push, deployment or merge into main.
