# ACS Desktop Harness: Slice 1 Assessment (v1, 2026-10-22)

**Verdict: PARTIAL.** Recovery, reconciliation and the review are complete and source-verified. The baseline is green for the subsets that could be run safely. The Slice A security gate is **BLOCK** (details in section 6). The Docker broker proof and the live ACS to JC to DC chain were not re-run, so they are not claimed.

Supersedes `docs/desktop-harness-reconciliation-20261022.md` (the earlier lighter pass). No application code was edited. No reset, clean, rebase, prune, merge, push or deploy was run.

Evidence tags: **[V]** verified by me in source or by running it this session; **[L]** taken from an existing ledger or REA document, not re-verified; **[H]** hypothesis.

> **Correction added 2026-10-23 (Slice 2).** This report says `POST /executions/consume` is **absent** (sections 4, 6 and 8, and blocker F-1). That is not true of the harness worktree as it stands after this report was written. My grep output was truncated and I over-read it, and the worktree also changed afterwards: migration 053, `execution-consume.ts`, the `server.ts` route and executor-side enforcement are present as uncommitted work, with 180 focused tests and a 50-check isolated live chain passing. Treat F-1, S5 and the "build consume" items in sections 7 and 8 as superseded. Findings S3, S4, S6, R-1 and the bridge-gate notes F-4 to F-6 were not re-examined here, and the sandbox items may also have moved. See `docs/slice-2-execution-authority-evidence-20261023.md` in the harness worktree for the current state, including new findings (credential readable via `/proc`, unauthenticated allow response).

## 1. Repository inventory (all 7 paths exist)

| Path | Branch | HEAD | Tracked diffs | Untracked | Notes |
|---|---|---|---|---|---|
| `agent-control-stack` | chore/review-agent-session-files | 32ddcac1 | 0 | 15 | only `.harnesskit` session logs |
| `acs-worktrees/mission-control-harness-20261021` | feat/mission-control-harness-20261021 | 32ddcac1 | 2 (`apps/dc-mcp-gateway/bridge.js` +65, `tsconfig.json` +1) | 16 | **only copy of all harness work** |
| `acs-worktrees/mission-control-2-integration` | feat/mission-control-2-integration | 318c27a0 | 0 | 1 (`imports/`) | `apps/mission-control-web` is the existing ACS UI target |
| `Mission-control2.0` | not a git repo | n/a | n/a | n/a | standalone TanStack Start app; no VCS |
| `agent-harness-desktop` (Relay Desktop) | not a git repo | n/a | n/a | n/a | Electron 44.7.2; has `dist/` .deb + tarball; no VCS |
| `claude-rea-investigation` | n/a | n/a | n/a | n/a | 18 report files + `evidence/` |
| `rea-claude-desktop-analysis` | n/a | n/a | n/a | n/a | contains one file, `run1-heap1024-summary.json`; no analysis reports |

The harness worktree's 16 untracked entries [V]: `docs/adr/0025`..`0028`, `docs/mission-control-ui-reconciliation.md`, `docs/multi-agent-harness-{acs-contract,implementation,prd,slice-a-evidence,verified-contract}.md`, `packages/harness-contracts/`, `scripts/fixtures/`, `scripts/harness-claude-sandbox.sh`, `scripts/harness-slice-a-{broker-proof.sh,isolation-smoke.sh,live-chain.mjs}`. ADR-0028 status is "Proposed; implementation not started".

Preservation: nothing was moved or copied. **Three assets have no backup** (harness untracked files, Relay Desktop, Mission-control2.0). A snapshot needs your approval; I have not taken one.

Parallel work to check before building: about 70 ACS worktrees exist (`git worktree list`). Most relevant: `jc-nonce-oauth-timeouts-20261012` (JC nonce store), `priceless-fermat-648d0c` (`fix/approval-replay-hardening-20261021`), `mission-control-react-port-20261020`. I did not diff these.

## 2. Claude Desktop (REA) findings: observed vs hypothesis

Source: `claude-rea-investigation/` (Debian Claude Desktop 2.19675.1 ASAR, static analysis only).

