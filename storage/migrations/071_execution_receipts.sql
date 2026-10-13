-- Proof-of-Execution receipts (PLAN Item 2, P1-7). Migration number 071: the Engineering Lead reserved 060-070.
--
-- 1. review_findings.verifier_engine_id: the verifier engine that produced a review, written by the server at
--    review time from the authenticated reviewer credential, never from the request body. Rows recorded before
--    this migration have NULL (engine unknown), and a receipt cannot bind a reviewer whose engine is unknown.
-- 2. execution_receipts: the single receipt row format from P1-7 (receipt_id, subject, doc_json, doc_hash,
--    prev_hash, audit_event_hash). doc_json is the canonical receipt document and doc_hash is its receipt hash.
--    Rows form a hash chain through prev_hash and are append-only.

ALTER TABLE review_findings ADD COLUMN verifier_engine_id TEXT
  CHECK (verifier_engine_id IS NULL OR length(verifier_engine_id) BETWEEN 1 AND 4096);

CREATE TABLE execution_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (length(receipt_id) BETWEEN 1 AND 128),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 512),
  doc_json TEXT NOT NULL CHECK (json_valid(doc_json)),
  doc_hash TEXT NOT NULL UNIQUE CHECK (length(doc_hash) = 64 AND doc_hash = lower(doc_hash)),
  prev_hash TEXT CHECK (prev_hash IS NULL OR (length(prev_hash) = 64 AND prev_hash = lower(prev_hash))),
  audit_event_hash TEXT NOT NULL CHECK (length(audit_event_hash) = 64 AND audit_event_hash = lower(audit_event_hash)),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL)
);
CREATE INDEX idx_execution_receipts_subject ON execution_receipts(subject, created_at);
CREATE TRIGGER execution_receipts_no_update BEFORE UPDATE ON execution_receipts BEGIN
  SELECT RAISE(ABORT, 'execution_receipts: immutable');
END;
CREATE TRIGGER execution_receipts_no_delete BEFORE DELETE ON execution_receipts BEGIN
  SELECT RAISE(ABORT, 'execution_receipts: append-only');
END;
