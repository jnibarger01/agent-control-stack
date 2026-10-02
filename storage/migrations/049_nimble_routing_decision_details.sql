CREATE TABLE nimble_routing_decision_details (
  routing_decision_id TEXT PRIMARY KEY REFERENCES actor_routing_decisions(decision_id),
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  routing_generation INTEGER NOT NULL CHECK (routing_generation > 0),
  selected_agent_id TEXT NOT NULL REFERENCES agents(id),
  selected_worker_id TEXT NOT NULL CHECK (length(selected_worker_id) BETWEEN 1 AND 128),
  candidate_scores_json TEXT NOT NULL CHECK (json_valid(candidate_scores_json)),
  eligibility_evidence_json TEXT NOT NULL CHECK (json_valid(eligibility_evidence_json)),
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 128),
  model_version TEXT NOT NULL CHECK (length(model_version) BETWEEN 1 AND 128),
  selected_score REAL NOT NULL CHECK (selected_score >= 0 AND selected_score <= 1),
  threshold REAL NOT NULL CHECK (threshold >= 0 AND threshold <= 1),
  evaluated_at TEXT NOT NULL CHECK (julianday(evaluated_at) IS NOT NULL),
  algorithm_version TEXT NOT NULL CHECK (length(algorithm_version) BETWEEN 1 AND 128),
  correlation_id TEXT NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 128),
  UNIQUE (work_item_id, routing_generation)
);

CREATE TRIGGER work_item_assignments_no_update
BEFORE UPDATE ON work_item_assignments
BEGIN
  SELECT RAISE(ABORT, 'work_item_assignments: immutable');
END;

CREATE TRIGGER work_item_assignments_no_delete
BEFORE DELETE ON work_item_assignments
BEGIN
  SELECT RAISE(ABORT, 'work_item_assignments: immutable');
END;

CREATE TRIGGER nimble_routing_decision_details_no_update
BEFORE UPDATE ON nimble_routing_decision_details
BEGIN
  SELECT RAISE(ABORT, 'nimble_routing_decision_details: append-only');
END;

CREATE TRIGGER nimble_routing_decision_details_no_delete
BEFORE DELETE ON nimble_routing_decision_details
BEGIN
  SELECT RAISE(ABORT, 'nimble_routing_decision_details: append-only');
END;
