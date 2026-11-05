# ACS Desktop Harness: Stage 0 Reconciliation (2026-10-22)

Status: **read-only inventory. Nothing modified, committed, rebased or cleaned in any repo.** Baseline tests were NOT run in this pass (see "Not verified").

## 1. Inventory

| Repo / worktree | Branch | HEAD | State |
|---|---|---|---|
| `agent-control-stack` (primary) | chore/review-agent-session-files | 32ddcac1 | 0 tracked diffs, 15 untracked (`.harnesskit` logs) |
| `agent-control-stack-main` | main | 03f026b7 | canonical main; this roadmap worktree is based here |
| `acs-worktrees/mission-control-harness-20261021` | feat/mission-control-harness-20261021 | 32ddcac1 | **2 modified** (`apps/dc-mcp-gateway/bridge.js` +65, `tsconfig.json` +1), **16 untracked** (harness-contracts, scripts, ADR 0025-0028, 5 harness docs). Sole copy of the harness work. |
| `acs-worktrees/mission-control-2-integration` | feat/mission-control-2-integration | 318c27a0 | clean except untracked `imports/mission-control-2/` |
| `desktop-commander` (primary) | fix/remote-device-managed-attach | b668306 | 1 tracked diff, 3 untracked (not touched) |
| `agent-harness-desktop` ("Relay Desktop") | not a git repo | n/a | Electron 44.7.2, CJS main, 4 test files. **No version control: single copy.** |
| `Mission-control2.0` (original) | not a git repo | n/a | standalone TanStack Start app. **No version control.** |
| `claude-rea-investigation` | n/a | n/a | Claude Desktop/CLI REA notes |

Other: roughly 70 ACS worktrees exist (list via `git worktree list`). Relevant parallel lines: `mission-control-react-port-20261020`, `priceless-fermat-648d0c` (approval-replay-hardening), `jc-nonce-oauth-timeouts-20261012` (a JC nonce store, check for overlap before writing consume).

**Preservation risks (act before anything else):** the harness worktree's 16 untracked files and the two non-git reference apps have no backup. Recommend a local snapshot commit on a preservation branch (or tarball) with your approval. I have not done this.

## 2. Reconciliation matrix

| Requirement | Claude Desktop finding (REA) | Relay Desktop | ACS harness today | Verdict |
|---|---|---|---|---|
| Per-call tool approval | Approval gate location unknown (H3); Desktop config uses bypassPermissions (F-1) | Explicit user approval per `tools/call` (`src/mcp.cjs`, `policy.cjs`) | Approvals live in ACS; broker capability is `acs.jc.v1`/`acs.dc.v1` | Relay UI approval is local only. Must become an ACS approval inbox. **Do not copy Claude's bypass pattern.** |
| MCP hosting | In-app MCP host, spawn guard | stdio bridge, on demand, absolute exe, no shell | Broker + `mcp-socket-shim.ts` | Reuse Relay launch rules as a client-side minimum only; ACS broker is the authority. |
| Chat/streaming | n/a | OpenAI-compatible streaming adapter incl. ACS `/v1/chat/completions` | Gateway exposes it | Reusable (`src/chat.cjs`). |
| Credential custody | Not audited | safeStorage vault | **Sandbox script copies `~/.claude/.credentials.json` (S4)** | CONFLICT, blocker. |
| Sandbox | n/a | Electron renderer sandbox only (GUI launch still pending chrome-sandbox setup) | Docker default; bwrap `--ro-bind / /` (S3) | Docker path plausible; bwrap blocked; image unpinned (S6). |
| Execution authority | n/a | none (explicitly "not an authority") | Offline-verified capability + bridge-level lease re-read | **GAP: `POST /executions/consume` absent.** |
| Session persistence / recovery | persistence-and-recovery.md | conversation store (0600 files) | ACS work items, leases, crash-recovery test passes (Rev 3) | ACS authoritative; Relay store becomes cache only. |
| UI | n/a | Vanilla renderer, no framework | `apps/mission-control-web`; MC2.0 import untracked, brings Better Auth + PGlite + own backend | Reuse components only; reject MC2.0 auth/db/server. Relay renderer likely discarded in favour of MC web inside Electron shell. |
| Claude Code adapter | CLI runs `--dangerously-skip-permissions` in Desktop | none | ADR-0027 interception spike, sandbox script | Not started; gated. |

