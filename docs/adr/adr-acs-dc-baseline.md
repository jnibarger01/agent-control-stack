# ADR: ACS ↔ Desktop Commander execution-chain baseline (2026-09-25)

- **Status:** Accepted baseline; Phase 1 approved; Step 0.5 closed; Steps 1, 2a in progress
- **Note:** "Captured baseline" is a historical record of the 2026-09-25 state. It is **not** a no-mutation directive; normal, reviewed changes continue.
- **Date:** 2026-09-25
- **Scope:** Agent Control Stack (ACS), Desktop Commander (DC) fork, DC MCP gateway, DC relay (device + control plane)
- **Out of scope for Phase 1:** Mission Router, Looptrace, Visualizer, package-manager/build-tool changes (pnpm, Turbo)

## Context

On 2026-09-24/25 a ChatGPT → DC audit failed, and fixing it took one night of cross-repository debugging. Every failure crossed a repository boundary:

| Failure | Root cause | Class |
|---|---|---|
| ChatGPT "Connection failed" / DC quota burn | Managed device pointed at `mcp.desktopcommander.app` by default; stock `desktop-commander remote` sharing `~/.desktop-commander-device/device.json` (refresh-token rotation race) | config / shared state |
| `get_runtime_identity` → `unknown_tool`, then `ACS_CAPABILITY_MALFORMED`, then `ACS_CAPABILITY_TOOL_MISMATCH` | Tool list duplicated in three places (ACS `tool-policy.ts` + `capability.ts`, DC `managed-acs.ts`), each fails closed independently | contract drift |
| `get_config` → `desktop_commander_argument_invalid` | DC advertises optional `origin: 'ui'\|'llm'`; ACS schemas are `.strict()` | contract drift |
| Relay device present but never ready | One failed re-attach → permanent `local_mcp_not_ready`; SSE-stream errors caused ~1/s attach flap | transport resilience |
| MCP path `runtime_bootstrap_rejected` from 04:11 | DC `dist` rebuilt in place (04:07:47) under a running, attested runtime | deploy-from-worktree |

The common factor: live services ran from **mutable development checkouts**, and the contract between components existed as **hand-copied tables**.

## Captured baseline

### Source snapshots

Non-invasive snapshot commits (HEAD, index, working tree and checked-out branch untouched). Excluded: env files, `*.bak`, `backups/`, probes, `.codex/`, nested `.worktrees/`, `supabase/.temp/`, `.claude/settings.local.json`. Secret-scanned; one allowlisted dummy fixture (`sk-abc…nop` in `harness-result.test.ts`).

| Component | Checkout | Branch | HEAD | Snapshot ref → commit |
|---|---|---|---|---|
| ACS | `~/projects/agent-control-stack` | `main` (↑2 ↓9 origin) | `7d9464a` | `snapshot/20260925/acs-main` → `7b60e09` (54 paths) |
| DC (bridge child + ACS executor) | `~/projects/desktop-commander` | `fix/remote-device-managed-attach` | `30e572f` | clean — no snapshot needed |
| DC relay device | `~/projects/dc-wt-own-relay-device` | `feat/own-relay-device` | `e869b24` | `snapshot/20260925/dc-relay-device` → `053cc49` |
| DC relay control plane | `~/projects/dc-wt-own-relay-plane` | `feat/own-relay-plane` | `19a1308` | `snapshot/20260925/dc-relay-plane` → `6b0fa00` |
| DC MCP gateway + bridge | `~/projects/desktop-commander-mcp-gateway` | `main` | `f47bca9` | `snapshot/20260925/dc-mcp-gateway` → `7e17d50` |
| ACS policy fix (reviewed copy) | `.worktrees/acs-dc-runtime-identity-policy` | `fix/dc-get-runtime-identity-policy` | — | `51000e2` |

### Runtime map (unit → artifact → checkout → commit)

