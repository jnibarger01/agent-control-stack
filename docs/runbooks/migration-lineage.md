# Control-plane migration lineage

The canonical registered sequence after version 36 is:

| Version | Purpose                                                  |
| ------- | -------------------------------------------------------- |
| 37      | JC reusable-work-item lookup index                       |
| 38      | Global execution-result idempotency-key uniqueness       |
| 39      | Durable admission-permit bindings                        |
| 40      | Persist admission capacity class (`execution` or `wait`) |
| 41      | Immutable Change Set revisions, heads and audit anchors  |
| 42      | Durable worker assignments                               |
| 43      | Migration-lineage reconciliation marker                  |

The recovery branch previously registered result uniqueness at version 37 and
admission permits at version 38. The isolated worker-claim candidate also
recorded the same admission-permit SQL at version 39 under a reconciliation
name. These SQL files are byte-identical where their effects overlap. Startup
recognizes only these exact metadata/checksum layouts, validates canonical
predecessors and any later 40–42 rows, and verifies the schema objects before
repairing numbering. It maps the redundant isolated v39 history record to the
reserved v43 reconciliation marker, preserving its application timestamp and
all schema/data. The historical SQL files remain compatibility fixtures and
are not registered as duplicate schema migrations. Released SQL contents have
not been edited.

Repair runs under `BEGIN IMMEDIATE`, rechecks after obtaining the write lock,
shifts the existing records to versions 38 and 39, and applies the missing JC
index at version 37 in the same transaction. It preserves admission rows and
historical application timestamps. A failed insertion rolls back the metadata
repair. Ordinary migrations then add versions 40–43. Each ordinary migration is
its own transaction: a later failure can leave earlier migrations committed,
and a subsequent startup checks checksums and resumes. Unknown, partial or
modified recovery layouts are rejected; operators must investigate rather than
edit checksums to force acceptance.

A database already using the deployed JC-index version 37 follows the normal
migration path without remapping. Duplicate non-null result idempotency keys
fail the uniqueness migration; this procedure does not delete or reconcile
execution history automatically.

## Validation and rollout

```bash
npx vitest run packages/shared/src/migration.test.ts packages/work-items/src/state-machine.test.ts --maxWorkers=1
npm run check
```

These tests use temporary databases. A successful local migration test does not
prove production migration or runtime recovery. Production rollout requires an
explicitly authorized, manifest-verified release, a consistent database backup,
and read-back of migration metadata, retained work/results and active leases.
Do not apply migrations to the running control database during a read-only audit.
