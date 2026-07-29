# Architecture Invariants

This document exists for one reason: some properties of this codebase are load-bearing in a way that is easy to accidentally break during an ordinary-looking refactor. A rename, an "obvious" simplification, or a new caller that skips a step can silently remove a guarantee nothing else in the system re-checks.

Each entry below states the invariant, cites where it is currently enforced, and says what specifically must never regress. This is not a design proposal — everything here describes behavior that already exists in `main`. If a change needs one of these properties to be different, that is a deliberate, separately reviewed decision, not a side effect.

See also [`docs/security-contracts.md`](security-contracts.md) for the broader request/policy/approval/audit contract, and [`docs/threat-model.md`](threat-model.md) for the assumptions these invariants protect against.

## 1. Fencing epoch compare-and-swap

**What it is:** every execution attempt has a `current_fencing_epoch`. Leasing an attempt increments the epoch and writes it in the _same_ `UPDATE ... WHERE status = ? AND current_fencing_epoch = ?` statement that claims the attempt — a single atomic compare-and-swap, not a read-then-write.

**Where:** `packages/work-items/src/store.ts` — the CAS lease claim is around `store.ts:1232-1256`; the epoch is re-verified (not trusted) on every privileged read via `getCommandAuthority` at `store.ts:1528-1570`, which requires `leaseRow.fencing_epoch === input.fencingToken` **and** `attemptRow.current_fencing_epoch === input.fencingToken` before returning any authority.

**Why it matters:** a stale worker that lost a lease (crashed, was preempted, or simply took too long) is holding an old fencing token. If a later caller ever accepted a fencing token by comparing it to anything other than the attempt's _current_ epoch — or accepted it without re-reading the epoch at all — a stale worker could still mutate state after a newer worker has already taken over the same attempt. That is exactly the split-brain scenario fencing tokens exist to prevent.

**Must not change:** claiming/renewing a lease without an atomic CAS on `(status, current_fencing_epoch)`; any code path that authorizes a mutation using a caller-supplied fencing token without re-reading the current epoch from storage in the same check.

## 2. Audit chain write barrier

**What it is:** every audit event is hash-chained to the previous event (`previous_hash` / `event_hash`), and every state mutation happens inside the _same_ SQLite transaction as its audit event — not a mutation followed by a best-effort audit write.

**Where:** `packages/work-items/src/store.ts:3054-3074` (`appendAuditEvent`, hash-chained insert) and `store.ts:3170-3209` (`write()`), which wraps every mutating call in `BEGIN IMMEDIATE` / `COMMIT` and — critically — refuses to start _any_ write at all if `this.auditChainValid` is false (`store.ts:3171-3173`, `audit_chain_invalid`). Chain validity is checked once at store construction (`store.ts:785`) via `verifyAuditChain` (`packages/shared/src/audit-chain.ts`).

**Why it matters:** this is the property that makes the audit log trustworthy evidence rather than a best-effort log line. If a mutation could commit without its audit event (or vice versa), the audit trail could disagree with actual state, and a tampered or truncated chain would go undetected instead of blocking further writes.

**Must not change:** any mutation that can commit outside the same transaction as its audit-event insert; any code path that writes to `work_items`, `execution_attempts`, `attempt_leases`, `approval_records`, etc. without going through `write()`; relaxing the `auditChainValid` fail-closed check.

## 3. Approval hash binding

**What it is:** an approval is not a boolean flag on a work item. It is a row keyed on `(work_item_id, action_hash)`, carrying its own `request_hash`, that must independently match at consumption time, with status transitions (`granted` → `consumed`) enforced by an atomic `UPDATE ... WHERE status = 'granted'` CAS.

**Where:** `packages/work-items/src/store.ts:2383-2432` (`hasApproval` / `consumeApproval`). Consumption fails closed on a missing approval (`approval_missing`), a request-hash mismatch (`approval_request_mismatch`), a non-granted status (`approval_not_granted`), expiry (`approval_expired`), or a concurrent consumption race (`approval_conflict`).

**Why it matters:** if the requested action changes after a human approved it — even a single flag — the action hash changes and the old approval must not silently cover the new action. This is what makes "approved" mean "approved for this exact action," not "approved for this work item in general."

**Must not change:** consuming an approval by work-item ID alone; treating an approval as valid without re-checking `action_hash` (and, where supplied, `request_hash`) at the moment of consumption; allowing an approval to be consumed twice (removing the CAS on `status = 'granted'`).

