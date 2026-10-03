# Control-plane migration lineage

The canonical registered sequence after version 36 is:

| Version | Purpose                                                     |
| ------- | ----------------------------------------------------------- |
| 37      | JC reusable-work-item lookup index                          |
| 38      | Global execution-result idempotency-key uniqueness          |
| 39      | Durable admission-permit bindings                           |
| 40      | Persist admission capacity class (`execution` or `wait`)    |
| 41      | Immutable Change Set revisions, heads and audit anchors     |
| 42      | Durable worker assignments                                  |
| 43      | Migration-lineage reconciliation marker                     |
| 44      | Immutable Change Set approvals and audit-bound revocations  |
| 45      | Immutable operation permits bound to human bundle approval  |
| 46      | Mission-scoped authority grants and snapshot authorizations |
| 47      | Operation permits bound to approval or grant authorization  |

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

Pristine databases initialize all canonical migrations and their metadata in one
`BEGIN IMMEDIATE` transaction. Startup rechecks both metadata and schema objects
under the writer lock, so concurrent initializers cannot apply the snapshot
twice. A late failure rolls back the entire initialization; retry starts empty.
Existing schema objects or migration metadata select the upgrade path below.

Repair runs under `BEGIN IMMEDIATE`, rechecks after obtaining the write lock,
shifts the existing records to versions 38 and 39, and applies the missing JC
index at version 37 in the same transaction. It preserves admission rows and
historical application timestamps. A failed insertion rolls back the metadata
repair. Ordinary migrations then add versions 40–47. Each ordinary migration is
its own transaction: a later failure can leave earlier migrations committed,
and a subsequent startup checks checksums and resumes. Unknown, partial or
modified recovery layouts are rejected; operators must investigate rather than
edit checksums to force acceptance.

A database already using the deployed JC-index version 37 follows the normal
migration path without remapping. Duplicate non-null result idempotency keys
fail the uniqueness migration; this procedure does not delete or reconcile
execution history automatically.

Version 45 adds immutable operation permits mapping an approved Change Set operation
to an existing execution work item. It preserves the canonical attempt and lease
tables; no parallel lease store is introduced.

Version 46 adds immutable human-issued Autonomous Authority Grants, exact-snapshot
grant authorizations and append-only grant revocations. Version 47 rebuilds the
operation-permit table with an exclusive choice of human approval or grant
authorization. Existing version-45 permit JSON and hashes are copied unchanged;
legacy permits remain bound to their original human approval. New grant permits
use schema version 2 and bind the authorization identifier into their hash.
Neither migration grants authority to existing missions or executors.

## Databases written by release 464d54b (admission permits at 39)

The table above is the sequence before JC admin approvals took version 39. Release 464d54b recorded admission
permits at 39 through operation-permit grant authority at 47 (nine rows, `039_admission_permits.sql` first). Current
code registers JC admin approvals at 39 and those migrations at 40-48, then coding missions (49) and authoritative
routing (50). Startup recognises that exact deployed layout, or a contiguous prefix of it, checks each row against the
shipped SQL for its new number (the lineage marker's released checksum is pinned in the legacy block because only a
comment line changed), and renumbers the rows in one `BEGIN IMMEDIATE` transaction, preserving `applied_at`. The
ordinary loop then applies 39, 49 and 50. Any other layout still fails closed with `deployed migration layout ...`.
Take a consistent backup first; `scripts/deploy-gateway-release.sh` does and rehearses the upgrade on a copy.

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
