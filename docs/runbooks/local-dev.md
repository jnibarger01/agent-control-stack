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

The worker simulates one approved work item and records start/completion events with `execution_mode: "dry_run"`.
