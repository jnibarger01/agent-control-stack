# SQLite backup / restore runbook (work-items store)

Alpha ops path for the control-plane SQLite database that holds work items,
leases, and audit events. Use this before treating a local or alpha deployment
as durable. Production encrypted backups and systemd restore drills remain in
[production.md](./production.md).

## Where the database lives

| Setting            | Default                                 | Notes                                      |
| ------------------ | --------------------------------------- | ------------------------------------------ |
| ACS_DB_PATH        | storage/local.db                        | Shared by gateway, worker, scheduler, CLI. |
| Production example | /var/lib/agent-control-stack/control.db | See production runbook.                    |

The file is ordinary SQLite. Live processes typically open it in WAL mode, so a
naive file copy of a running database can miss uncheckpointed commits. Prefer
the checked-in backup primitive which copies a consistent snapshot.

## Do not copy

Backups of ACS_DB_PATH are not a substitute for secret handling. Keep these
out of backup tarballs, tickets, chat, and git:

- dotenv files (.env and variants)
- gateway / worker / operator bearer tokens and ACS_GATEWAY_CREDENTIALS_JSON
- MCP bearer tokens and OAuth client secrets
- managed backup key files (ACS_BACKUP_KEY_FILE and private key material)
- tunnel credentials and cloudflared state
- provider API keys (OpenRouter, OpenAI, and similar)
- credentials*.json, token*.json, client_secret*.json

The SQLite file itself may contain work-item payloads and audit attributes.
Treat backup directories with the same access control as the live DB (mode
0600 on artifacts created by the helpers).

## Prerequisites

Install dependencies and build packages so shared database helpers resolve.
Requires Node matching repository engines (>=24.16.0).

## Fresh-clone practice (sample fixture)

These steps work without a live gateway.

1. Sample fixture (migrated schema + one SYSTEM actor; no secrets):

       mkdir -p storage/fixtures
       node scripts/sqlite-backup-restore.mjs create-fixture storage/fixtures/sample-work-items.db

2. Timestamped snapshot (updates `backups/latest.db` only after integrity_check):

       node scripts/sqlite-backup-restore.mjs snapshot storage/fixtures/sample-work-items.db --destination-dir storage/fixtures/backups
       readlink storage/fixtures/backups/latest.db

3. Integrity on the snapshot (includes audit-chain verify):

       BACKUP=$(readlink -f storage/fixtures/backups/latest.db)
       node scripts/sqlite-backup-restore.mjs verify "$BACKUP"

4. Restore dry-run (temp dir; never touches ACS_DB_PATH):

       node scripts/sqlite-backup-restore.mjs restore-dry-run "$BACKUP"

Optional keep output:

       node scripts/sqlite-backup-restore.mjs restore-dry-run "$BACKUP" --into storage/fixtures/restored-dry-run.db
       node scripts/sqlite-backup-restore.mjs verify storage/fixtures/restored-dry-run.db

Each command prints one JSON object. ok:true means integrity, foreignKeys,
migrations, and auditChain all passed.

## Backup (live or alpha DB)

1. Prefer a quiet window; backup does not require stopping writers, but avoid disk-full conditions.
2. Snapshot with a timestamped name using the sqlite-backup-restore snapshot subcommand
   against ACS_DB_PATH (default storage/local.db) into a secure destination directory.
3. Confirm the JSON `ok` / `health.ok` / `retainHealth.ok` fields are true and store the destination path.
4. The script only updates `SECURE_BACKUP_DIR/latest.db` (symlink to the new timestamped artifact)
   **after** the artifact passes `PRAGMA integrity_check` and `PRAGMA foreign_key_check` (via the
   shared database-health contract). If verification fails, the previous `latest.db` pointer is
   left untouched, the process exits non-zero, and a clear JSON error is printed — ops must not
   treat a failed snapshot as the current restore point.
5. Do not copy -wal / -shm sidecars into the backup set when using this API; the snapshot file is self-contained.

Example snapshot invocation:

       node scripts/sqlite-backup-restore.mjs snapshot STORAGE_OR_ACS_DB_PATH --destination-dir SECURE_BACKUP_DIR
       # On success: SECURE_BACKUP_DIR/latest.db -> <basename>-<stamp>.db
       readlink SECURE_BACKUP_DIR/latest.db

## Restore (destructive — stop writers first)

Stop every gateway, worker, and scheduler that opens ACS_DB_PATH. Lingering
journal/wal/shm sidecars or an active lock cause restore to fail closed.

Always dry-run first with the restore-dry-run subcommand against the backup file.
Real replace uses the existing db-ops restore entrypoint with both --replace and
--writers-stopped attestation flags, then verify the destination.

       node scripts/sqlite-backup-restore.mjs restore-dry-run PATH_TO_BACKUP_DB

db-ops restore creates a sibling pre-restore safety copy of the previous
destination when one existed. Keep both until post-restore checks pass.

## WAL checkpoint + VACUUM

