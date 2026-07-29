# Architecture Invariants

This document exists for one reason: some properties of this codebase are load-bearing in a way that is easy to accidentally break during an ordinary-looking refactor. A rename, an "obvious" simplification, or a new caller that skips a step can silently remove a guarantee nothing else in the system re-checks.

Each entry below states the invariant, cites where it is currently enforced, and says what specifically must never regress. This is not a design proposal — everything here describes behavior that already exists in `main`. If a change needs one of these properties to be different, that is a deliberate, separately reviewed decision, not a side effect.

See also [`docs/security-contracts.md`](security-contracts.md) for the broader request/policy/approval/audit contract, and [`docs/threat-model.md`](threat-model.md) for the assumptions these invariants protect against.

## 1. Fencing epoch compare-and-swap

**What it is:** every execution attempt has a `current_fencing_epoch`. Leasing an attempt increments the epoch and writes it in the _same_ `UPDATE ... WHERE status = ? AND current_fencing_epoch = ?` statement that claims the attempt — a single atomic compare-and-swap, not a read-then-write.

**Where:** `packages/work-items/src/store.ts` — the CAS lease claim is around `store.ts:1232-1256`; the epoch is re-verified (not trusted) on every privileged read via `getCommandAuthority` at `store.ts:1528-1570`, which requires `leaseRow.fencing_epoch === input.fencingToken` **and** `attemptRow.current_fencing_epoch === input.fencingToken` before returning any authority.

**Not the live claim/result path today:** `createAttempt`/`leaseAttempt`/`getCommandAuthority` (the `execution_attempts`/`attempt_leases` tables this invariant describes) are consumed only by `packages/engine-adapter`'s command-broker, which — per the "not yet consumed by any app path" note at the bottom of this document — nothing in `apps/*` calls yet. The live claim/result flow (`claimNextApprovedWorkItem` / `submitWorkResult`, `store.ts:2499` / `store.ts:2578`) uses a separate, simpler mechanism: one active `lease_token_hash` stored directly on the `work_items` row, overwritten on every new claim, and compared against the submitted lease at result time (`store.ts:2637-2668`) alongside an expiry check. That achieves an analogous "a stale worker can't mutate after being superseded" property today, but via lease-token replacement, not a monotonic epoch counter — the fencing-epoch CAS is real, tested code waiting for its consumer, not what is currently gating the live HTTP result-submission route.

**Why it matters:** a stale worker that lost a lease (crashed, was preempted, or simply took too long) is holding an old fencing token. If a later caller ever accepted a fencing token by comparing it to anything other than the attempt's _current_ epoch — or accepted it without re-reading the epoch at all — a stale worker could still mutate state after a newer worker has already taken over the same attempt. That is exactly the split-brain scenario fencing tokens exist to prevent, once something actually calls this path.

**Must not change:** claiming/renewing a lease without an atomic CAS on `(status, current_fencing_epoch)`; any code path that authorizes a mutation using a caller-supplied fencing token without re-reading the current epoch from storage in the same check.

## 2. Audit chain write barrier

**What it is:** every audit event is hash-chained to the previous event (`previous_hash` / `event_hash`), and every state mutation happens inside the _same_ SQLite transaction as its audit event — not a mutation followed by a best-effort audit write.

**Where:** `packages/work-items/src/store.ts:3054-3074` (`appendAuditEvent`, hash-chained insert) and `store.ts:3170-3209` (`write()`), which wraps every mutating call in `BEGIN IMMEDIATE` / `COMMIT` and — critically — refuses to start _any_ write at all if `this.auditChainValid` is false (`store.ts:3171-3173`, `audit_chain_invalid`). Chain validity is checked once at store construction (`store.ts:785`) via `verifyAuditChain` (`packages/shared/src/audit-chain.ts`).

**Why it matters:** this is the property that makes the audit log trustworthy evidence rather than a best-effort log line. If a mutation could commit without its audit event (or vice versa), the audit trail could disagree with actual state.

**Detects tampering, not tail truncation:** `verifyAuditChain()` (`packages/shared/src/audit-chain.ts:33-69`) walks whatever rows `readAllEvents()` returns and checks each event's `previousHash`/`eventHash` against its neighbors — it has no externally anchored total event count or head hash to compare against. Editing or reordering an event _within_ the chain breaks that internal consistency and is caught, **provided its `event_hash` is left in place**. Deleting one or more events off the _end_ of the table does not get caught: the remaining rows are still a perfectly valid (shorter) chain, `auditChainValid` is set to `true` on the next store open, and further writes proceed normally. Detecting tail truncation would require an independently persisted or externally anchored head hash/count, which does not exist today.