| Topic | Status | Statement | Source |
|---|---|---|---|
| Main assistant UI and task orchestration | Observed [L] | Remote. Local code manages Cowork/Code sessions, MCP transports, extension state, files. | `harness-interaction-spec.md` |
| Sessions | Observed [L] | Session dir is computed only when both account id and org id are present. Metadata JSON, transcripts JSONL. | `persistence-and-recovery.md` |
| MCP routing | Observed [L] | In-app MCP host with initialize/list/call/error/elicitation paths; protocol up to 2025-11-25. | `mcp-integration-map.md`, `findings.md` #2 |
| Spawn guard | Observed [L] | Wraps child spawn for MCP; about self-exec of Electron, **not** an authorization control. | `permissions-and-security-audit.md` F-3 |
| Permissions | Observed config [L] | Live CLI run with `--dangerously-skip-permissions`; `skipDangerousModePermissionPrompt: true`; Desktop `bypassPermissions` for code dispatch. | F-1 |
| Approval gate location | **Unknown** | No approval string in `directMcpHost.js`; gate may be elsewhere. Do not claim a bypass. | F-4, H3 |
| Bypass flag enforcement | **Hypothesis** | Whether `--allow-dangerously-skip-permissions` is enforced at runtime. | F-2, H2 |
| Sandboxing | Not assessed | No sandbox evidence for Desktop. | n/a |
| Streaming, recovery cursors | Not evidenced | Task stream/approval protocol are remote; `harness-interaction-spec.md` says event names are **proposed contracts, not recovered APIs**. | spec header |
| Credential storage | Not assessed | `ant-did`, `buddy-tokens.json` deliberately not read. | F-5 |
| Tooling limit | Gap | Ghidra/IDA unconfigured; Hopper rejects asar and times out on the 250 MB ELF. REA mandate for substantive native analysis **not met**. | `findings.md` #4 |

Consequence: Claude Desktop contributes UX and entity-model guidance only. It contributes no verified security design, and its permission posture (bypass) is a pattern to avoid.

## 3. Relay Desktop review (unchanged; newest-file mtime identical before and after tests)

Baseline: `npm test` = **11/11 pass** [V]. Not run: `npm run smoke` (GUI; README says the Linux sandbox is not configured).

| Component | Location | Verdict |
|---|---|---|
| Sender-validated IPC | `src/main.cjs:26-28` (checks `event.sender` and `senderFrame` against the main window) | **Reuse** |
| Window hardening | `src/main.cjs:125,130` (`contextIsolation`, `nodeIntegration:false`, `sandbox:true`, deny window.open) | **Reuse** |
| Narrow preload bridge | `src/preload.cjs:3-19` (frozen API, 16 methods) | **Reuse pattern**; surface will change |
| Credential vault | `src/store.cjs:88-118` (`safeStorage`, refuses `basic_text` backend, 0600/0700 files at 15-33) | **Reuse** |
| Streaming chat adapter | `src/chat.cjs` (SSE + JSON fallback, error body not leaked) | **Reuse** against ACS `/v1/chat/completions` |
| MCP stdio client | `src/mcp.cjs:18-19` (`shell:false`, absolute exe), `:84` tools/call, 60 s timeout | **Reuse as client-side minimum only** |
| Tool approval | `src/main.cjs:63-70` native dialog, "Allow once" | **Replace.** It is a local decision and not ACS-bound or auditable. Becomes an ACS approval inbox. |
| Conversation store / thread state | `src/store.cjs` | **Demote to cache.** ACS work items own sessions. |
| Renderer | `renderer/app.js` (287 lines, vanilla) | **Do not extend.** Host `apps/mission-control-web` instead. |
| `callTool` direct path | `src/main.cjs:59-76` | **Remove.** Spawns MCP servers from the desktop, bypassing the ACS broker. This is the exact "unmanaged route" the roadmap forbids. |

## 4. ACS harness review (actual implementations)