## 4. Migration checksum enforcement

**What it is:** every applied migration's SQL is hashed (`sha256`), and the checksum is persisted alongside the migration record. On every startup, if a migration with that version was already applied _and already has a recorded checksum_, that checksum must match the current migration source's checksum, or startup fails.

**Where:** `packages/shared/src/migration.ts:37` (checksum computed from SQL text) and `migration.ts:70-95` (applied inside `BEGIN IMMEDIATE`, with the mismatch check at `migration.ts:77-78` throwing `migration checksum mismatch for version ${migration.version}`).

**Bootstrap exception (not a bug, but not enforcement either):** a database migrated before this checksum column existed reaches this code with `existing.checksum === ""`. `migration.ts:77` short-circuits the mismatch check for a blank checksum, and `migration.ts:80-85` then writes the _current_ source's checksum into that row as a one-time backfill — there is no historical value to compare it against. So on that database's first startup after upgrading to checksum-enforcing code, an already-edited migration file is silently adopted as the new trusted baseline rather than rejected. Enforcement is real and fail-closed only for a version that already has a non-blank recorded checksum; it does not retroactively protect versions applied before checksums were introduced.

**Why it matters:** this is what stops an already-applied migration file from being silently edited after the fact — once a version has a recorded checksum. Without it, two deployments that believe they are running "migration 007" could actually be running different SQL, with no signal that history was rewritten.

**Must not change:** editing an already-released migration file's SQL (add a new migration instead — this is also stated directly in `AGENTS.md`); removing or weakening the checksum comparison for a version that already has a recorded checksum; applying a migration without recording its checksum.

## 5. Sandbox egress chokepoint

**What it is:** a sandboxed process's _only_ path to the network is a single-purpose HTTP CONNECT proxy bound to an `AF_UNIX` socket, bind-mounted into a `--unshare-net` Bubblewrap sandbox. Because `--unshare-net` gives the sandbox its own empty network namespace, and `AF_UNIX` sockets are filesystem objects rather than network devices, the bind-mounted socket path is the _only_ route out — there is no separate network interface to bypass it through.

**Where:** `packages/sandbox/src/egress-proxy.ts:1-36` (proxy implementation and design rationale in the file's own docblock); `--unshare-net` is set on the Bubblewrap invocation at `packages/sandbox/src/linux.ts:296` and `packages/sandbox/src/engine.ts:340`.

**Why it matters:** this is the single enforcement point for "what can this sandboxed process talk to." An allowlist that lived anywhere else (an environment variable, a wrapper script, a library-level HTTP client config) would be trivially bypassable by anything running inside the sandbox that didn't go through that specific code path.

**Must not change:** giving a sandboxed process a real network namespace (removing `--unshare-net`) while still relying on an application-level allowlist for egress control; adding a second path out of the sandbox (a second bind-mounted socket, a shared network namespace, etc.) that isn't routed through the same chokepoint.

## Core architectural strengths — do not regress these while fixing something else

These are working as intended. A refactor that "simplifies" one of these by removing the extra check is very likely removing the reason the check exists:

- **Work-item lease protocol.** Fencing-epoch CAS (invariant 1) correctly prevents a stale worker from mutating state after losing its lease.
- **Audit chain.** The write barrier (invariant 2) prevents state and audit from silently disagreeing.
- **Approval model.** Exact action-hash binding (invariant 3) is fail-closed by default: missing, mismatched, expired, or already-consumed approvals all reject rather than falling back to an implicit allow.
- **Migration checksums.** Invariant 4 makes schema history tamper-evident instead of just documented-by-convention.
- **Sandbox egress.** Invariant 5 gives sandboxed network access exactly one enforcement point instead of scattering allowlist logic across callers.

## What this document is not

This is not a claim that every component in the repository is production-ready — see the README's "Known limitations" and "What this alpha does not do" sections for what is explicitly still dry-run, unwired, or unconsumed (`packages/verification`, `packages/secret-broker`, `packages/engine-adapter`, `packages/workspace-manager`, real worker command execution). A package being small, new, or not yet consumed by an app path is not the same as being over-engineered — some of the packages above exist specifically to keep a future integration point isolated behind a narrow, independently testable contract. Whether a given package should exist is a "does this boundary earn its keep" question, decided case by case; it isn't answered by this document.