| Unit | Executable | Checkout | Running code matches |
|---|---|---|---|
| `acs-gateway` (pid 317156, 03:30:43) | `apps/gateway/dist/cli.js` | `agent-control-stack` | ≈ `7b60e09` **except** `apps/gateway/src/server.ts` edited 04:26 (unbuilt) |
| `desktop-commander-auth-proxy` (:8010, 03:35:36) | `server.js` | `desktop-commander-mcp-gateway` | `7e17d50` ✔ |
| `desktop-commander-mcp` (:8002 bridge, 03:35:36) | `bridge.js` → child `desktop-commander/dist/index.js` | gateway + `desktop-commander` | bridge `7e17d50` ✔; child `30e572f` build (04:07:47) ✔ |
| `desktop-commander-remote-managed` (02:25:46) | `dc-wt-own-relay-device/dist/index.js remote --managed` + drop-in `10-own-relay.conf` | `dc-wt-own-relay-device` | **none** — dist rebuilt 04:28 after start; restart loads `053cc49` |
| relay control plane (herdr pane, pid 27968, 01:45:25) | `dist/control-plane/server.js` | `dc-wt-own-relay-plane` | **none** — dist rebuilt after start; restart loads `6b0fa00` |
| `acs-worker`, `desktop-commander-acpx` | — | — | inactive |

ACS also spawns DC directly (`ACS_DESKTOP_COMMANDER_ARGS_JSON` → `~/projects/desktop-commander/dist/index.js`, cwd = that checkout).

State that must not move with a working directory: ACS DB `ACS_DB_PATH=/home/jacen/agent-control-stack-chatgpt-app/storage/control.db` (absolute); gateway `DATA_DIR=…/desktop-commander-mcp-gateway/data` (absolute, but inside the checkout); gateway env file is `desktop-commander-mcp-gateway/.env` (inside the checkout).

### Execution-chain verification (pre-cutover, still running from checkouts)

Incident 04:11–06:54: DC `dist` rebuilt in place (commit `30e572f`) changed `sha256(dist/index.js)` from `f70932…` to `c948f1…`; ACS correctly rejected bootstrap as runtime registration drift (409, 24 expired challenges). Runtime `dd31bf90` was revoked and `3587cc5f` registered/attested at `c948f1…` at 06:43–06:46 by an actor outside this session (unattributed; see open items). Credential `acs-dc-bridge` rotated 06:50 (gateway.env, bridge.env, and — after a missed-consumer outage 06:53–06:54 — `desktop-commander-mcp-gateway/.env`); old credential verified rejected (401).

| Gate | Result | Evidence |
|---|---|---|
| Old `acs-dc-bridge` credential rejected | PASS | `POST /dc/capability/issue` → 401; new → 400 (authenticated) |
| `initialize` attested | PASS | `:8010` `POST /dc/runtime/bootstrap/complete -> 204`, `initialize attested + proxied` |
| ACS issues capabilities | PASS | 3 × `/dc/capability/issue` for 3 tool calls; 0 × 4xx/5xx on `:8010` |
| MCP tool call through ACS → DC | PASS | `get_config {origin:"llm"}` returned config (origin stripped, strict schema held) |
| Relay path | PASS | relay → device `2a8768d3` → `:8010` → ACS → DC: `get_runtime_identity` → `runtime_id 3587cc5f…`, `execution_mode managed` |
| Managed connection survives `:8010` restart | PASS | device pid unchanged; one `SSE stream unavailable (session kept)` line; next call succeeded and was capability-governed |

| Hop | Unit | Code |
|---|---|---|
| Relay control plane | herdr pane (pid 27968) | `dc-wt-own-relay-plane` build from 01:45 (≠ `6b0fa00`; restart needed) |
| Relay device | `desktop-commander-remote-managed` (06:54:14) | `dc-wt-own-relay-device` dist = `053cc49` |
| MCP gateway | `desktop-commander-auth-proxy` (06:55:09) | `7e17d50` |
| ACS | `acs-gateway` (06:52:46) | `7b60e09` working tree; gateway dist 03:29, adapter dist 03:30 |
| Bridge + DC child | `desktop-commander-mcp` (06:52:49) | bridge `7e17d50`; DC `30e572f` (`c948f1…`) |