**Backfill exception:** `backfillAuditChain()` (`store.ts:3218-3230`) runs on every store construction, _before_ `verifyAuditChain()` (`store.ts:784-785`). For any row whose `event_hash` is blank, it recomputes both `previous_hash` and `event_hash` from that row's _current_ content and writes them in — this is meant for legacy pre-hash-chaining rows. It cannot distinguish "legitimate legacy row" from "row someone edited and then blanked `event_hash` on." A tamperer who edits a row's content and clears its `event_hash` gets a freshly self-consistent hash derived from the tampered content on the next store open, and `verifyAuditChain()` never sees anything wrong. The "editing is caught" claim above holds only when the tamperer leaves `event_hash` non-blank (and therefore inconsistent with the new content) — not against a tamperer who also clears it.

**Must not change:** any mutation that can commit outside the same transaction as its audit-event insert; any code path that writes to `work_items`, `execution_attempts`, `attempt_leases`, `approval_records`, etc. without going through `write()`; relaxing the `auditChainValid` fail-closed check for the tampering it does detect. **Should change:** restricting `backfillAuditChain()` to run only against a database known to predate hash-chaining (e.g. gated on a schema/migration marker) rather than unconditionally on every open.

## 3. Approval hash binding

**What it is:** an approval is not a boolean flag on a work item. It is a row keyed on `(work_item_id, action_hash)`, carrying its own `request_hash`, that the one live caller re-checks at consumption time, with status transitions (`granted` → `consumed`) enforced by an atomic `UPDATE ... WHERE status = 'granted'` CAS.

**Where:** `packages/work-items/src/store.ts:2383-2432` (`hasApproval` / `consumeApproval`). Consumption fails closed on a missing approval (`approval_missing`), a non-granted status (`approval_not_granted`), expiry (`approval_expired`), or a concurrent consumption race (`approval_conflict`).

**`request_hash` is caller-supplied, not store-mandatory:** `consumeApproval`'s `requestHash` option defaults to `{}` (`store.ts:2393-2396`), and the comparison at `store.ts:2413-2415` is `parsed.requestHash && row.request_hash !== parsed.requestHash` — a caller that omits it entirely skips the check, and the public `WorkItemStore` interface makes that legal. The guarantee holds today only because the sole production caller, `packages/policy-gate/src/tools.ts:244`, always passes `requestHash: approvalRequestHash(...)`. A new caller that reuses `consumeApproval` without supplying it would silently lose this protection with no interface-level error.

**Why it matters:** if the requested action changes after a human approved it — even a single flag — the action hash changes and the old approval must not silently cover the new action. This is what makes "approved" mean "approved for this exact action," not "approved for this work item in general" — as long as the caller actually supplies the request hash to check.

**Must not change:** consuming an approval by work-item ID alone; the `policy-gate` call site dropping its `requestHash` argument; allowing an approval to be consumed twice (removing the CAS on `status = 'granted'`). **Should change:** making `requestHash` a required parameter of `consumeApproval` instead of relying on every future caller to remember it.

## 4. Migration checksum enforcement

**What it is:** every applied migration's SQL is hashed (`sha256`), and the checksum is persisted alongside the migration record. On every startup, if a migration with that version was already applied _and already has a recorded checksum_, that checksum must match the current migration source's checksum, or startup fails.

**Where:** `packages/shared/src/migration.ts:37` (checksum computed from SQL text) and `migration.ts:70-95` (applied inside `BEGIN IMMEDIATE`, with the mismatch check at `migration.ts:77-78` throwing `migration checksum mismatch for version ${migration.version}`).

**Bootstrap exception (not a bug, but not enforcement either):** a database migrated before this checksum column existed reaches this code with `existing.checksum === ""`. `migration.ts:77` short-circuits the mismatch check for a blank checksum, and `migration.ts:80-85` then writes the _current_ source's checksum into that row as a one-time backfill — there is no historical value to compare it against. So on that database's first startup after upgrading to checksum-enforcing code, an already-edited migration file is silently adopted as the new trusted baseline rather than rejected. Enforcement is real and fail-closed only for a version that already has a non-blank recorded checksum; it does not retroactively protect versions applied before checksums were introduced.

