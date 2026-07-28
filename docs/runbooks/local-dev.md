# Local Development Runbook

## Install

```sh
npm install
```

## Validate

```sh
npm run build
npm test
```

The normal test suite proves application behavior and keeps the production
worker in dry-run mode. On a Linux host with Bubblewrap, a working user systemd
manager, and cgroup v2, run the separate containment gate:

```sh
npm run test:sandbox-integration
```

That gate executes disposable fixtures in real namespaces and cgroup scopes. It
must pass filesystem and network denial, output and wall-clock bounds,
process-tree cleanup, cancellation, memory and PID enforcement, and exact
CPU/memory/PID scope-property checks. A skipped or unavailable host gate is not
containment proof.

## Run Gateway

```sh
npm run build
ACS_DB_PATH=storage/local.db npm run start:gateway
```

Open `http://127.0.0.1:3000`.

For MCP auth testing in local development, set `ACS_MCP_BEARER_TOKEN` and send it as `Authorization: Bearer <token>` on `/mcp` requests. OAuth and tunnel ID setup are documented in `docs/oauth-authentication.md`.

## Run Worker Once

```sh
ACS_DB_PATH=storage/local.db npm run start:worker
```

The worker simulates one approved read-only work item and records start/completion events with `execution_mode: "dry_run"`. Approved writes, shell commands, and other non-read-only actions are recorded as blocked until the authoritative attempt/workspace execution path is enabled.