### Security finding: runtime attestation does not cover enforcement code

The managed runtime's `identityConfigFingerprint` is `sha256(dist/index.js)` only (`desktop-commander-mcp-gateway/managed.js:dcRuntimeIdentityFromState`). Authorization-enforcement modules — e.g. `dist/managed-acs.js` (tool→scope table) and `dist/enforcement/pipeline.js` (capability verification) — can change without changing the attested fingerprint. Observed: `managed-acs.js` was modified and rebuilt at 03:32 and attestation continued unchanged. Conversely, a harmless `index.ts` refactor forced a full runtime rotation.

**Required (Phase 1):** replace the entrypoint hash with a release-wide content manifest — sorted `(path, sha256)` over every file in the release's `dist/` plus `package-lock.json`, hashed to one digest recorded in `RELEASE.json` alongside the commit — and have ACS pin that digest. Runtime identity then changes exactly when executable code changes, and every change is tied to an immutable release.

## Decision

### Invariants

1. **ACS is the sole authorization authority.** No gateway, relay, bridge, orchestrator or UI makes an allow/deny decision of its own.
2. **DC independently validates the ACS capability in-process, immediately before execution** (tool, scopes, exact arguments, nonce single-use, runtime identity). Extracting verification code into a shared package is allowed; moving the check out of the DC process is not.
3. **Gateway and relay may transport, and may normalize only fields the shared tool manifest explicitly marks strippable** (today: `origin ∈ {ui, llm}`). Anything else passes through unchanged so ACS rejects it.
4. **No orchestrator, UI or transport component reaches the OS** except through the ACS-authorized DC execution path.
5. **Every deployed process is traceable to a Git commit.** Services run from immutable release directories (`~/releases/<component>/<sha>/` with `RELEASE.json`), never from a development checkout. Rebuilding a checkout must not change a running or attested runtime.

### Phase 1 (ACS/DC chain only)

Release provenance is a **prerequisite to cutover**, not only an invariant. For every unit, in dependency order (ACS → bridge/DC → MCP gateway → relay plane → relay device):

```
build clean release → write RELEASE.json → verify digest → repoint unit → restart → attest
```

No development checkout is made read-only, archived or subtree-imported until every unit that ran from it passes that sequence.

