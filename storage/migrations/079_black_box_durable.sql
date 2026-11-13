-- Durable Agent Black Box event store, chain head state, and observer signing-key lifecycle.
--
-- black_box_events is append-only (enforced by BEFORE UPDATE, BEFORE DELETE, and BEFORE INSERT anti-REPLACE triggers).
-- Each event commits to its predecessor via previous_hash -> event_hash and can carry an audit_events anchor.

CREATE TABLE black_box_events (
  seq INTEGER PRIMARY KEY CHECK (seq >= 1),
  event_id TEXT NOT NULL UNIQUE,
  producer_key TEXT NOT NULL UNIQUE,
  run_id TEXT,
  mission_id TEXT,
  correlation_id TEXT,
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 128),
  trust_level TEXT NOT NULL CHECK (trust_level IN ('acs_authoritative', 'independently_verified', 'authenticated_producer', 'untrusted_claim', 'unknown')),
  evidence_hash TEXT,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  previous_hash TEXT NOT NULL CHECK (length(previous_hash) = 64),
  event_hash TEXT NOT NULL CHECK (length(event_hash) = 64),
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  fingerprint TEXT NOT NULL,
  audit_event_id TEXT,
  audit_event_hash TEXT,
  ingested_at TEXT NOT NULL
);

CREATE INDEX idx_black_box_events_run_id ON black_box_events (run_id);
CREATE INDEX idx_black_box_events_mission_id ON black_box_events (mission_id);
CREATE UNIQUE INDEX idx_black_box_events_evidence_hash ON black_box_events (evidence_hash) WHERE evidence_hash IS NOT NULL;

CREATE TRIGGER black_box_events_no_update BEFORE UPDATE ON black_box_events
BEGIN
  SELECT RAISE(ABORT, 'black_box_events is append-only');
END;

CREATE TRIGGER black_box_events_no_delete BEFORE DELETE ON black_box_events
BEGIN
  SELECT RAISE(ABORT, 'black_box_events is append-only');
END;

CREATE TRIGGER black_box_events_no_replace BEFORE INSERT ON black_box_events
WHEN EXISTS (SELECT 1 FROM black_box_events WHERE seq = NEW.seq OR event_id = NEW.event_id OR producer_key = NEW.producer_key)
BEGIN
  SELECT RAISE(ABORT, 'black_box_events is append-only');
END;

CREATE TABLE black_box_chain_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  seq INTEGER NOT NULL CHECK (seq >= 0),
  head_hash TEXT NOT NULL CHECK (length(head_hash) = 64),
  updated_at TEXT NOT NULL
);

INSERT INTO black_box_chain_state (id, seq, head_hash, updated_at)
VALUES (1, 0, '0000000000000000000000000000000000000000000000000000000000000000', '1970-01-01T00:00:00.000Z');

CREATE TABLE black_box_observer_keys (
  key_id TEXT PRIMARY KEY CHECK (length(key_id) BETWEEN 1 AND 128),
  observer_id TEXT NOT NULL CHECK (length(observer_id) BETWEEN 1 AND 128),
  public_key_pem TEXT NOT NULL CHECK (length(public_key_pem) >= 32),
  status TEXT NOT NULL CHECK (status IN ('active', 'rotated', 'revoked')),
  registered_at TEXT NOT NULL,
  registered_by TEXT NOT NULL,
  rotated_at TEXT,
  rotated_to_key_id TEXT,
  revoked_at TEXT,
  revoked_by TEXT,
  revocation_reason TEXT,
  audit_event_id TEXT
);

CREATE INDEX idx_black_box_observer_keys_observer_id ON black_box_observer_keys (observer_id);
