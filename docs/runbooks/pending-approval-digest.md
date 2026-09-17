# Pending-approval digest

Optional ops digest for work items waiting in `needs_approval` (policy
decision `require_approval`) longer than N minutes. Default **off** so local
dev stays quiet unless an operator opts in.

## Why

Pending approvals are easy to miss when the Mission Control dashboard is not
open. The digest surfaces stale gated work to stdout and/or a local webhook.

## Payload

One JSON object per successful run (never one event per item). Empty queues and
disabled mode are silent (no stdout line, no webhook POST).

Each entry includes only:

- `workItemId`
- `actionHash` (exact policy action fingerprint)
- `updatedAt`
- `ageMinutes`

No titles, intents, action params, tokens, or other secret-bearing fields.

## Enablement

```sh
export ACS_PENDING_APPROVAL_DIGEST_ENABLED=true
export ACS_PENDING_APPROVAL_DIGEST_OLDER_THAN_MINUTES=30   # default 30
export ACS_PENDING_APPROVAL_DIGEST_STDOUT=true             # default true when enabled
# optional local webhook (http/https only)
# export ACS_PENDING_APPROVAL_DIGEST_WEBHOOK_URL=http://127.0.0.1:9999/hooks/acs-pending
export ACS_DB_PATH=storage/local.db

npm run build
npm run ops:pending-approval-digest
```

Schedule the oneshot with cron or a systemd timer the same way as
`npm run start:worker` (see ADR 0013). Leave `ACS_PENDING_APPROVAL_DIGEST_ENABLED`
unset to keep the feature off.

## Verify

```sh
npx vitest run packages/policy-gate/src/pending-approval-digest.test.ts
```

Acceptance covered by that fixture: stale pending items produce exactly one
digest; an empty queue stays silent.
