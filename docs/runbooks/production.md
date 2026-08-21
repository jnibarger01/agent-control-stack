# Production Operations Runbook

## Supported production scope

This release supports a policy, approval, audit, and dry-run worker control
plane. A Bubblewrap/systemd containment backend is implemented and tested
separately, but the production worker does not invoke it yet. Do not enable
machine mutation until per-attempt workspace allocation, authoritative
attempt/lease wiring, and the separately reviewed sandbox release gate all
pass.

## Prerequisites

- Docker 29+ with Compose v2/v5 support.
- A TLS-terminating reverse proxy for any non-loopback exposure.
- A persistent volume with enough free space for SQLite WAL growth and backups.
- `ACS_GATEWAY_CREDENTIALS_JSON` containing credential-bound operator/service/worker identities and either a complete OAuth issuer/audience/JWKS configuration or trusted signed-tunnel configuration.
- `ACS_MCP_ALLOWED_ORIGINS` containing the explicit browser origins permitted to call MCP; non-browser clients without an `Origin` header remain supported.
- A versioned image tag and a recorded previous image tag.

## Build and verify

```sh
npm ci
npm run check
npm run test:sandbox-integration
npm audit --audit-level=high
docker build -t agent-control-stack:$GIT_SHA .
ACS_GATEWAY_CREDENTIALS_JSON='[{"id":"operator-1","token":"<32+ character secret>","actor":"operator","actorId":"operator-1","roles":["operator"],"scopes":["acs:read","acs:write","acs:approve"]}]' \
ACS_MCP_ALLOWED_ORIGINS=https://acs.example \
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

`/livez` proves that the process event loop is serving requests. `/readyz` additionally checks SQLite reads/writes, migration checksums, and the audit chain. Route traffic only when readiness is HTTP 200. Authenticated operators can scrape `/metrics` for request latency/status, rate-limit outcomes, audit lifecycle events, and SQLite readiness.

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

The gateway exposes a Prometheus-compatible `/metrics` endpoint, but it is intentionally local to this service. Alert on container health/readiness, restart count, nonzero exits, disk usage, rate-limit responses, lease/worker lifecycle counters, and error-level structured logs. A hosted metrics/alerting backend remains a deployment responsibility.
