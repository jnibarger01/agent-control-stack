-- Advisor consultation fencing and integrity (follow-up to 073, PR #367 review).
-- 073 is left untouched. This migration rebuilds both advisor tables so that:
--   * subject_id holds derived mission-unit ids longer than 256 characters (up to 1024);
--   * each consultation records the attempt / lease / claim it was fenced to, so the completion
--     gate can refuse evidence recorded under an earlier attempt or claim;
--   * each binding carries an integrity hash that is re-verified on every read.
-- Rows written under 073 carry no fence columns and no binding hash. They are kept as history but
-- fail closed: a 073 consultation never satisfies the completion gate, and a 073 binding fails its
-- integrity check until an operator disables and re-enables it through the store.

DROP TRIGGER IF EXISTS advisor_consultations_no_update;
DROP TRIGGER IF EXISTS advisor_consultations_no_delete;
DROP TRIGGER IF EXISTS advisor_consultations_no_replace;
DROP INDEX IF EXISTS advisor_consultations_subject_idx;

CREATE TABLE advisor_bindings__074 (
  subject_id TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 1024),
  mission_id TEXT NOT NULL CHECK (length(mission_id) BETWEEN 1 AND 128),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('work_item', 'mission_unit')),
  executor_model_id TEXT NOT NULL CHECK (length(executor_model_id) BETWEEN 1 AND 128),
  advisor_model_id TEXT NOT NULL CHECK (length(advisor_model_id) BETWEEN 1 AND 128),
  advisor_transport_model TEXT NOT NULL CHECK (length(advisor_transport_model) BETWEEN 1 AND 256),
  require_before_completion INTEGER NOT NULL CHECK (require_before_completion IN (0, 1)),
  created_at TEXT NOT NULL,
  disabled_at TEXT,
  binding_hash TEXT CHECK (binding_hash IS NULL OR length(binding_hash) = 64),
  PRIMARY KEY (mission_id, subject_id)
);

INSERT INTO advisor_bindings__074
  (subject_id, mission_id, subject_kind, executor_model_id, advisor_model_id, advisor_transport_model,
   require_before_completion, created_at, disabled_at, binding_hash)
SELECT subject_id, mission_id, subject_kind, executor_model_id, advisor_model_id, advisor_transport_model,
       require_before_completion, created_at, disabled_at, NULL
FROM advisor_bindings;

DROP TABLE advisor_bindings;
ALTER TABLE advisor_bindings__074 RENAME TO advisor_bindings;

CREATE TRIGGER advisor_bindings_no_delete BEFORE DELETE ON advisor_bindings
BEGIN
  SELECT RAISE(ABORT, 'advisor_bindings rows cannot be deleted; disable them instead');
END;

CREATE TABLE advisor_consultations__074 (
  consultation_id TEXT PRIMARY KEY CHECK (length(consultation_id) BETWEEN 1 AND 128),
  consultation_hash TEXT NOT NULL CHECK (length(consultation_hash) = 64),
  subject_id TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 1024),
  mission_id TEXT NOT NULL CHECK (length(mission_id) BETWEEN 1 AND 128),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('work_item', 'mission_unit')),
  checkpoint TEXT NOT NULL CHECK (checkpoint IN ('before_approach', 'recurring_failure', 'before_completion')),
  disposition TEXT NOT NULL CHECK (disposition IN ('reviewed', 'declined', 'unavailable')),
  input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64),
  output_sha256 TEXT NOT NULL CHECK (length(output_sha256) = 64),
  guidance_text TEXT CHECK (
    (disposition = 'reviewed' AND guidance_text IS NOT NULL AND length(guidance_text) BETWEEN 1 AND 4000)
    OR (disposition <> 'reviewed' AND guidance_text IS NULL)
  ),
  decline_reason TEXT CHECK (
    (disposition = 'declined' AND decline_reason IS NOT NULL AND length(decline_reason) BETWEEN 1 AND 1000)
    OR (disposition <> 'declined' AND decline_reason IS NULL)
  ),
  error_code TEXT CHECK (
    (disposition = 'unavailable' AND error_code IS NOT NULL AND length(error_code) BETWEEN 1 AND 64)
    OR (disposition <> 'unavailable' AND error_code IS NULL)
  ),
  executor_model_id TEXT NOT NULL,
  advisor_model_id TEXT NOT NULL,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  created_at TEXT NOT NULL,
  attempt_id TEXT CHECK (attempt_id IS NULL OR length(attempt_id) BETWEEN 1 AND 256),
  lease_id TEXT CHECK (lease_id IS NULL OR length(lease_id) BETWEEN 1 AND 256),
  claim_token_hash TEXT CHECK (claim_token_hash IS NULL OR length(claim_token_hash) = 64),
  CHECK (
    (attempt_id IS NULL AND lease_id IS NULL AND claim_token_hash IS NULL)
    OR (subject_kind = 'work_item' AND lease_id IS NOT NULL AND claim_token_hash IS NULL)
    OR (subject_kind = 'mission_unit' AND claim_token_hash IS NOT NULL AND attempt_id IS NULL AND lease_id IS NULL)
  )
);

INSERT INTO advisor_consultations__074
  (consultation_id, consultation_hash, subject_id, mission_id, subject_kind, checkpoint, disposition,
   input_sha256, output_sha256, guidance_text, decline_reason, error_code, executor_model_id, advisor_model_id,
   input_tokens, output_tokens, created_at, attempt_id, lease_id, claim_token_hash)
SELECT consultation_id, consultation_hash, subject_id, mission_id, subject_kind, checkpoint, disposition,
       input_sha256, output_sha256, guidance_text, decline_reason, error_code, executor_model_id, advisor_model_id,
       input_tokens, output_tokens, created_at, NULL, NULL, NULL
FROM advisor_consultations;

DROP TABLE advisor_consultations;
ALTER TABLE advisor_consultations__074 RENAME TO advisor_consultations;

CREATE INDEX advisor_consultations_subject_idx
  ON advisor_consultations (mission_id, subject_id, checkpoint);

CREATE TRIGGER advisor_consultations_no_update BEFORE UPDATE ON advisor_consultations
BEGIN
  SELECT RAISE(ABORT, 'advisor_consultations is append-only');
END;

CREATE TRIGGER advisor_consultations_no_delete BEFORE DELETE ON advisor_consultations
BEGIN
  SELECT RAISE(ABORT, 'advisor_consultations is append-only');
END;

CREATE TRIGGER advisor_consultations_no_replace BEFORE INSERT ON advisor_consultations
WHEN EXISTS (SELECT 1 FROM advisor_consultations WHERE consultation_id = NEW.consultation_id)
BEGIN
  SELECT RAISE(ABORT, 'advisor_consultations is append-only');
END;
