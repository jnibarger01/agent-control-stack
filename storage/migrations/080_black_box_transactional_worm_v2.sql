-- Phase 3A, 3B & 6: Transactional Black Box durability, off-host WORM outbox/anchors,
-- v2 unified receipt persistence, and observer key lifecycle immutability & retirement.

ALTER TABLE black_box_events ADD COLUMN receipt_schema TEXT;
ALTER TABLE black_box_events ADD COLUMN receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json));
ALTER TABLE black_box_events ADD COLUMN receipt_signature TEXT;
ALTER TABLE black_box_events ADD COLUMN observer_key_id TEXT;
ALTER TABLE black_box_events ADD COLUMN work_item_id TEXT;
ALTER TABLE black_box_events ADD COLUMN attempt_id TEXT;
ALTER TABLE black_box_events ADD COLUMN lease_id TEXT;
ALTER TABLE black_box_events ADD COLUMN invocation_hash TEXT;
ALTER TABLE black_box_events ADD COLUMN observation_scope_json TEXT CHECK (observation_scope_json IS NULL OR json_valid(observation_scope_json));
ALTER TABLE black_box_events ADD COLUMN category_completeness_json TEXT CHECK (category_completeness_json IS NULL OR json_valid(category_completeness_json));

CREATE INDEX idx_black_box_events_work_item_attempt
  ON black_box_events (work_item_id, attempt_id, seq ASC);

CREATE TABLE black_box_worm_outbox (
  seq INTEGER PRIMARY KEY CHECK (seq >= 1),
  event_id TEXT NOT NULL UNIQUE,
  evidence_hash TEXT NOT NULL UNIQUE,
  event_hash TEXT NOT NULL CHECK (length(event_hash) = 64),
  previous_hash TEXT NOT NULL CHECK (length(previous_hash) = 64),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  audit_event_id TEXT NOT NULL,
  audit_event_hash TEXT NOT NULL CHECK (length(audit_event_hash) = 64),
  idempotency_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'anchored', 'failed')),
  worm_provider TEXT,
  worm_object_key TEXT,
  worm_version_id TEXT,
  worm_etag_sha256 TEXT,
  retention_mode TEXT,
  retain_until TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  anchored_at TEXT,
  FOREIGN KEY (seq) REFERENCES black_box_events(seq) ON DELETE RESTRICT
);

CREATE INDEX idx_black_box_worm_outbox_status
  ON black_box_worm_outbox (status, seq ASC);

CREATE TRIGGER black_box_worm_outbox_no_delete BEFORE DELETE ON black_box_worm_outbox
BEGIN
  SELECT RAISE(ABORT, 'black_box_worm_outbox rows cannot be deleted');
END;

CREATE TRIGGER black_box_worm_outbox_immutable_payload BEFORE UPDATE ON black_box_worm_outbox
WHEN NEW.seq != OLD.seq
  OR NEW.event_id != OLD.event_id
  OR NEW.evidence_hash != OLD.evidence_hash
  OR NEW.event_hash != OLD.event_hash
  OR NEW.previous_hash != OLD.previous_hash
  OR NEW.receipt_json != OLD.receipt_json
  OR NEW.event_json != OLD.event_json
  OR NEW.audit_event_id != OLD.audit_event_id
  OR NEW.audit_event_hash != OLD.audit_event_hash
  OR (OLD.status = 'anchored' AND NEW.status != 'anchored')
BEGIN
  SELECT RAISE(ABORT, 'black_box_worm_outbox payload and anchored status are immutable');
END;

CREATE TABLE black_box_observer_keys_v2 (
  key_id TEXT PRIMARY KEY CHECK (length(key_id) BETWEEN 1 AND 128),
  observer_id TEXT NOT NULL CHECK (length(observer_id) BETWEEN 1 AND 128),
  public_key_pem TEXT NOT NULL CHECK (length(public_key_pem) >= 32),
  public_key_fingerprint_sha256 TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'rotated', 'retired', 'revoked')),
  registered_at TEXT NOT NULL,
  registered_by TEXT NOT NULL,
  rotated_at TEXT,
  rotated_to_key_id TEXT,
  retired_at TEXT,
  retired_by TEXT,
  revoked_at TEXT,
  revoked_by TEXT,
  revocation_reason TEXT,
  audit_event_id TEXT
);

INSERT INTO black_box_observer_keys_v2 (
  key_id, observer_id, public_key_pem, public_key_fingerprint_sha256, status,
  registered_at, registered_by, rotated_at, rotated_to_key_id,
  retired_at, retired_by, revoked_at, revoked_by, revocation_reason, audit_event_id
)
SELECT
  key_id, observer_id, public_key_pem, NULL, status,
  registered_at, registered_by, rotated_at, rotated_to_key_id,
  NULL, NULL, revoked_at, revoked_by, revocation_reason, audit_event_id
FROM black_box_observer_keys;

DROP TABLE black_box_observer_keys;
ALTER TABLE black_box_observer_keys_v2 RENAME TO black_box_observer_keys;

CREATE INDEX idx_black_box_observer_keys_observer_id ON black_box_observer_keys (observer_id);

CREATE TRIGGER black_box_observer_keys_no_delete BEFORE DELETE ON black_box_observer_keys
BEGIN
  SELECT RAISE(ABORT, 'black_box_observer_keys is append-only');
END;

CREATE TRIGGER black_box_observer_keys_immutable BEFORE UPDATE ON black_box_observer_keys
WHEN NEW.key_id != OLD.key_id
  OR NEW.observer_id != OLD.observer_id
  OR NEW.public_key_pem != OLD.public_key_pem
  OR NEW.registered_at != OLD.registered_at
  OR NEW.registered_by != OLD.registered_by
  OR (OLD.status = 'revoked' AND NEW.status != 'revoked')
  OR (OLD.status = 'retired' AND NEW.status IN ('active', 'rotated'))
  OR (OLD.status = 'rotated' AND NEW.status = 'active')
BEGIN
  SELECT RAISE(ABORT, 'black_box_observer_keys identity fields and terminal transitions are immutable');
END;