Caveat: the REA mandate was not met per its own finding 4 (Ghidra/IDA unconfigured), so Claude Desktop claims are mostly string-level evidence.

## 3. Slice A blocker list (ranked by security impact, then dependency)

Verified in source this pass: no `/executions/consume` route anywhere in `apps/` or `packages/`; sandbox script lines 46-48, 76-77, 117-118 still copy and mount the host credential file; bwrap `--ro-bind / /` at line 122; default image `node:22-bookworm-slim` at line 74; broker nonce store is `new Map()` (`capability.ts:264`); broker walks with `lstatSync` and opens `O_NOFOLLOW` only on the final component.

Evidence ledger Rev 3 (already in the worktree) records a partial mitigation I did not know of from the handoff: the managed bridge now re-reads `GET /work-items/:id` and checks lease id, status and epoch, with 36/36 isolated checks passing. This closes N4 for the bridge route only, not for direct callers and not durably.

| # | Blocker | Impact | Minimum change | Depends on |
|---|---|---|---|---|
| B1 | S4 host credential copy into sandbox | Critical: reusable secret readable by model process | Delete copy/mount; supply model access via the existing `model-proxy.ts` with a scoped, short-lived token, or fail closed | none |
| B2 | S3 bwrap runtime exposes host root and unix sockets | Critical: invariant-2 bypass | Remove bwrap branch (smallest change) | none |
| B3 | `POST /executions/consume` missing (ADR-0028, N4/S5) | Critical: executors accept offline-valid capability after cancel/restart | Gateway route + one durable table in ACS DB, single transaction (lease active, epoch, attempt non-terminal, not cancel-requested, runtimeId, nonce unconsumed); managed JC/DC call it before every mutation; fail closed. Check `jc-nonce-oauth-timeouts` and `priceless-fermat` worktrees first to avoid a duplicate nonce system. | needs executor-auth scheme decision |
| B4 | Broker parent-directory TOCTOU | High | Open the root as a directory fd and use `openat`-style resolution, or re-verify via `fstat`/realpath of the opened fd; add swap-race test | none |
| B5 | `verifyAndReserve` lacks required lease context (S7) | Medium | Make `leaseId/leaseEpoch/attemptId` required | B3 |
| B6 | Docker image unpinned (S6), mount review | Medium | Pin by digest; document each mount | B1, B2 |
| B7 | Docker broker proof (27/27) predates broker fix and has not been re-run; fixture isolation unreviewed | Evidence gap | Review fixtures in `/var/tmp`, then re-run | B1, B2, B4 |
| B8 | Live chain must use worktree-built executors | Evidence gap | Point `harness-slice-a-live-chain.mjs` at worktree JC/DC | B3 |
| B9 | S8 `tool-guard` deny-list is not a boundary | Low | Document; do not rely on it | none |

Suggested order: B1 and B2 (independent, small) then B3 (largest) with B5, then B4, B6, then B7 and B8 as the proof run.

## 4. Not verified in this pass

- No baseline tests, builds or Docker runs were executed. Rev 3's 36/36 and the broker-containment "4 passed" are from the evidence file, not from me.
- Did not read `bridge.js` diff, `broker.ts` fully, or the gateway DB schema for existing nonce/admission tables.
- Did not confirm whether other worktrees already implement part of consume.

## 5. Decisions needed from you

1. Approve a preservation snapshot of the harness worktree's untracked files and the two non-git apps.
2. Remove bwrap entirely (recommended) versus attempt a verified allowlist.
3. Executor-to-ACS auth scheme for consume (affects B3).
