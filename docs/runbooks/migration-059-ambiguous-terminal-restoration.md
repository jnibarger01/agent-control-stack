# Migration 059: historical terminal-restoration hold

**Status:** Draft fail-closed mitigation for the post-merge #291 P1 finding. This is not permission to repair production data.

## Why the gate exists

Migration 057 quarantined previously terminal verified units and wrote `failed/verification_failure`.
Migration 059 originally restored any matching unit when the quarantine recorded an original
`succeeded` or `cancelled` state. It did not record the original unit attempt counter.
A live mission can retry after 057, genuinely fail verification again, and return to that same
failure tuple. 059 then mistakenly restores the later failure as old success.

The runner holds one SQLite `BEGIN IMMEDIATE` transaction and writer lock across
migrations 057, 058, and 059, including the 059 restoration. A competing SQLite
writer cannot retry an operation between quarantine and restoration. A new 057→059
upgrade can therefore repair its own quarantined terminal units safely.
If 057 was applied in an **earlier migration invocation**, the runner instead
refuses ambiguous restoration: the original unit attempt identity was not
recorded, so a subsequent failure cannot be distinguished from the 057 tuple.
This conservatively blocks some legitimate restorations. Neither 057 nor 059
SQL files or deployed migration checksums are modified.

## Operator response if the guard stops a migration

1. **Preserve a consistent SQLite backup and audit evidence.** Do not retry with altered
   migration checksums or manually mark 059 applied.
2. On an offline copy, inspect the quarantine row, original status, work unit attempt
   counter, `work_unit_execution_attempts`, `work_unit_verification_decisions`,
   `coding_events`, and the mission's terminal/lifecycle state. Correlate post-057
   retries, claims, and verification results.
3. Record a unit-by-unit disposition. A genuine newer failure must **never** be
   silently restored to success; ambiguous external effects remain unverified.
4. Prepare an independently reviewed, forward-only reconciliation for the specific
   observed schema/data. Require separate operator approval to run any data repair.

## If migration 059 already ran

This guard cannot retroactively prevent a restoration already applied by an earlier release.
The `verification.migration_057_terminal_restored` events may identify candidates, but do not
alone prove a unit's true final state. Audit those records on a read-only backup and reconcile
only from durable later-attempt and verification evidence. Treat the production state as
**unverified** until that audit is complete. Do not infer that green CI certifies existing
production SQLite data.

## Limitations

- This protects the repository's `applyControlPlaneMigrations` entrypoint, not alternative
  SQLite migration runners that directly execute migration files.
- It does not make a previous 059 repair trustworthy and does not automatically amend units.
- The runner holds a writer lock across 057–059. Other processes cannot commit
  concurrent retries in that window, but deployment should still quiesce
  independent dispatchers for consistent operational recovery.
- Keep this PR in draft until migrations have been tested on clean, historical and
  idempotent upgrade paths, and an independent database-integrity reviewer signs off.
