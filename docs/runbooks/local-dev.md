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

## Run Worker Once

```sh
ACS_DB_PATH=storage/local.db npm run start:worker
```

The worker executes one approved work item and records start/completion events.