| Step | Work | Exit criterion |
|---|---|---|
| 0.5 | Close carried-over defects **before** any migration, so they can't be mistaken for migration regressions: remove/rotate plaintext `CONSENT_PASSPHRASE.txt`; revoke stale relay device `4258ed2b`; run the relay control plane under systemd from a release directory. | **Closed 2026-09-25 07:05** — see *Step 0.5 evidence* |
| 0.6 | **Release mechanism** (no cutover here): build script, `RELEASE.json` with commit + pinned Node version, content manifest + digest, `ExecStartPre` digest check, unit template, rollback procedure. Fix or park failing release tests (`dc-mcp-gateway` harness-dispatch timeout; ACS `coding-harness` TS error and approval action-hash test). Proven once on the relay plane (done 07:05). | Mechanism documented and reusable; release tests green |
| 1 | Unify DC fork branches (`fix/remote-device-managed-attach`, `feat/own-relay-device`, `feat/own-relay-plane`) into `integration/own-relay`. **Known conflict:** `desktop-commander-integration.ts` (managedAttachFlight in `30e572f` vs reconnect loop in `053cc49`). Park or resolve `reconcile/2026-09-07/upstream-main`. | One final DC commit on `integration/own-relay`; full suite green (no default quarantines) |
| 2a | **Release-wide runtime attestation** (before any DC runtime cutover): runtime identity fingerprint = digest of the release content manifest (every file in the release except `node_modules`, plus `package-lock.json`), recorded in `RELEASE.json`, computed by the gateway from the running release, pinned by ACS. Replaces `sha256(dist/index.js)`. | Changing any enforcement module changes the fingerprint (test); one runtime rotation onto the final DC release |
| 2b | First monorepo package **`@acs/dc-tool-manifest`**: per tool → risk class, scopes, strict arg schema, strippable fields. Consumed by ACS adapter, MCP gateway, DC `managed-acs.ts`. Drift test in CI. | Adding a tool is one edit; mismatch fails CI |
| 2c | **DC runtime cutover** — bridge child, relay device, relay plane from ONE release of the final Step-1 commit, via the 0.6 mechanism and 2a attestation; ACS/gateway cutover in the same window if their releases are green. | Every DC-lineage process maps to the same `RELEASE.json` commit + digest |
| 3 | **Only after 0.5, 0.6, 1, 2a, 2b and 2c are closed:** `git subtree add`: gateway → `apps/dc-mcp-gateway`; DC → `vendor/desktop-commander`; extract relay plane (`src/control-plane`) → `apps/dc-relay`. | Old repos read-only mirrors |
| 4 | Root E2E: MCP path, relay path, gateway restart mid-session, DC rebuild while attested. | All green in CI |
| 5 | Phase 2 (deferred): Mission Router, Looptrace, Visualizer; Turbo only if build time demands it. | — |

### Step 0.5 evidence

| Item | Action | Evidence |
|---|---|---|
| `CONSENT_PASSPHRASE.txt` | Removed. Stale Sep-18 copy; value ≠ live `.env` passphrase; gitignored, never committed, absent from snapshot and release, so no rotation needed. | file absent; live `.env` key present. Follow-up: `README.md` and `test-e2e.sh` still reference the file. |
| Relay device `4258ed2b` | Revoked via `ControlPlaneService.revokeDevice()` (release `6b0fa00` code, `revoke_mcp_device_server` RPC) — no direct table writes | `revoked_at 2026-09-25T12:04:12Z`; relay `get_device` → `state: revoked` |
| Relay control plane under systemd | New unit `dc-relay-plane.service`, `WorkingDirectory=~/releases/dc-relay-plane/6b0fa00`, `ExecStartPre` verifies the content manifest (627 files, digest `414942ae…`), `Restart=always`; herdr process (pid 27968, dev checkout) stopped | 8/8 control-plane test files pass in the release; `:3100` served from release dir; local + Funnel well-known 200; relay `get_runtime_identity` → runtime `3587cc5f` through the new unit |

Note: releases were built by a shell with Node v24.18.0 on PATH; units run linuxbrew Node 26.5.0. The release build must pin the runtime Node (record it in `RELEASE.json` and use that binary in the unit).

### Step 1 progress — `integration/own-relay`

Worktree `~/projects/.worktrees/dc-integration-own-relay`, branch `integration/own-relay` (local, not pushed):

| Commit | Content |
|---|---|
| `30e572f` | trunk: `fix/remote-device-managed-attach` |
| `9d64ac1` | merge relay-device (`053cc49`). Conflicts in `desktop-commander-integration.ts` (kept trunk `managedAttachFlight` single-flight **and** relay SSE-resilience + rate-limit), `remote-channel.ts` (relay side = trunk + own-relay routing/claim path), test union. `device.ts` recovery loop merged cleanly. |
| `c90c30c` | merge relay-plane (`6b0fa00`). `package.json` script union, trunk dependency versions, `supabase` devDependency added; lockfile regenerated, not hand-merged. |
| `92be6cf` | test: isolate executor lease/config state — full suite 92/92; independently verified against trunk 30e572f. Step 1 exit met. |

