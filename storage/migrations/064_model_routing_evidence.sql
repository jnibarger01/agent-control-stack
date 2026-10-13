-- Model and compute broker, slice 7.1: the evidence the broker routes on, and the rationale it records.
--
-- Three append-only tables. A routing decision records which providers and models were considered, which were rejected
-- and why, and what measured evidence ranked the rest. It never stores a prompt, only request metadata. An outcome is one
-- attempt against one provider and model (success or a classified failure, with measured latency, tokens and cost when
-- reported). A verification is a later, independent verdict on whether an outcome was actually correct; correctness
-- evidence counts only verified outcomes, and an unreported measurement is NULL, never zero.

CREATE TABLE model_route_decisions (
  decision_id TEXT PRIMARY KEY CHECK (length(decision_id) = 64),
  request_id TEXT NOT NULL UNIQUE CHECK (length(request_id) BETWEEN 1 AND 128),
  task_type TEXT NOT NULL CHECK (length(task_type) BETWEEN 1 AND 64),
  privacy TEXT NOT NULL CHECK (privacy IN ('public', 'internal', 'confidential', 'restricted')),
  mode TEXT NOT NULL CHECK (mode IN ('evidence', 'default_priority', 'last_resort', 'none')),
  chosen_provider TEXT,
  chosen_model TEXT,
  body_json TEXT NOT NULL CHECK (json_valid(body_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE model_route_outcomes (
  outcome_id TEXT PRIMARY KEY CHECK (length(outcome_id) = 64),
  decision_id TEXT NOT NULL REFERENCES model_route_decisions (decision_id),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 256),
  task_type TEXT NOT NULL CHECK (length(task_type) BETWEEN 1 AND 64),
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  failure_kind TEXT CHECK (failure_kind IS NULL OR failure_kind IN ('provider', 'request')),
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  tokens_in INTEGER CHECK (tokens_in IS NULL OR tokens_in >= 0),
  tokens_out INTEGER CHECK (tokens_out IS NULL OR tokens_out >= 0),
  cost_micro_usd INTEGER CHECK (cost_micro_usd IS NULL OR cost_micro_usd >= 0),
  recorded_at TEXT NOT NULL,
  UNIQUE (decision_id, attempt),
  CHECK ((ok = 1 AND failure_kind IS NULL) OR (ok = 0 AND failure_kind IS NOT NULL))
);

CREATE TABLE model_route_verifications (
  outcome_id TEXT PRIMARY KEY REFERENCES model_route_outcomes (outcome_id),
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  verifier TEXT NOT NULL CHECK (length(verifier) BETWEEN 1 AND 128),
  recorded_at TEXT NOT NULL
);

CREATE INDEX model_route_outcomes_key_idx ON model_route_outcomes (provider_id, model, task_type, recorded_at);
CREATE INDEX model_route_outcomes_provider_idx ON model_route_outcomes (provider_id, recorded_at);

-- Append-only. A BEFORE INSERT guard is also needed because INSERT OR REPLACE deletes the old row without firing DELETE
-- triggers. The guards abort on any duplicate key, so callers must check for existence instead of using INSERT OR IGNORE.
CREATE TRIGGER model_route_decisions_no_update BEFORE UPDATE ON model_route_decisions
BEGIN SELECT RAISE(ABORT, 'model_route_decisions: append-only'); END;
CREATE TRIGGER model_route_decisions_no_delete BEFORE DELETE ON model_route_decisions
BEGIN SELECT RAISE(ABORT, 'model_route_decisions: append-only'); END;
CREATE TRIGGER model_route_decisions_no_replace BEFORE INSERT ON model_route_decisions
WHEN EXISTS (SELECT 1 FROM model_route_decisions WHERE decision_id = NEW.decision_id OR request_id = NEW.request_id)
BEGIN SELECT RAISE(ABORT, 'model_route_decisions: append-only'); END;

CREATE TRIGGER model_route_outcomes_no_update BEFORE UPDATE ON model_route_outcomes
BEGIN SELECT RAISE(ABORT, 'model_route_outcomes: append-only'); END;
CREATE TRIGGER model_route_outcomes_no_delete BEFORE DELETE ON model_route_outcomes
BEGIN SELECT RAISE(ABORT, 'model_route_outcomes: append-only'); END;
CREATE TRIGGER model_route_outcomes_no_replace BEFORE INSERT ON model_route_outcomes
WHEN EXISTS (
  SELECT 1 FROM model_route_outcomes
  WHERE outcome_id = NEW.outcome_id OR (decision_id = NEW.decision_id AND attempt = NEW.attempt)
)
BEGIN SELECT RAISE(ABORT, 'model_route_outcomes: append-only'); END;

CREATE TRIGGER model_route_verifications_no_update BEFORE UPDATE ON model_route_verifications
BEGIN SELECT RAISE(ABORT, 'model_route_verifications: append-only'); END;
CREATE TRIGGER model_route_verifications_no_delete BEFORE DELETE ON model_route_verifications
BEGIN SELECT RAISE(ABORT, 'model_route_verifications: append-only'); END;
CREATE TRIGGER model_route_verifications_no_replace BEFORE INSERT ON model_route_verifications
WHEN EXISTS (SELECT 1 FROM model_route_verifications WHERE outcome_id = NEW.outcome_id)
BEGIN SELECT RAISE(ABORT, 'model_route_verifications: append-only'); END;