| Subsystem | Implementation [V] | State |
|---|---|---|
| Capability issue | `apps/gateway/src/server.ts:3480` (JC issuance, lease-bound per call), contracts `acs.dc.v1` / `acs.jc.v1` at `:871-920`; tests `jc-/dc-capability-issue.test.ts` | Implemented in the gateway |
| Capability verify | `packages/harness-contracts/src/capability.ts:287` `verifyAndReserve`; lifetime ≤30 s; nonce replay at `:406-410` | Implemented; **nonces in `new Map()` (`:264`)** |
| Lease context | `capability.ts:231-232` `VerifyContext.leaseId?/leaseEpoch?`; compared only if supplied (`:365-366`) | Optional, should be required |
| Tool Broker | `packages/harness-contracts/src/broker.ts`: containment `:56`, `resolveNoSymlink :109`, write `:174-185`, read `:198-206` (`O_NOFOLLOW` on the final component only), hash-chained audit `:219-251`, denials audited `:328-429` | Source fixes for S1/S2 present; denial path audited |
| Bridge lease gate | `apps/dc-mcp-gateway/bridge.js` (uncommitted diff): `assertGovernedCallStillAuthorized` re-reads `GET /work-items/:id`, requires status approved/running, `leaseId` match, `status==="active"`, epoch equality | Partial N4 mitigation. See findings F-4 to F-6. |
| JC/DC executors | Offline signature, nonce, expiry, argument checks only [L] (`slice-a-evidence` Rev 3) | **No ACS consume** |
| `POST /executions/consume` | `grep -rn "executions/consume\|/consume" apps packages scripts` finds only `public-contracts.ts:634` (tunnel-sessions consume, unrelated) | **Absent** [V] |
| Cancellation / lease records | `server.ts:541-664` rehydrates and fences leases at startup; `packages/work-items` has `store.ts`, `attempt.ts`, `execution-plan.ts` | Lease and fencing machinery exists in ACS to build on |
| Outcome verification | `packages/verification/src/{independent-verification,file-readback,claude-verifier}.ts`; `server.ts:4388` rejects worker-submitted `blocked`/`lease_expired` | ACS-side independent verification exists. End-to-end coverage for harness path unproven. |
| Sandbox | `scripts/harness-claude-sandbox.sh`: docker default `:36`, `--network none :81`, `--read-only :82`, `--cap-drop ALL :86` | Good base, see S4/S6 |

## 5. Baseline test results (this session)

| Suite | Result | Notes |
|---|---|---|
| Relay Desktop `npm test` | **11 pass / 0 fail** | read-only; no file mtimes changed |
| `packages/harness-contracts` vitest (from worktree root) | **10 pass / 0 fail** (2 files) | `vitest run` inside the package dir finds no files (include globs are root-relative); not a defect |
| `jc-/dc-capability-issue.test.ts` + `packages/work-items` (with `ACS_GATEWAY_TOKEN` unset) | **383 pass, 1 skipped, 0 fail** (35 files) | emits `trace_outbox_enqueue_failed` warnings (test noise, not failures) |
| Harness worktree `git status` before vs after | **identical** | tests did not dirty tracked or untracked state |
| Docker broker proof (`harness-slice-a-broker-proof.sh`) | **NOT RUN** | ledger claims 27/27 but predates the broker fix; fixture isolation unreviewed |
| Live chain (`harness-slice-a-live-chain.mjs`) | **NOT RUN** | ledger Rev 3: 36/36 in isolated run [L] |
| Full-repo `tsc -b`, full test suite | NOT RUN | per memory, local env masks CI failures; needs empty-HOME reproduction |

Missing tests (none exist, per ADR-0028 and source): consume route (success, replay, wrong audience, changed args, cancel, stale epoch, expiry, revoked, concurrent duplicate, restart persistence, ACS outage); `verifyAndReserve` rejecting missing lease context; broker parent-directory swap race; credential-copy absence; bwrap removal; image-digest pin.

## 6. Findings (ranked)

