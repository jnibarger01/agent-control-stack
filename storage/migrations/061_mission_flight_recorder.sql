-- Execution Flight Recorder: a per-mission, append-only, hash-chained record of everything a coding mission did.
--
-- Each record commits to its predecessor, so an edited, removed, reordered or inserted record changes the chain and is
-- found by verification. The triggers below make accidental or application-level UPDATE/DELETE fail; they do NOT stop
-- a principal with write access to the database file, who can drop them or rewrite the whole chain. This is tamper
-- EVIDENCE, not tamper prevention. Detecting a full rewrite needs the chain head recorded somewhere the database
-- writer cannot reach (see docs/flight-recorder.md).
--
-- coding_events remains the operational view. event_id links a chained record to its coding_events row so that an
-- edit to, or deletion of, the operational row is detected. epoch records the highest coding_events row that existed
-- before this migration, and likewise the highest coding_evidence rowid: those rows were never chained and are reported
-- as legacy, not as tampering.

CREATE TABLE mission_flight_records (
  mission_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  event_id INTEGER UNIQUE,
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 128),
  body_json TEXT NOT NULL CHECK (json_valid(body_json)),
  created_at TEXT NOT NULL,
  previous_hash TEXT NOT NULL CHECK (previous_hash = '' OR length(previous_hash) = 64),
  record_hash TEXT NOT NULL CHECK (length(record_hash) = 64),
  PRIMARY KEY (mission_id, seq)
);

CREATE TABLE mission_flight_epoch (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_legacy_event_id INTEGER NOT NULL CHECK (last_legacy_event_id >= 0),
  last_legacy_evidence_rowid INTEGER NOT NULL CHECK (last_legacy_evidence_rowid >= 0)
);

INSERT INTO mission_flight_epoch (singleton, last_legacy_event_id, last_legacy_evidence_rowid)
SELECT 1,
       (SELECT COALESCE(MAX(event_id), 0) FROM coding_events),
       (SELECT COALESCE(MAX(rowid), 0) FROM coding_evidence);

CREATE TRIGGER mission_flight_records_no_update BEFORE UPDATE ON mission_flight_records
BEGIN
  SELECT RAISE(ABORT, 'mission_flight_records is append-only');
END;

CREATE TRIGGER mission_flight_records_no_delete BEFORE DELETE ON mission_flight_records
BEGIN
  SELECT RAISE(ABORT, 'mission_flight_records is append-only');
END;

CREATE TRIGGER mission_flight_epoch_no_change BEFORE UPDATE ON mission_flight_epoch
BEGIN
  SELECT RAISE(ABORT, 'mission_flight_epoch is write-once');
END;
