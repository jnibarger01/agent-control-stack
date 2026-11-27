# W7 External Gateway Integration Verification (`/jc/mcp`)

**Worktree:** `/home/jacen/projects/.worktrees/jca2-release-closure/w7-external-gateway`  
**Branch:** `worker/w7-external-gateway-20261115`  
**Base:** `861e8f6e97024cddb3e4573f543db62520eec8fc`  
**Scope:** Gateway-boundary auth verification through proxy chain + managed Jace Commander auth path (capability issuance, live-authority, git ops) in isolated reproducible harnesses. No production routing/DNS/certificates/services/authentication configuration changed. No merge/push/deploy. Secrets redacted in artifacts.

## Actual external/staging route status

**Actual external-route acceptance: PENDING.** No safe, controlled external staging route was exercised and no production routing/DNS/certificates/services/auth configuration was modified. Boundary checks were executed through a reproducible HTTPS reverse-proxy chain (simulated TLS termination + real public ingress + real gateway). Managed-path checks were executed in an isolated loopback e2e harness of real components.

---

## 1) Gateway boundary verification via HTTPS reverse-proxy chain (executed)

**Harness/config:** `verification/w7-external-gateway/external-gateway-harness.mjs`, `verification/w7-external-gateway/PROXY_CONFIG.md` (section 1).  
**Chain:** HTTPS TLS termination (self-signed, canonical origin) -> `public-edge-proxy` allowlist ingress -> `dc-mcp-gateway` `/jc/mcp` -> stub upstreams.  
**Commands / exit codes:**
- `node -v && npm -v` → exit 0 (Node v26.13.1, npm 12.2.2)
- `npm ci --ignore-scripts --no-audit --fund=false` → exit 0 (deps installed in isolated worktree; `node_modules` not committed)
- `node verification/w7-external-gateway/external-gateway-harness.mjs` (final) → **exit 0**

**Evidence (redacted):** `verification/w7-external-gateway/evidence/evidence.json`, `verification/w7-external-gateway/evidence/results.json`, `verification/w7-external-gateway/evidence/gateway.log`

| Area | Status | Evidence / notes |
|---|---|---|
| Canonical external origin + HTTPS termination | **PASS** | `GET https://127.0.0.1:<tls>/.well-known/oauth-protected-resource/jc/mcp` via TLS reverse proxy -> public ingress -> gateway returned 200 with canonical `resource`/`authorization_servers` (`https-discovery-via-external-proxy`). |
| Forwarded-header handling | **PASS** | Spoofed `Host`/`X-Forwarded-*`/`Forwarded` with correct canonical DPoP `htu` succeeded 200 (`forwarded-header-spoof-canonical-proof`); gateway binds htu to configured canonical origin/path. |
| DPoP `htu` correctness | **PASS** | Canonical `htu` accepted 200 (`mcp-positive-canonical-htu`/retry). |
| Nonce challenges | **PASS** | Missing nonce -> 401 `use_dpop_nonce` + `DPoP-Nonce` (`mcp-nonce-challenge`); token endpoint nonce challenge observed in issuance flow. |
| Nonce retry | **PASS** | Retry with issued nonce succeeded 200 (`mcp-nonce-retry`, token issuance 200 DPoP). |
| Replay protection | **PASS** | Same `jti`: first 200, replay 401 (`replay-first`, `replay-second`). |
| Access-token audience | **PARTIAL** | Positive audience/resource binding on `/jc/mcp` evidenced (canonical success, wrong-resource/htu/path rejected). Direct cross-lane probe (JC token to DC `/mcp`) through filtered public ingress returned 404 at ingress policy before gateway (`wrong-audience-jc-token-on-dc-path-ingress-denied`), so gateway-level cross-lane 401 not directly observable through this ingress boundary. |
| Wrong-origin rejection | **PASS** | Attacker-origin htu -> 401; wrong-path htu -> 401 (`wrong-origin-proof`, `wrong-path-proof`). |
| Wrong-key rejection | **PASS** | Stolen token with attacker key -> 401 (`wrong-key-stolen-token`). |
| Bearer downgrade rejection | **PASS** | `Authorization: Bearer <DPoP-bound token>` -> 401 with DPoP `WWW-Authenticate` (`bearer-downgrade`). |
| Revoked-device rejection | **PASS** | `DELETE /jc/devices/:id` 200 then post-revoke `/jc/mcp` 401 (`device-revoke`, `mcp-after-revoke`). |

---

## 2) Managed Jace Commander auth path (executed in isolated harness)

**Requirement:** ACS capability issuance, live-authority checks, and at least one successful and one rejected Git operation through the authenticated/authorized path.

**Harness/config:** real ACS gateway (SQLite, `acs.jc.v1` signing/issuance), real managed edge, real jc bridge, real `jace-commander serve` (dist copied into worktree for execution), disposable repo+bare remote. See `PROXY_CONFIG.md` (section 2). Executed via existing e2e suites (real implementations):

- `tests/e2e/acs-jc-mcp/jc-operations.test.ts`
- `tests/e2e/acs-jc-mcp/jc-native-authority.test.ts`

