# Migration upgrade and rollback compatibility

The migration test matrix treats every entry returned by `controlPlaneMigrations()` as a released schema fixture. For each prior version, it creates the schema and `schema_migrations` history exactly as that release would have, inserts representative audit and work-item data, applies the remaining migrations, and compares the result with a fresh install.

The matrix verifies:

- canonical `sqlite_master` schema identity;
- preservation of representative valid data;
- complete, ordered migration history; and
- rejection of a changed migration checksum without schema mutation.

## Rollback boundary

Migrations are forward-only. There is no automatic down-migration and no supported in-place downgrade of a database after a newer migration has been applied. A rollback means stopping writers, restoring a verified backup created by the target release, and starting that release against the restored database.

An older binary may only be used with a database whose migration history ends at a version that binary knows. A database containing newer migration rows is not a valid rollback target, even when newer migrations are additive, because readiness intentionally rejects unknown or extra history. Restore the backup made before the upgrade instead.

Every upgrade must therefore pass the matrix, readiness/integrity checks, backup/restore verification, and representative lifecycle checks before promotion. Tampered SQL or migration metadata is a hard failure; operators must restore a trusted backup rather than editing `schema_migrations`.
