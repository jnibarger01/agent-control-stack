# Migration 059: historical terminal-restoration hold

**Status:** Draft fail-closed mitigation for the post-merge #291 P1 finding. This is not permission to repair production data.

## Why the gate exists

Migration 057 quarantined previously terminal verified units and wrote `failed/verification_failure`.
Migration 059 originally restored any matching unit when the quarantine recorded an original
`succeeded` or `cancelled` state. It did not record the original unit attempt counter.
A live mission can retry after 057, genuinely fail verification again, and return to that same
failure tuple. 059 then mistakenly restores the later failure as old success.

The guard in `applyControlPlaneMigrations` allows 057→058→059 in one controlled upgrade,
but refuses automatic 059 restoration of matching quarantined terminal units if 057 was applied
in an **earlier migration invocation**. This is conservative: it blocks some legitimate
restorations because the available row lacks the original attempt identity. It does **not**
edit the applied 057 or 059 SQL files or their checksums.

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
- In a single running upgrade, another process must not dispatch/claim units concurrently
  between migrations 057 and 059. Quiesce writers under the deployment runbook.
- Keep this PR in draft until migrations have been tested on clean, historical and
  idempotent upgrade paths, and an independent database-integrity reviewer signs off.
