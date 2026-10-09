# Audit-chain verification freshness at the SQLite write boundary

ACS verifies the stored audit history when the work-item store initializes. That verified state is cached for low-cost `/health` and `/readyz` checks. A cached success must **not** authorize an unrelated, newly committed database state.

## Write-authorization behavior

Before an outer work-item store mutation, ACS acquires `BEGIN IMMEDIATE` and checks the connection's SQLite `PRAGMA data_version`. The following conditions force a complete replay of the audit history before the requested mutation can run:

- Another SQLite connection committed a database change since the last verified state.
- The last audit verification is at least 30 seconds old, or the local clock moved backward.
- The verification age or data version cannot be established.

Any invalid or unreadable audit chain fails closed as `audit_chain_invalid`; the store latches invalidity for subsequent writes. It also marks cached readiness as unhealthy. The protected operation and its audit event cannot commit on verification failure. The version check and verification run while the write lock is held, preventing another SQLite writer from modifying the database between validation and the guarded mutation.

The normal fast path still performs only the SQLite version query; full audit replay happens only when freshness demands it. This check applies to the store's entire `write()` boundary, including nested operations, rather than selectively trusting one caller's idea of a privileged action.

## Scope and operational limitations

This is **audit-chain** verification, not a replacement for full `PRAGMA integrity_check`, migration verification, or foreign-key checking. The independent deep-health operation retains those broader responsibilities. `/health` and `/readyz` remain cheap and may show the last verified result until the next write or deep inspection.

SQLite `data_version` detects commits made through **other connections**; modifications made through the same raw connection bypass that signal. The 30-second maximum age bounds that case but does not guarantee instantaneous detection. Direct database mutation outside the audited store API is unsupported. Database file replacement or tampering below SQLite's transaction protocol requires stronger controls and may be outside this mechanism's visibility.

A verification refresh on a database with substantial audit history may delay the first write following an external change or 30-second expiry. Never bypass verification because it times out. Measure its cost in production-like workloads before merging and retain an independently scheduled deep check for database structures beyond the audit chain.

## Regression verification

In an isolated checkout with dependencies available, run:

```bash
node node_modules/vitest/vitest.mjs run packages/work-items/src/audit-integrity-freshness.test.ts
```

The regression uses temporary SQLite databases to prove that post-startup external audit corruption prevents a new write and audit event, valid concurrent writers continue, and stale same-connection audit verification fails closed. No production database or service is touched.
