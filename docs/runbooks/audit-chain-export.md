# Audit-chain export (JSONL)

Tamper-evident audit events live in SQLite (`audit_events`). Operators can export
them as JSONL for offline verification or optional SIEM shipping.

Redaction is applied **before** persistence and hashing (see ADR 0005). Exports
contain the same redacted payloads stored in the DB — never raw secrets.

## Usage

```sh
# Export full chain in sequence order (stdout)
ACS_DB_PATH=storage/local.db node apps/cli/dist/cli.js audit export

# Or write a file
node apps/cli/dist/cli.js audit export --db storage/local.db -o audit.jsonl

# Recompute chain hashes on an export
node apps/cli/dist/cli.js audit verify --file audit.jsonl

# Verify the live DB chain (same hash rules as /readyz audit check)
node apps/cli/dist/cli.js audit verify --db storage/local.db
```

Exit code `0` means the chain verifies; `1` means a break (JSON result includes
`failure.sequence` and `failure.reason`).

## JSONL fields (one event per line)

| Field          | Type                              | Notes                                                         |
| -------------- | --------------------------------- | ------------------------------------------------------------- |
| `sequence`     | positive integer                  | Monotonic chain order                                         |
| `id`           | string                            | Event id                                                      |
| `name`         | string                            | Event type (e.g. `work_item.created`)                         |
| `timeUnixNano` | decimal digit string              | Event timestamp                                               |
| `attributes`   | object of string\|number\|boolean | Indexed metadata; already redacted                            |
| `body`         | object                            | Event payload; already redacted                               |
| `previousHash` | string                            | Prior `eventHash`, or `""` for genesis                        |
| `eventHash`    | sha256 hex                        | Hash over sequence, id, name, time, attrs, body, previousHash |

Line order is ascending `sequence`. Empty export (no events) is an empty file.

## Verify semantics

`audit verify --file` parses JSONL and runs `verifyAuditChain`: each
`previousHash` must match the prior `eventHash`, and each `eventHash` must equal
the recomputed hash. Tampering with any field breaks the chain.

## Related

- [ADR 0005: Hash-chained audit log](../adr/0005-hash-chained-audit-log.md)
- [sqlite-backup-restore.md](./sqlite-backup-restore.md) — DB snapshot + integrity
