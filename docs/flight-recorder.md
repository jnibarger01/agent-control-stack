# Execution Flight Recorder

A per-mission, append-only, hash-chained record of what a coding mission did. It lets an operator reconstruct a
mission from recorded evidence and find out whether that record was altered afterwards.

## What it is, and what it is not

It is **tamper evidence**. It is not tamper prevention.

- Every record commits to the one before it (`previous_hash`) and to its own content (`record_hash`). Editing,
  removing, reordering or inserting a record breaks the chain and `verifyFlightRecord` reports it.
- Each chained record is tied to its operational `coding_events` row (`event_id`), and each evidence payload hash is
  chained when the evidence is first stored. Editing or deleting either operational row, or writing one around the
  recorder, is reported.
- SQLite triggers make ordinary `UPDATE` and `DELETE` of `mission_flight_records` fail. A database owner can drop them.

## Trust assumptions

1. Someone who can write the database file can rewrite the whole chain consistently (recompute every hash). Nothing
   inside the database can reveal that. Only a head hash held **outside** the database writer's reach can. Until ACS
   publishes the head to an external anchor, treat `headHash` as something to copy to a place the gateway host cannot
   modify (an append-only log, a signed note, another host) when a mission matters.
2. A record shows what ACS recorded. It does not prove that a push, merge or deployment happened; those are
   separate effects with their own evidence.
3. Events written before migration 062 are not chained. They are counted as `legacyEventCount` and make the verdict
   `partial_legacy`; they are never reported as tampering and never as verified.
4. Evidence legacy detection uses the SQLite `rowid` cutoff taken at migration time. Deleting legacy evidence and
   reusing its rowids is not detectable.
5. A `tampered` verdict says the record cannot be trusted. It does not say who changed it or when.

## What is recorded

Every mission event goes through `CodingMissionStore.recordMissionEvent`, which writes the operational row and the
chained record in one transaction. If either write fails, both roll back. This includes state transitions (with
`from`/`to`), work-unit lifecycle, claims, verification, approvals and budget events. Evidence inserts add an
`evidence.recorded` record with the evidence id, kind and payload hash.

Secrets are removed before anything is stored or hashed: keys matching token, secret, authorization, password,
cookie or credential are dropped, and secret-shaped values (bearer tokens, API keys, private keys, URL credentials)
are masked.

## API

`GET /coding-missions/:id/flight-record?afterSeq=0&limit=200` — scope `acs:read`.

- `401` without a valid credential, `404` for an unknown mission, `400` for a bad query, `503` when coding missions
  are not configured.
- `verification` always covers the whole chain; only `records` is paged (`nextAfterSeq` continues).
- `verification.verdict`: `verified`, `partial_legacy`, or `tampered`, with `findings[]` (`record_hash_mismatch`,
  `previous_hash_mismatch`, `sequence_gap`, `event_missing`, `event_modified`, `unrecorded_event`,
  `evidence_missing`, `evidence_modified`, `unrecorded_evidence`).
- `reconstruction` is derived from the chain alone (state history, last state, per-unit outcome) and compared with the
  live mission row (`consistentWithLive`). A mismatch means the live row changed without a recorded transition.
- `trustworthy` is `false` for any `tampered` verdict. The records are still returned for investigation.

`acs:read` is the same scope that already guards mission views. A dedicated audit scope would change the public
contract baseline and is left as an explicit decision.

## Retention

Flight records are never deleted or pruned by ACS. There is no pruning code path, and the triggers refuse it.
Any future retention job must first export the affected chain, record its head hash externally, and only then archive
the records together with a signed statement of the removed range. Until that exists, the retention policy is
"keep everything"; database growth is the cost, tracked by the existing database health and backup policy.

## Verifying outside the gateway

`verifyFlightRecord(db, missionId)` reads only. Run it against a restored backup to check a mission after the fact.