| ID | Sev | Finding | Location |
|---|---|---|---|
| S4 | **Critical** | Host `~/.claude/.credentials.json` copied into the run config and mounted into the sandbox. Read-only does not prevent disclosure to the model process. | `harness-claude-sandbox.sh:46-48, 76-77, 117-118` |
| S3 | **Critical** | bwrap runtime binds host root and keeps host unix-socket paths reachable (invariant 2 bypass). Reached `HOST-UNIX-SOCKET-REACHED` per ledger [L]. | `harness-claude-sandbox.sh:120-134`, esp. `:122` |
| F-1 | **Critical** | `POST /executions/consume` does not exist; executors accept an offline-valid capability after cancel/restart outside the bridge. | grep result above; ADR-0028 |
| S5 | High | Replay protection is process-memory only. | `capability.ts:264, 406-412` |
| F-4 | High | Bridge gate checks lease `status === "active"` but **never checks lease expiry** (no `expiresAt` reference in `bridge.js`; ACS's own startup code does at `server.ts:574`). | `bridge.js` gate (diff +45..+50) |
| F-5 | High | Bridge gate is check-then-forward, not an atomic consume: two concurrent calls with one capability both pass the gate. Nonce dedupe then rests on the executor's in-memory map. | `bridge.js` gate |
| F-6 | Medium | Gate fires on every governed `tools/call`, ADR-0028 scopes consume to mutations. Also uses the worker token `ACS_WORKER_TOKEN`, so the executor authenticates as the worker, not as itself. Auth scheme is undecided. | `bridge.js` gate |
| B4 | High | Broker walks with `lstat` and opens `O_NOFOLLOW` on the final component only; a parent directory swapped between walk and open is unchecked. | `broker.ts:109-206` |
| S7 | Medium | Lease fields optional in `VerifyContext`. | `capability.ts:231-232, 365-366` |
| S6 | Medium | Floating image tag, no digest pin. | `harness-claude-sandbox.sh:74` |
| R-1 | High (desktop) | Relay `callTool` starts MCP servers directly from the desktop after a local dialog: unmanaged route, not ACS-bound. | `agent-harness-desktop/src/main.cjs:59-76` |
| S8 | Low | Tool-guard deny-list is not a boundary [L]. | `tool-guard.ts` (not read this session) |
| E-1 | Gap | Docker proof and live chain are not tied to current code. | n/a |

Conflict resolved during review: handoff said the lease gate was missing; the ledger (Rev 3) and `bridge.js` diff show a partial gate exists. Recheck (cycle 2) confirmed it, then found F-4 to F-6 as its limits. No further conflicts remained.

## 7. Reuse versus build

| Need | Decision | Basis |
|---|---|---|
| Policy, leases, fencing, work items, outcomes | **Reuse ACS** (`packages/work-items`, `execution-admission`, `verification`) | exists; do not build a second authority |
| Nonce consume | **Build** one ACS table + route; first check the two nonce/replay worktrees above | absent |
| Capability format and broker | **Reuse and harden** `packages/harness-contracts` | exists |
| Claude Code sandbox | **Reuse Docker path; delete bwrap and credential copy** | S3, S4 |
| Electron shell, IPC validation, vault, chat client | **Reuse from Relay** (copy under review; Relay stays untouched) | tested, small |
| Relay tool approval and direct MCP spawn | **Replace** with ACS approval inbox and broker-mediated calls | R-1 |
| Desktop UI | **Reuse `apps/mission-control-web`** inside the Electron shell; take MC2.0 components selectively | MC2.0 brings own auth/db/server (rejected) |
| Claude Code adapter | **Build, after Slice A gates pass** (ADR-0027) | not started |

## 8. Recommended files for Slice 2 (Slice A security closure)

All in `acs-worktrees/mission-control-harness-20261021`; do not touch primary checkouts.

1. `scripts/harness-claude-sandbox.sh`: delete credential copy and mount (S4); delete the bwrap branch (S3); pin image by digest (S6). Fail closed if scoped model access is unavailable.
2. `packages/harness-contracts/src/model-proxy.ts` (exists, 64 lines): confirm it can carry a scoped short-lived token so the sandbox needs no host credential.
3. ACS consume (F-1, S5): new route in `apps/gateway/src/server.ts` (work-item routes begin near `:1738`/`:2003`); transactional store method in `packages/work-items/src/store.ts` plus a migration and a new test file `packages/work-items/src/execution-consume.test.ts`; route test `apps/gateway/src/executions-consume.test.ts`. Reconcile first with the existing admission/lease tables.
4. `apps/dc-mcp-gateway/bridge.js`: replace the read-then-forward gate with a consume call; add lease expiry check; scope to mutating tools. Executors under `apps/dc-mcp-gateway` and the JC equivalent (worktree-built only).
5. `packages/harness-contracts/src/capability.ts`: make `leaseId/leaseEpoch/attemptId` required in `VerifyContext` (S7); update `index.test.ts`.
6. `packages/harness-contracts/src/broker.ts` and `broker-containment.test.ts`: fd-relative resolution plus a swap-race test (B4).
7. `scripts/harness-slice-a-live-chain.mjs` and `scripts/harness-slice-a-broker-proof.sh`: retarget to worktree-built executors; review `scripts/fixtures/` and `/var/tmp` cleanup; then re-run both and append Rev 4 to `docs/multi-agent-harness-slice-a-evidence.md`.
8. Update ADR-0028 status once the route exists; record auth scheme decision.

Order: items 1, 5 (independent, small) then 3, 4, then 6, then 7.

## 9. Open decisions (needed at Slice 2 start)

1. Approve a preservation snapshot of the harness worktree's untracked files, Relay Desktop and Mission-control2.0.
2. Confirm bwrap removal (recommended).
3. Executor-to-ACS auth for consume: dedicated per-executor identity (recommended) versus reusing the worker token.

**Next action: Slice 2. Not started.**
