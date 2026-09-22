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
- Optional `ACS_MCP_TOOL_ALLOWLIST_JSON` mapping each MCP identity to allowed tool names. When set, unknown identities are default-denied in production.
- `ACS_MAX_PENDING_WORK_ITEMS` set to an operationally safe queue ceiling.
- Rate-limit / auth / JSON body-limit defaults and local-vs-deployed knobs: [gateway-abuse-controls.md](./gateway-abuse-controls.md).
- `ACS_MAX_SSE_CLIENTS` set to the number of dashboard/event subscribers the host can hold concurrently; each stream pins a socket for its lifetime.
- `ACS_MAX_SSE_CLIENTS_PER_PRINCIPAL` set below `ACS_MAX_SSE_CLIENTS`, so one credential cannot consume every slot and lock other operators out of the live audit channel during an incident. The gateway clamps it to one below the global cap if the two are set inconsistently, and logs a warning when it does.
- A versioned image tag and a recorded previous image tag.

## Production boot config checklist

When `NODE_ENV=production` (or `ACS_STRICT_CONFIG=1`), the gateway validates
required configuration **before** it listens. On failure it prints one JSON
object to stderr (`error: "production_config_invalid"` with an `issues` array of
`{ key, message }`) and exits non-zero. Local/dev boots remain permissive unless
`ACS_STRICT_CONFIG=1` is set deliberately.

Confirm before deploy:

| Key                                               | Requirement                                                                                                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACS_GATEWAY_CREDENTIALS_JSON`                    | Non-empty JSON array; each credential needs `id`, `token` (≥32 chars), `actor`, `actorId`                                                                                                         |
| `ACS_DB_PATH`                                     | Parent directory must exist or be creatable on a writable ancestor                                                                                                                                |
| `HOST` (non-loopback)                             | Also requires `ACS_MCP_ALLOWED_ORIGINS` and either complete OAuth (`ACS_OAUTH_ISSUER` + `ACS_OAUTH_AUDIENCE` + `ACS_OAUTH_JWKS_URI`) or `ACS_AUTH_MODE=tunnel_id` with `ACS_TRUSTED_TUNNEL_PROXY` |
| `ACS_OAUTH_*`                                     | If any OAuth key is set, all three must be set                                                                                                                                                    |
| `ACS_ENABLE_TEST_AGENT_RUN_FOR_LOCAL_DEVELOPMENT` | Must not be `1`                                                                                                                                                                                   |

`compose.production.yml` already injects the credential, origin, and OAuth
variables; prefer that file (or the same env contract) over ad-hoc process env.

## Optional sandbox readiness probe (`/readyz`)

`/readyz` always checks the SQLite control plane. An **optional** sandbox
prerequisite probe can also verify Bubblewrap, `systemd-run`/`systemctl`, and
cgroup v2 on the gateway host.

| Setting                      | Behavior                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unset / not `1` (default)    | Probe off. Suitable for **dry-run alpha** and hosts that do not run live sandbox backends. Missing `bwrap` does not fail readiness.                                                                                                                                                                                                                      |
| `ACS_READYZ_SANDBOX_PROBE=1` | Probe on. Enable on **real-execution hosts** that will claim Bubblewrap/systemd work so misconfigured hosts fail `/readyz` (HTTP 503) with a stable `checks.sandbox.code` (`sandbox_backend_missing`, `sandbox_cgroup_launcher_missing`, `sandbox_cgroup_unavailable`, or `sandbox_host_unsupported`) before traffic is routed. `/livez` stays HTTP 200. |

This flag only adds readiness visibility. It does **not** enable live sandbox
execution or change the worker dry-run boundary.

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

GitHub Actions `check` hard-fails a loopback compose smoke after the production
image build: `./scripts/ci-compose-production-smoke.sh` (`compose.production.yml
up -d`, `./scripts/gateway-post-deploy-healthcheck.sh`, teardown). See the
gateway host map in [README Deploy](../../README.md#deploy). That job does not
deploy to Vercel or change `ignoreCommand`.

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
   ./scripts/gateway-post-deploy-healthcheck.sh http://127.0.0.1:3000
   docker compose -f compose.production.yml ps
   docker compose -f compose.production.yml logs --tail=100 gateway
   ```

   The healthcheck script probes `/livez` then `/readyz` (same contract as the
   curls below). Prefer it so operators share one post-deploy check. Manual
   equivalent:

   ```sh
   curl -fsS http://127.0.0.1:3000/livez
   curl -fsS http://127.0.0.1:3000/readyz
   ```

   Gateway host map (what is supported vs Vercel-disabled): [README Deploy](../../README.md#deploy).

`/livez` proves that the process event loop is serving requests. `/readyz` additionally checks SQLite reads/writes, migration checksums, and the audit chain, and optionally sandbox host prerequisites when `ACS_READYZ_SANDBOX_PROBE=1` (see above). Route traffic only when readiness is HTTP 200. Authenticated operators can scrape `/metrics` for request latency/status, rate-limit outcomes (`acs_rate_limit_rejected_total`), audit lifecycle events, and SQLite readiness. Metric names, local scrape examples, and the Mission Control operator metrics panel: [operator-metrics.md](./operator-metrics.md).

## Shutdown

```sh
docker compose -f compose.production.yml stop -t 15 gateway
```

On `SIGTERM`/`SIGINT` the gateway flips `shutting_down` so claim tools return `gateway_shutting_down` (HTTP/MCP 503) and MCP mutating intake is refused, then waits up to `ACS_GATEWAY_DRAIN_TIMEOUT_MS` (default 8000) for active attempt leases to complete or expire before `app.close()`. A hard `ACS_GATEWAY_SHUTDOWN_TIMEOUT_MS` (default 10000) force-exits if close hangs. Drain start/finish emit `acs_shutdown_drain_total{phase=...}` and audit events `gateway.shutdown_drain.started` / `gateway.shutdown_drain.finished`.

Successful shutdown logs `gateway shutdown started`, drain progress, and `gateway shutdown complete`. A timeout or nonzero exit is an incident; verify database integrity before restart.

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

## Scheduled encrypted backups and restore drills

Production deployments should use the checked-in systemd units in `deploy/systemd` (or equivalent orchestrator
jobs) to create hourly encrypted backups and run a daily isolated restore drill. Create a dedicated 32-byte key
file owned by the service account with mode `0600`; keep that key in the deployment secret store and separately
from the backups. Loss of the key makes every managed backup unrecoverable.

Configure `/etc/agent-control-stack/database-backup.env` without putting secrets in it:

```ini
ACS_DB_PATH=/var/lib/agent-control-stack/control.db
ACS_BACKUP_DIRECTORY=/var/backups/agent-control-stack
ACS_BACKUP_KEY_FILE=/run/secrets/acs-database-backup-key
ACS_BACKUP_RETENTION_COUNT=48
ACS_BACKUP_MAX_AGE_HOURS=2
ACS_BACKUP_MAX_RTO_SECONDS=300
```

Then install and enable `acs-database-backup.{service,timer}` and
`acs-database-restore-drill.{service,timer}`. The backup job writes an AES-256-GCM encrypted artifact and a
checksum-bound JSON manifest through sibling temporary files, verifies the database before encryption, publishes
the manifest last, and only then removes backups outside the configured count. The restore drill selects the
newest manifest, authenticates and decrypts it into a private temporary directory, exercises the atomic restore
primitive against a separate database, runs the full readiness contract, and reports measured backup age (RPO)
and restore time (RTO). It never replaces the production database.

The checked-in units grant filesystem access specifically to `/var/backups/agent-control-stack`, matching the
example above. If the deployment uses another backup directory, update both the environment file and the units'
`ReadWritePaths`/`ReadOnlyPaths` sandbox directives together.

Operators can run the same checks directly:

```sh
npm run db:backup-policy -- backup /path/control.db \
  --destination /secure-backups --key-file /run/secrets/acs-database-backup-key --retain 48
npm run db:backup-policy -- verify-latest /secure-backups \
  --key-file /run/secrets/acs-database-backup-key
npm run db:backup-policy -- drill-latest /secure-backups \
  --key-file /run/secrets/acs-database-backup-key --max-age-hours 2 --max-rto-seconds 300
```

Each command emits one JSON record without key material. Alert on a nonzero unit exit or an output record with
`ok:false`. A valid restore whose age or duration breaches its configured objective also exits nonzero. Test key
recovery from the production secret store during disaster-recovery exercises; do not copy the key into the backup
directory.

## Incident recovery

- **Readiness 503:** inspect the public check code. Do not route traffic or attempt writes until the DB write, migration checksum, and audit-chain checks pass.
- **Audit-chain failure:** stop writers, preserve the DB and logs, restore the last verified backup, and investigate before reopening. Do not rewrite hashes in place.
- **Expired worker lease:** run one worker; startup marks expired running leases failed. Review the terminal audit event before deliberately recreating work.
- **Database locked:** identify the competing writer, stop it cleanly, then retry readiness. Do not delete WAL/SHM files from a live database.
- **Disk full:** stop writes, free space without deleting authoritative DB/WAL files, back up, then recheck readiness and integrity.
- **Migration checksum mismatch:** stop. Historical migration files or recorded metadata changed. Restore the trusted artifact/DB pair; do not update the checksum to make readiness green.

## Observability and retention

Gateway request logs are structured JSON on stdout and include Fastify request IDs. MCP authenticated requests also persist `connector.requested` audit events with actor, auth method, request ID, and tool. Work-item lifecycle events live in SQLite. Configure container log rotation in the deployment platform. Managed backup retention applies only to encrypted backup artifacts and their manifests; this repository does not silently delete audit history from the live database.

The gateway exposes a Prometheus-compatible `/metrics` endpoint, but it is intentionally local to this service. Alert on container health/readiness, restart count, nonzero exits, disk usage, rate-limit responses, lease/worker lifecycle counters, and error-level structured logs. A hosted metrics/alerting backend remains a deployment responsibility.

## Pending-approval digest (optional)

Operators who do not keep Mission Control open can enable an optional oneshot
digest of stale `needs_approval` work (item id + action hash only). Default off.
See [pending-approval-digest.md](./pending-approval-digest.md).
