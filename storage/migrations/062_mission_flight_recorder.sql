-- Execution Flight Recorder: a per-mission, append-only, hash-chained record of everything a coding mission did.
--
-- Each record commits to its predecessor, so an edited, removed, reordered or inserted record changes the chain and is
-- found by verification. The triggers below make accidental or application-level UPDATE/DELETE/REPLACE fail; they do NOT
-- stop a principal with write access to the database file, who can drop them or rewrite the whole chain. This is tamper
-- EVIDENCE, not tamper prevention. Detecting a full rewrite needs the chain head recorded somewhere the database
-- writer cannot reach (see docs/flight-recorder.md).
--
-- This chain is separate from the global audit_events chain. `audit verify` and the readiness check do not cover it.
--
-- coding_events remains the operational view. event_id links a chained record to its coding_events row so that an
-- edit to, or deletion of, the operational row is detected.
--
-- Rows that existed before this migration were never chained. The exact set of their keys is recorded here (not a
-- numeric cutoff, which a later insert reusing an unused low id could masquerade under). Those rows are reported as
-- legacy, never as verified and never as tampering.

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

CREATE TABLE mission_flight_legacy_events (
  event_id INTEGER PRIMARY KEY
);
INSERT INTO mission_flight_legacy_events (event_id) SELECT event_id FROM coding_events;

CREATE TABLE mission_flight_legacy_evidence (
  mission_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  PRIMARY KEY (mission_id, evidence_id)
);
INSERT INTO mission_flight_legacy_evidence (mission_id, evidence_id) SELECT mission_id, evidence_id FROM coding_evidence;

CREATE TRIGGER mission_flight_records_no_update BEFORE UPDATE ON mission_flight_records
BEGIN
  SELECT RAISE(ABORT, 'mission_flight_records is append-only');
END;

CREATE TRIGGER mission_flight_records_no_delete BEFORE DELETE ON mission_flight_records
BEGIN
  SELECT RAISE(ABORT, 'mission_flight_records is append-only');
END;

-- INSERT OR REPLACE resolves a key conflict by deleting the old row without firing DELETE triggers (recursive_triggers
-- is off), so append-only also needs BEFORE INSERT guards. They fire before conflict resolution and refuse any insert
-- whose primary key, or whose linked event, already has a record, which closes REPLACE as well as a plain duplicate.
CREATE TRIGGER mission_flight_records_no_replace BEFORE INSERT ON mission_flight_records
WHEN EXISTS (SELECT 1 FROM mission_flight_records WHERE mission_id = NEW.mission_id AND seq = NEW.seq)
  OR (NEW.event_id IS NOT NULL AND EXISTS (SELECT 1 FROM mission_flight_records WHERE event_id = NEW.event_id))
BEGIN
  SELECT RAISE(ABORT, 'mission_flight_records is append-only');
END;

-- The legacy key sets are fixed at migration time: nothing may be added, changed or removed afterwards.
CREATE TRIGGER mission_flight_legacy_events_no_insert BEFORE INSERT ON mission_flight_legacy_events
BEGIN
  SELECT RAISE(ABORT, 'mission_flight_legacy_events is write-once');
END;
CREATE TRIGGER mission_flight_legacy_events_no_update BEFORE UPDATE ON mission_flight_legacy_events
BEGIN
  SELECT RAISE(ABORT, 'mission_flight_legacy_events is write-once');
END;
CREATE TRIGGER mission_flight_legacy_events_no_delete BEFORE DELETE ON mission_flight_legacy_events
BEGIN
  SELECT RAISE(ABORT, 'mission_flight_legacy_events is write-once');
END;

CREATE TRIGGER mission_flight_legacy_evidence_no_insert BEFORE INSERT ON mission_flight_legacy_evidence
BEGIN
  SELECT RAISE(ABORT, 'mission_flight_legacy_evidence is write-once');
END;
CREATE TRIGGER mission_flight_legacy_evidence_no_update BEFORE UPDATE ON mission_flight_legacy_evidence
BEGIN
  SELECT RAISE(ABORT, 'mission_flight_legacy_evidence is write-once');
END;
CREATE TRIGGER mission_flight_legacy_evidence_no_delete BEFORE DELETE ON mission_flight_legacy_evidence
BEGIN
  SELECT RAISE(ABORT, 'mission_flight_legacy_evidence is write-once');
END;