Gates at `c90c30c`: `npm ci` + `npm run build` clean; 20/20 targeted test files pass (8 control-plane, 12 remote-device/managed-ACS). Full `run-all-tests`: 89/92 — the 3 failures (`test-conditional-tools.js`, `test-local-runtime.js`, `test_enhanced_read.js`) fail identically on unmerged trunk `30e572f` (pre-existing). Corrected diagnosis: `run-all-tests` runs each test with `cwd=test/`, so path resolution is fine inside the suite (the earlier "one directory too high" finding came from running tests from the repo root). The real cause for `test-conditional-tools.js` and `test-local-runtime.js`: they spawn a real DC executor, which correctly refuses to start because the live production bridge child holds the canonical executor lease at `~/.desktop-commander/executor.lock` — the tests are not isolated from host state. Fix: isolate each test's `HOME` (and, for the direct-spawn test, `DESKTOP_COMMANDER_EXECUTOR_LOCK_DIR`) to a temp dir so the lease still runs; do **not** use `DC_DISABLE_EXECUTOR_LEASE`, and do **not** add the lock-dir variable to `local-runtime.ts`'s forwarding allowlist (that would let callers escape the executor singleton). `test_enhanced_read.js` passes when run alone from `test/`; its suite failure is still being diagnosed (flake vs. order dependence). Remaining for step-1 exit: fix those 3 (quarantine only after independent diagnosis shows the test itself is invalid) so the suite is green. No releases are built from `c90c30c`; the DC cutover is Step 2c, from the final Step-1 commit.

### Step 2a design clarification — 2026-09-25

The capture-time Step 2a row above proposed using the full release manifest as
the runtime fingerprint. The approved implementation instead hashes `dist/**`,
`package.json`, `package-lock.json`, and the pinned Node version into the ACS
runtime identity. Startup separately verifies the full release-file manifest,
the installed-dependency digest, and the pinned Node binary. The immutable DC
and gateway releases have been built and verified, but no live runtime has been
rotated; live cutover remains Step 2c and requires fresh approval.

## Consequences

- Deploys become explicit (build release → repoint unit → restart), trading convenience for reproducibility.
- A DC rebuild requires a deliberate ACS runtime re-registration instead of silently breaking attestation.
- Snapshot refs are local only until pushed; pushing is a separate decision.

## Open items at capture

- Credential rotation: `acs-dc-bridge` rotated and verified 06:50; `acs-visualizer-read`, `strands-harness` rotated by operator. Lesson: a credential needs a consumer inventory before rotation — `acs-dc-bridge` had three consumers, one undocumented (`:8010` uses it as `ACS_GATEWAY_TOKEN`).
- Unattributed authority change: runtime `dd31bf90` revoked and `3587cc5f` registered at 06:43 by an actor outside the tracked session. The rotation is valid, but invariant 5 needs an operator audit trail for registry changes.
- Release builds not yet cutover-ready: `dc-mcp-gateway/7e17d50` 44/45 (`harness-dispatch.test.mjs` timeout); `acs/7b60e09` has the `coding-harness` TS error and a `capability-contract.test.ts` failure ("approval … missing its action hash binding") from uncommitted `execution-authorization.ts`. DC releases pass.
- `acs-gateway` shutdown drain exceeds 10 s and exits 1 (`failed` state on every stop).
- `get_runtime_identity` reports `device_id 13550666…` (the stale upstream `~/.desktop-commander-device/device.json`), not relay device `2a8768d3`.
- Device startup failure is handled by systemd restarts (17 during the 06:53 outage); the new recovery loop only covers loss *after* startup.
- `packages/coding-harness` (untracked) breaks `tsc -b` on `main`.
- OpenClaw gateway at ~6 GiB RSS with `--max-old-space-size=8192`.
- Concurrent writers: `desktop-commander` committed 04:07 and ACS `server.ts` edited 04:26 by another session while the baseline was being captured.