**Preparation commands / exit codes:**
- `cp -r /home/jacen/projects/agent-control-stack/apps/jace-commander/dist apps/jace-commander/dist` → exit 0 (read-only source copied into isolated worktree)
- `npx tsc -b` → exit 0 (built workspace packages needed for e2e imports in isolated worktree)

**Execution command / exit code:**
- `ACS_DC_E2E=1 npx vitest run tests/e2e/acs-jc-mcp/jc-operations.test.ts tests/e2e/acs-jc-mcp/jc-native-authority.test.ts` → **exit non-zero** (1 failed test file, 1 passed; 2 failed / 17 passed tests). Log: `verification/w7-external-gateway/evidence/managed-jc-e2e.log`.

**What was actually executed (PASS evidence):**
- **ACS capability issuance (managed path):** approval-gated tool calls returned `managed_authorization_required` / `require_approval` until operator approved the exact action in ACS, then executed on retry (e.g. `write_file does nothing until the operator approves those exact arguments`, `start_process needs approval...`, git operations through approvals, native-authority flow). This demonstrates edge-mediated capability issuance/authorization via ACS in the managed chain.
- **Live-authority checks:** `jc-native-authority.test.ts` passed (8/8): unapproved run_command never runs and approved execution is audited to ACS; JC authority token is acs:read-only and cannot approve/issue/submit/create; without dedicated authority token approved call refused (`ACS_UNAVAILABLE` / missing authority token) and lane not ready; with read-only token lane reports ready; **lease revoked after issuance refused by JC before anything runs**; **lease expired after issuance refused by JC before anything runs**; replayed capability refused; principal isolation enforced.
- **Successful Git operation (authenticated/authorized):** `git add -> commit -> push a disposable repository through approvals` **passed** (git_status, approved git_add, approved git_commit, approved git_push; remote advanced to pushed HEAD; CLI git log verified).
- **Rejected Git operation (authenticated/authorized):** `git_push of an unapproved commit is refused even after approval when HEAD moved` **passed** (approved git_push refused with `head_moved`; remote ref unchanged).

**Failures (not managed-auth/git acceptance):**
- `live tools/list is exactly the manifest's descriptors (42 tools)` failed: expected 42 tools, got 40 (manifest/drift between copied jace-commander dist and branch manifest in this harness).
- `jace-commander doctor reports the live chain healthy` failed on `liveHandlerCount` 40 vs 42 for same drift reason.
These did not affect the executed capability-issuance, live-authority, or git approval/refusal flows above.

---

## Overall status

| Verification area | Status |
|---|---|
| HTTPS reverse-proxy boundary: canonical origin/termination, forwarded-header handling, DPoP htu, nonce challenge/retry, replay, wrong-origin, wrong-key, bearer downgrade, revoked-device | **PASS** |
| Access-token audience (cross-lane via filtered ingress) | **PARTIAL** (see section 1) |
| Managed path: ACS capability issuance | **PASS (executed in isolated harness)** |
| Managed path: live-authority checks | **PASS (executed in isolated harness)** |
| Managed path: successful Git operation through authenticated/authorized path | **PASS (executed in isolated harness)** |
| Managed path: rejected Git operation through authenticated/authorized path | **PASS (executed in isolated harness)** |
| Actual external/staging route acceptance | **PENDING** (no safe external staging route; no prod routing/DNS/certs/services/auth changes) |

## Remaining infrastructure limitations

1. Actual external/staging HTTPS route not exercised; self-signed localhost TLS proxy used for boundary harness.
2. Cross-lane audience probe limited by public ingress route policy (denies `/mcp`).
3. Managed e2e executed on loopback real-component harness, not through an external staging network edge; git operations used disposable local repo/bare remote.
4. e2e manifest/tool-count drift (40 vs 42) in this worktree build/dist combination caused 2 non-auth failures; core managed auth and git cases passed.
5. `npm ci` and `tsc -b`/package builds modified isolated worktree (`node_modules/`, package `dist/` outputs, copied `apps/jace-commander/dist`); build artifacts not committed except verification evidence/docs and copied dist treated as execution aid (see git status/commit).

## Changed files / commit SHAs

Changed/added in worktree (to be committed): `verification/w7-external-gateway/external-gateway-harness.mjs`, `verification/w7-external-gateway/PROXY_CONFIG.md`, `verification/w7-external-gateway/VERIFICATION_REPORT.md`, `verification/w7-external-gateway/evidence/*`. Build/runtime artifacts present but not intended for commit: `node_modules/`, various `dist/` outputs, `apps/jace-commander/dist/` (copied). Commit SHA(s): see git log below after commit.

## Integration notes for coordinator

- External boundary behavior is strongly shaped by `public-edge-proxy` allowlist (blocks non-JC routes including `/mcp`); include this in route-acceptance planning.
- Managed JC git mutations succeed/reject correctly under ACS approval + live authority in harness; `git_push` head-moved refusal verified.
- For full external-route acceptance, rerun boundary + managed checks against controlled external/staging HTTPS route with real certs/DNS/ingress and capture redacted evidence.