Gateway and worker open the control-plane DB with `PRAGMA journal_mode = WAL`.
The `-wal` sidecar can grow under sustained writes even when the main `.db` file
looks small. Checkpoint merges WAL frames back into the main file; VACUUM
rebuilds the main file to reclaim free pages after large deletes.

### Cadence

| Operation      | When                                                                                                                                          | Writers                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| WAL checkpoint | When `-wal` is large relative to the main DB, before a quiet-window backup of raw files, or during scheduled maintenance                      | PASSIVE may run while live (best-effort). FULL/TRUNCATE: quiet window or stop writers |
| VACUUM         | After large deletions, schema-heavy migrations, or when the main file stays bloated after checkpoint — typically monthly/quarterly, not daily | **Stop every gateway, worker, and scheduler first**                                   |

Snapshot with the backup helper before VACUUM on any non-fixture database. Do
not rewrite audit hashes in place; if verify fails after maintenance, restore
the last verified backup.

### Warning: live gateway / worker

- **Do not run VACUUM while the gateway, worker, or scheduler are live.** VACUUM
  needs an exclusive lock; concurrent writers can fail the maintenance step or
  leave the process stuck. The script refuses VACUUM without `--writers-stopped`
  and fails closed if an exclusive lock cannot be taken.
- Prefer stopping writers before `wal-checkpoint --mode TRUNCATE` (or FULL /
  RESTART) when you need the `-wal` file to shrink to zero. `PASSIVE` is safer
  on a live DB but may report uncheckpointed frames (`busy != 0` or
  `checkpointed < log`).
- Never delete `-wal` / `-shm` sidecars by hand while processes hold the DB open.

### Practice on the sample fixture

These steps succeed without a live gateway and must leave the audit chain intact
(`health.ok` / `auditChain` pass).

1. Recreate the fixture (or reuse an existing sample DB):

       mkdir -p storage/fixtures
       node scripts/sqlite-backup-restore.mjs create-fixture storage/fixtures/sample-work-items.db

2. Optional: put the fixture in WAL mode and force a small WAL (offline only):

       node -e "const {DatabaseSync}=require('node:sqlite'); const p='storage/fixtures/sample-work-items.db'; const db=new DatabaseSync(p); db.exec('PRAGMA journal_mode=WAL'); db.exec(\"UPDATE actors SET display_name='fixture-operator-wal' WHERE id='fixture-operator'\"); db.close();"

3. Checkpoint (TRUNCATE shrinks `-wal` when no other connection is open):

       node scripts/sqlite-backup-restore.mjs wal-checkpoint storage/fixtures/sample-work-items.db --mode TRUNCATE

4. VACUUM with writers attested stopped (required flag):

       node scripts/sqlite-backup-restore.mjs vacuum storage/fixtures/sample-work-items.db --writers-stopped

5. Re-verify integrity + audit chain:

       node scripts/sqlite-backup-restore.mjs verify storage/fixtures/sample-work-items.db

Expect `ok:true` and `health.ok:true` from each JSON report. A failed verify
after maintenance means stop and restore from the last good snapshot — do not
hand-edit the chain.

### Live / alpha maintenance outline

1. Take a verified snapshot (see Backup above).
2. Stop gateway, worker, and scheduler processes that open ACS_DB_PATH.
3. `wal-checkpoint` with `--mode TRUNCATE`, then `vacuum ... --writers-stopped`.
4. `verify` the live path; only then restart writers.
5. Confirm `/readyz` (or offline verify) once the gateway is back.

## Integrity: /health + audit-chain verify

### Offline (no gateway)

Use db-ops verify or the sqlite-backup-restore verify subcommand against ACS_DB_PATH.
That runs SQLite integrity_check, foreign_key_check, migration checksum identity,
and full audit-chain hash verification (verifyAuditChain).

With a built CLI against the same DB, run apps/cli status --json and expect
health.ok and audit.ok both true.

### Online (gateway running)

GET /health is a compatibility alias for GET /readyz. Both return the store
readiness document (HTTP 200 when healthy, 503 when not). /livez is process
liveness only and does not prove audit-chain health.

Probe loopback readiness on the gateway port (default 3000) via /health and /readyz.

A ready response means SQLite read/write probes, migration checksums, audit
chain, and liveness reconciliation all passed. On audit-chain failure: stop
writers, preserve the DB and logs, restore the last verified backup, and
investigate. Do not rewrite hashes in place.

## Related

- [production.md](./production.md) — deploy backup, encrypted managed backups, restore drills
- [local-dev.md](./local-dev.md) — local gateway / worker with ACS_DB_PATH
- [audit-chain-export.md](./audit-chain-export.md) — JSONL export + offline verify
- scripts/db-ops.mjs — verify / backup / restore primitives
- scripts/db-backup-policy.mjs — encrypted retention + drill (production)
- scripts/sqlite-backup-restore.mjs — timestamped snapshot (latest.db after integrity_check) + restore dry-run + fixture + wal-checkpoint + vacuum
