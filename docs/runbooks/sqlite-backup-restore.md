# SQLite backup / restore runbook (work-items store)

Alpha ops path for the control-plane SQLite database that holds work items,
leases, and audit events. Use this before treating a local or alpha deployment
as durable. Production encrypted backups and systemd restore drills remain in
[production.md](./production.md).

## Where the database lives

| Setting | Default | Notes |
| --- | --- | --- |
| ACS_DB_PATH | storage/local.db | Shared by gateway, worker, scheduler, CLI. |
| Production example | /var/lib/agent-control-stack/control.db | See production runbook. |

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

2. Timestamped snapshot:

       node scripts/sqlite-backup-restore.mjs snapshot storage/fixtures/sample-work-items.db --destination-dir storage/fixtures/backups

3. Integrity on the snapshot (includes audit-chain verify):

       BACKUP=$(ls -1t storage/fixtures/backups/sample-work-items-*.db | head -1)
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
3. Confirm the JSON health.ok field is true and store the destination path.
4. Do not copy -wal / -shm sidecars into the backup set when using this API; the snapshot file is self-contained.

Example snapshot invocation:

       node scripts/sqlite-backup-restore.mjs snapshot STORAGE_OR_ACS_DB_PATH --destination-dir SECURE_BACKUP_DIR

## Restore (destructive — stop writers first)

Stop every gateway, worker, and scheduler that opens ACS_DB_PATH. Lingering
journal/wal/shm sidecars or an active lock cause restore to fail closed.

Always dry-run first with the restore-dry-run subcommand against the backup file.
Real replace uses the existing db-ops restore entrypoint with both --replace and
--writers-stopped attestation flags, then verify the destination.

       node scripts/sqlite-backup-restore.mjs restore-dry-run PATH_TO_BACKUP_DB

db-ops restore creates a sibling pre-restore safety copy of the previous
destination when one existed. Keep both until post-restore checks pass.

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
- scripts/db-ops.mjs — verify / backup / restore primitives
- scripts/db-backup-policy.mjs — encrypted retention + drill (production)
- scripts/sqlite-backup-restore.mjs — timestamped snapshot + restore dry-run + fixture

