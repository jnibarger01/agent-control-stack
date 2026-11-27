# Forward-compatible migrations (bridge release)

A release normally reports `/readyz` 503 (`migration_mismatch`) when the database records a migration it does not
ship. That made every schema change one-way: rolling back a release that added a migration meant restoring a
backup and losing the writes made since.

This release accepts a short, reviewed list of later migrations instead
(`forwardCompatibleMigrations()` in `packages/shared/src/migration.ts`):

- A database row for a migration this release does not ship is accepted only when its version, name, filename and
  SHA-256 checksum match a listed entry exactly, and its version is above every shipped migration.
- Anything else (an unknown version, a row filling a gap below the shipped maximum, a different checksum or name)
  is still `migration_mismatch`. A missing shipped migration is still `migration_missing`.
- The reviewed SQL ships in `storage/migrations/forward-compatible/`. This release never applies it. Its checksum is
  derived from that file, never pinned, and the migration scanners only read the top-level directory.
- Every listed migration must be additive: only `CREATE TABLE IF NOT EXISTS` for new tables, and indexes and
  triggers on those new tables. `forward-compatible-migrations.test.ts` enforces that on the SQL text.

## Current list

| Version | Name                           | Ships in                                 | Why it is safe for this release                                                                  |
| ------- | ------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 083     | `retry_fence_cleanup_evidence` | ACS Rust migration (retry fence) release | Two new append-only tables with foreign keys to rows this release never deletes; no other change |

## Rehearsal (2026-11-22, staging port 3100, production-data copy)

1. The migration-branch gateway applied 083 to a copy of the production database and served writes.
2. This bridge release, started on that database: `/readyz` 200 with `migrations: ok`; an authenticated sweep of
   every parameterless public GET operation returned the same statuses as the other releases; a work item was
   created and the audit chain stayed valid.
3. The migration-branch code reopened the same database: healthy, Rust audit shadow agreeing.

No backup was restored and no write was lost in either direction.

## Adding an entry

Add the SQL file under `storage/migrations/forward-compatible/` byte for byte as the later release ships it, add
the entry to `forwardCompatibleMigrationFiles`, and run the tests. The version must already be reserved
(`docs/migrations/reservations.md` once merged).
