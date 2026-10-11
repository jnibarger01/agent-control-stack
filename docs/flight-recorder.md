# Execution Flight Recorder

A per-mission, append-only, hash-chained record of what a coding mission did. It lets an operator reconstruct a
mission from recorded evidence and find out whether that record was altered afterwards.

## What it is, and what it is not

This is a separate per-mission chain in `mission_flight_records`. It is **not** part of the global `audit_events` chain,
and `audit verify` and the `/readyz` audit check do not cover it. Verify it with `verifyFlightRecord` or the
flight-record endpoint. Anchoring each mission's head hash into `audit_events` is future work.

It is **tamper evidence**. It is not tamper prevention.

- Every record commits to the one before it (`previous_hash`) and to its own content (`record_hash`). Editing,
  removing, reordering or inserting a record breaks the chain and `verifyFlightRecord` reports it.
- Each chained record is tied to its operational `coding_events` row (`event_id`), and each evidence payload hash is
  chained when the evidence is first stored. Editing or deleting either operational row, or writing one around the
  recorder, is reported.
- SQLite triggers make ordinary `UPDATE`, `DELETE` and `INSERT OR REPLACE` of `mission_flight_records` fail (the replace
  guard is a `BEFORE INSERT` trigger because SQLite resolves a replace without firing delete triggers). The legacy key tables
  are write-once. A database owner can drop the triggers.
- Verification and replay read one database snapshot, so a writer committing mid-read cannot make a legitimate event
  look unrecorded or put unverified records in the response. Evidence is checked for payload, kind and timestamp.

## Trust assumptions

1. Someone who can write the database file can rewrite the whole chain consistently (recompute every hash). Nothing
   inside the database can reveal that. Only a head hash held **outside** the database writer's reach can. Until ACS
   publishes the head to an external anchor, treat `headHash` as something to copy to a place the gateway host cannot
   modify (an append-only log, a signed note, another host) when a mission matters.
2. A record shows what ACS recorded. It does not prove that a push, merge or deployment happened; those are
   separate effects with their own evidence.
3. Events written before migration 062 are not chained. They are counted as `legacyEventCount` (events) and `legacyEvidenceCount` (evidence rows) and make the verdict
   `partial_legacy`; they are never reported as tampering and never as verified.
4. Rows that existed before the migration are identified by an exact snapshot of their keys (event ids, and
   mission and evidence ids), taken in the migration itself, not by a numeric cutoff. A later insert that reuses an
   unused low id is therefore not mistaken for legacy. Deleting legacy rows is not detectable, because they were never
   chained.
5. A `tampered` verdict says the record cannot be trusted. It does not say who changed it or when.

## What is recorded

A record bound to an event or evidence row that predates the recorder is `legacy_binding`: records are only written
after the migration, so such a record was inserted later to make unprovable history look recorded.

Evidence identifiers and kinds can embed caller-supplied values, so the chain stores a hash of each (for integrity) and
only a redacted label for display; findings use the same label. A malformed evidence binding is `unlinked_record`.

A record with no operational event row is only valid as an evidence binding (`evidence.recorded`, once per evidence
row); any other unlinked record is `unlinked_record`, however well it hashes. An attacker who writes both a forged
operational row and a matching record is the full-rewrite case below.

Every mission event goes through `CodingMissionStore.recordMissionEvent`, which writes the operational row and the
chained record in one transaction. If either write fails, both roll back. This includes state transitions (with
`from`/`to`), work-unit lifecycle, claims, verification, approvals and budget events. Evidence inserts add an
`evidence.recorded` record with the evidence id, kind and payload hash.

Secrets are removed before anything is stored or hashed: keys matching token, secret, authorization, password,
cookie or credential are dropped, and secret-shaped values (bearer tokens, API keys, private keys, URL credentials)
are masked.

## API

`GET /coding-missions/:id/flight-record?afterSeq=0&limit=200` — scope `acs:read`; in the public contract
(`getCodingMissionFlightRecord`). It checks that the mission exists without deserializing the mission row, so a
corrupted auxiliary column cannot disable forensic replay.

- `401` without a valid credential, `404` for an unknown mission, `400` for a bad query, `503` when coding missions
  are not configured.
- `verification` always covers the whole chain and reconstruction scans all of it in batches, at any mission size;
  only `records` is paged (`nextAfterSeq` continues).
- `verification.verdict`: `verified`, `partial_legacy`, or `tampered`, with `findings[]` (`record_hash_mismatch`,
  `previous_hash_mismatch`, `sequence_gap`, `event_missing`, `event_modified`, `unrecorded_event`,
  `evidence_missing`, `evidence_modified`, `unrecorded_evidence`, `unlinked_record`, `legacy_binding`).
- `reconstruction` is derived from the chain alone (state history, last state, per-unit lifecycle: created, ready, claimed, verifying, completed, failed, retryable, retry_scheduled, cancelled, pending, conflict, unknown) and compared with the
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
