-- Advisor consultation evidence (ADR 0027).
-- Bindings can be disabled. Consultation rows are append-only evidence.
-- Guidance text is stored for the executor and is not an authority input.

CREATE TABLE advisor_bindings (
  subject_id TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 256),
  mission_id TEXT NOT NULL CHECK (length(mission_id) BETWEEN 1 AND 128),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('work_item', 'mission_unit')),
  executor_model_id TEXT NOT NULL CHECK (length(executor_model_id) BETWEEN 1 AND 128),
  advisor_model_id TEXT NOT NULL CHECK (length(advisor_model_id) BETWEEN 1 AND 128),
  advisor_transport_model TEXT NOT NULL CHECK (length(advisor_transport_model) BETWEEN 1 AND 256),
  require_before_completion INTEGER NOT NULL CHECK (require_before_completion IN (0, 1)),
  created_at TEXT NOT NULL,
  disabled_at TEXT,
  PRIMARY KEY (mission_id, subject_id)
);

CREATE TABLE advisor_consultations (
  consultation_id TEXT PRIMARY KEY CHECK (length(consultation_id) BETWEEN 1 AND 128),
  consultation_hash TEXT NOT NULL CHECK (length(consultation_hash) = 64),
  subject_id TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 256),
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
  created_at TEXT NOT NULL
);

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