**Why it matters:** this is what stops an already-applied migration file from being silently edited after the fact — once a version has a recorded checksum. Without it, two deployments that believe they are running "migration 007" could actually be running different SQL, with no signal that history was rewritten.

**Must not change:** editing an already-released migration file's SQL (add a new migration instead — this is also stated directly in `AGENTS.md`); removing or weakening the checksum comparison for a version that already has a recorded checksum; applying a migration without recording its checksum.

## 5. Sandbox egress chokepoint

**What it is:** a sandboxed process's intended _only_ path to the network is a single-purpose HTTP CONNECT proxy bound to an `AF_UNIX` socket, bind-mounted into a `--unshare-net` Bubblewrap sandbox. Because `--unshare-net` gives the sandbox its own empty network namespace, and `AF_UNIX` sockets are filesystem objects rather than network devices, the bind-mounted socket path is meant to be the _only_ route out — there is no separate network interface to bypass it through.

**Where:** `packages/sandbox/src/egress-proxy.ts:1-36` (proxy implementation and design rationale in the file's own docblock); `--unshare-net` is set on the Bubblewrap invocation at `packages/sandbox/src/linux.ts:296` and `packages/sandbox/src/engine.ts:340`.

**Not currently the only bind-mounted path:** `buildEngineBubblewrapInvocation()` also does `--bind canonicalWorkspacePath /workspace` (`engine.ts:401-403`) — a read-write bind mount of the _entire_ allocated workspace directory, not just the egress socket. If that directory contains a pre-existing `AF_UNIX` socket (planted before the sandbox starts, or left by some other process with access to that path), the sandboxed process can connect to it directly by filesystem path, entirely outside the CONNECT-proxy chokepoint. `--unshare-net` blocks a _network_ namespace escape; it does nothing about a Unix-domain socket reachable through a bind-mounted directory. The chokepoint claim holds for network sockets, not for arbitrary pre-existing filesystem sockets under the workspace mount.

**Why it matters:** this is meant to be the single enforcement point for "what can this sandboxed process talk to." An allowlist that lived anywhere else (an environment variable, a wrapper script, a library-level HTTP client config) would be trivially bypassable by anything running inside the sandbox that didn't go through that specific code path — and so, today, is a stray socket under the workspace mount.

**Must not change:** giving a sandboxed process a real network namespace (removing `--unshare-net`) while still relying on an application-level allowlist for egress control; adding a second _network-reachable_ path out of the sandbox that isn't routed through the same chokepoint. **Should change:** either scanning/rejecting workspace allocations that contain pre-existing sockets, or scoping this invariant's "only path" claim explicitly to exclude the workspace bind mount until that gap is closed.

## Core architectural strengths — do not regress these while fixing something else

These are working as intended. A refactor that "simplifies" one of these by removing the extra check is very likely removing the reason the check exists:

- **Work-item lease protocol.** The live claim/result path's lease-token replacement (invariant 1) correctly prevents a stale worker from mutating state after losing its lease today; the fencing-epoch CAS is the equivalent, already-tested mechanism waiting for `packages/engine-adapter` to be wired in.
- **Audit chain.** The write barrier (invariant 2) prevents state and audit from silently disagreeing.
- **Approval model.** Exact action-hash binding (invariant 3) is fail-closed by default: missing, mismatched, expired, or already-consumed approvals all reject rather than falling back to an implicit allow.
- **Migration checksums.** Invariant 4 makes schema history tamper-evident instead of just documented-by-convention.
- **Sandbox egress.** Invariant 5 gives sandboxed network access exactly one enforcement point instead of scattering allowlist logic across callers.

## What this document is not

This is not a claim that every component in the repository is production-ready — see the README's "Known limitations" and "What this alpha does not do" sections for what is explicitly still dry-run, unwired, or unconsumed (`packages/verification`, `packages/secret-broker`, `packages/engine-adapter`, `packages/workspace-manager`, real worker command execution). A package being small, new, or not yet consumed by an app path is not the same as being over-engineered — some of the packages above exist specifically to keep a future integration point isolated behind a narrow, independently testable contract. Whether a given package should exist is a "does this boundary earn its keep" question, decided case by case; it isn't answered by this document.
