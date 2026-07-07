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

For protected MCP tool calls in local development, set `ACS_MCP_BEARER_TOKEN` and send it as `Authorization: Bearer <token>`. OAuth, WorkOS, and tunnel ID setup are documented in `docs/oauth-authentication.md`.

## Run Worker Once

```sh
ACS_DB_PATH=storage/local.db npm run start:worker
```

The worker executes one approved work item and records start/completion events.
