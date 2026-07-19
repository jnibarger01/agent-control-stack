# Production Operations Runbook

## Supported production scope

This release supports a policy, approval, audit, and dry-run worker control plane. It does not execute real commands or claim OS sandbox isolation. Do not enable machine mutation until a separately reviewed sandbox release gate passes.

## Prerequisites

- Docker 29+ with Compose v2/v5 support.
- A TLS-terminating reverse proxy for any non-loopback exposure.
- A persistent volume with enough free space for SQLite WAL growth and backups.
- `ACS_GATEWAY_TOKEN` and either a complete OAuth issuer/audience/JWKS configuration or trusted signed-tunnel configuration.
- A versioned image tag and a recorded previous image tag.

## Build and verify

```sh
npm ci
npm run check
npm audit --audit-level=high
docker build -t agent-control-stack:$GIT_SHA .
ACS_GATEWAY_TOKEN=... \
ACS_OAUTH_ISSUER=... \
ACS_OAUTH_AUDIENCE=... \
ACS_OAUTH_JWKS_URI=... \
ACS_IMAGE_TAG=$GIT_SHA \
docker compose -f compose.production.yml config --quiet
```

Keep real secrets in the deployment secret store or process environment. Do not put them in Compose files or `.env` committed to Git.

## Deploy

1. Record the current image tag and repository SHA.
2. Stop writes and create a database backup:

   ```sh
   npm run db:ops -- backup /path/control.db /secure-backups/control-$GIT_SHA.db
   ```

3. Start the candidate:

   ```sh
   ACS_IMAGE_TAG=$GIT_SHA docker compose -f compose.production.yml up -d --build
   ```

4. Verify:

   ```sh
   curl -fsS http://127.0.0.1:3000/livez
   curl -fsS http://127.0.0.1:3000/readyz
   docker compose -f compose.production.yml ps
   docker compose -f compose.production.yml logs --tail=100 gateway
   ```

`/livez` proves that the process event loop is serving requests. `/readyz` additionally checks SQLite reads/writes, migration checksums, and the audit chain. Route traffic only when readiness is HTTP 200.

## Shutdown

```sh
docker compose -f compose.production.yml stop -t 15 gateway
```

Successful shutdown logs `gateway shutdown started` and `gateway shutdown complete`. A timeout or nonzero exit is an incident; verify database integrity before restart.

## Image rollback

1. Stop the candidate.
2. Set `ACS_IMAGE_TAG` to the previously recorded tag.
3. If the candidate only performed compatible reads/writes, start the prior image and check readiness.
4. If data or migrations are incompatible, restore the pre-deploy backup first using the database rollback procedure below.
5. Start the prior image, verify `/livez`, `/readyz`, logs, and an authenticated read request.

## Database restore

Stop every gateway and worker using the database before restore.

```sh
npm run db:ops -- verify /secure-backups/control-$OLD_SHA.db
npm run db:ops -- restore /secure-backups/control-$OLD_SHA.db /path/control.db --replace --writers-stopped
npm run db:ops -- verify /path/control.db
```

Restore requires both literal `--replace` and `--writers-stopped` flags. The latter is an operator attestation: stop every gateway and worker first. The command also fails closed if an active writer lock or a lingering `-journal`/`-wal`/`-shm` sidecar makes that state ambiguous. It verifies a unique sibling temporary copy, flushes it, atomically replaces the destination, and creates a timestamped `control.db.pre-restore-*` safety backup. Keep both until post-rollback checks pass.

## Incident recovery

- **Readiness 503:** inspect the public check code. Do not route traffic or attempt writes until the DB write, migration checksum, and audit-chain checks pass.
- **Audit-chain failure:** stop writers, preserve the DB and logs, restore the last verified backup, and investigate before reopening. Do not rewrite hashes in place.
- **Expired worker lease:** run one worker; startup marks expired running leases failed. Review the terminal audit event before deliberately recreating work.
- **Database locked:** identify the competing writer, stop it cleanly, then retry readiness. Do not delete WAL/SHM files from a live database.
- **Disk full:** stop writes, free space without deleting authoritative DB/WAL files, back up, then recheck readiness and integrity.
- **Migration checksum mismatch:** stop. Historical migration files or recorded metadata changed. Restore the trusted artifact/DB pair; do not update the checksum to make readiness green.

## Observability and retention

Gateway request logs are structured JSON on stdout and include Fastify request IDs. MCP authenticated requests also persist `connector.requested` audit events with actor, auth method, request ID, and tool. Work-item lifecycle events live in SQLite. Configure container log rotation and database backup retention in the deployment platform; this repository does not silently delete audit history.

There is no metrics exporter in this release. Alert on container health/readiness, restart count, nonzero exits, disk usage, and error-level structured logs. This is a documented limitation, not a substitute for metrics in a multi-instance or SLO-bound deployment.
