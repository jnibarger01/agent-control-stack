# Migration version reservations

`storage/migrations` versions are global. A database records each applied migration's version, name, filename and
checksum. A release that ships a different migration under a recorded version fails with
`migration metadata mismatch` and the gateway reports `/readyz` 503. Unmerged lineages therefore reserve their
versions here before they reach a shared database.

The machine-readable table is `RESERVED_MIGRATION_VERSIONS` in `packages/shared/src/migration.ts`. Tests in
`packages/shared/src/migration.test.ts` fail when a registered migration takes a reserved version under another
name, or when a reserved version's SQL file ships without being registered.

## Current reservations (inventory of 2026-11-22)

Shipped on `origin/main` and on the production database: 001–074, 076–078. No branch on `origin` carries 079 or later.

| Version | Name                              | Lineage                                                                 | Status of the claim                               |
| ------- | --------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------- |
| 075     | (held, name set by the lineage)   | ARES / JC context-pack integration                                      | Gap held since before 076                         |
| 079     | `device_auth_refresh_recovery`    | JCA2 device auth: 16 local branches, identical blob `c424b143ef`        | Unchanged                                         |
| 080     | `device_auth_dpop`                | JCA2 device auth: same 16 branches, identical blob `a79b204cba`         | Unchanged                                         |
| 081     | `black_box_durable`               | JC kernel witness: 3 local branches, previously numbered 079            | Renumber 079 → 081 on those branches before merge |
| 082     | `black_box_transactional_worm_v2` | JC kernel witness: 2 local branches, previously numbered 080            | Renumber 080 → 082 on those branches before merge |
| 083     | `retry_fence_cleanup_evidence`    | ACS Rust migration: untracked in two worktrees, previously numbered 079 | Renumber 079 → 083 before commit                  |

Ordering rationale: JCA2 keeps 079/080 because it has the most branches and its files are already identical across
all of them. The other two lineages move up in the order they were first written. No shipped migration (001–078)
changes, and none of 079–083 has been applied to the production database (`schema_migrations` max is 78).

Renumbering is safe only for a version that no long-lived database has recorded. A development database that
applied an old number must be recreated or restored from a pre-migration backup. Do not edit its
`schema_migrations` rows.

## Procedure

1. Add the reservation to `RESERVED_MIGRATION_VERSIONS` and to the table above in one change on `main`.
2. Name the SQL file `<version>_<name>.sql` exactly as reserved.
3. When the migration lands, add it to `migrationFiles` and delete its reservation entry in the same change.
