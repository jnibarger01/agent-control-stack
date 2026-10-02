-- Authoritative Nimble routing evidence and execution outcomes.
-- actor_routing_decisions stays append-only and compatible with migration 013.
-- Evidence and outcomes are separate append-only rows keyed by that decision id.

CREATE TABLE IF NOT EXISTS actor_routing_evidence (
  decision_id TEXT PRIMARY KEY REFERENCES actor_routing_decisions(decision_id),
  mission_id TEXT,
  operation_id TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('route', 'fallback', 'reject')),
  source TEXT NOT NULL CHECK (source IN ('nimble', 'deterministic_fallback')),
  reason_code TEXT NOT NULL,
  fallback_reason TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  model TEXT,
  lane TEXT,
  router_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  candidate_json TEXT NOT NULL CHECK (json_valid(candidate_json)),
  constraints_json TEXT NOT NULL CHECK (json_valid(constraints_json)),
  normalized_decision_json TEXT NOT NULL CHECK (json_valid(normalized_decision_json)),
  supersedes_decision_id TEXT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_actor_routing_evidence_operation
  ON actor_routing_evidence(operation_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS actor_routing_evidence_no_update
BEFORE UPDATE ON actor_routing_evidence
BEGIN
  SELECT RAISE(ABORT, 'actor_routing_evidence: append-only');
END;

CREATE TRIGGER IF NOT EXISTS actor_routing_evidence_no_delete
BEFORE DELETE ON actor_routing_evidence
BEGIN
  SELECT RAISE(ABORT, 'actor_routing_evidence: append-only');
END;

CREATE TABLE IF NOT EXISTS routing_execution_outcomes (
  outcome_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES actor_routing_decisions(decision_id),
  executor_id TEXT NOT NULL,
  model TEXT,
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  timed_out INTEGER NOT NULL CHECK (timed_out IN (0, 1)),
  verification_result TEXT,
  tests_result TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_routing_execution_outcomes_decision
  ON routing_execution_outcomes(decision_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS routing_execution_outcomes_no_update
BEFORE UPDATE ON routing_execution_outcomes
BEGIN
  SELECT RAISE(ABORT, 'routing_execution_outcomes: append-only');
END;

CREATE TRIGGER IF NOT EXISTS routing_execution_outcomes_no_delete
BEFORE DELETE ON routing_execution_outcomes
BEGIN
  SELECT RAISE(ABORT, 'routing_execution_outcomes: append-only');
END;
