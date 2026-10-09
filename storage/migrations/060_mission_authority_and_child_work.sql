-- Mission authority envelopes, narrowed per-unit authority, and explicit child-result reduction.
--
-- A human approves a mission's authority once (mission_authority, write-once). Every work unit that is
-- created as child work receives an envelope derived from its parent's by intersection, never union
-- (work_unit_authority, write-once). A reducer's decision over a unit's children is recorded once
-- (work_unit_reductions), so the last child to finish can never silently overwrite the result.
-- All three tables are append-only. Missions without an envelope cannot create child work (fail closed).

CREATE TABLE mission_authority (
  mission_id TEXT PRIMARY KEY REFERENCES coding_missions (mission_id),
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
  envelope_hash TEXT NOT NULL CHECK (length(envelope_hash) = 64),
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  approver_id TEXT NOT NULL CHECK (length(approver_id) BETWEEN 1 AND 128),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 512),
  grant_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE work_unit_authority (
  mission_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  parent_unit_id TEXT,
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
  envelope_hash TEXT NOT NULL CHECK (length(envelope_hash) = 64),
  derived_from_hash TEXT NOT NULL CHECK (length(derived_from_hash) = 64),
  requested_json TEXT CHECK (requested_json IS NULL OR json_valid(requested_json)),
  purpose TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (mission_id, unit_id),
  FOREIGN KEY (mission_id, unit_id) REFERENCES coding_operations (mission_id, operation_id)
);

CREATE TABLE work_unit_reductions (
  mission_id TEXT NOT NULL,
  parent_unit_id TEXT NOT NULL,
  strategy TEXT NOT NULL CHECK (strategy IN ('all_succeeded', 'select', 'majority_result')),
  outcome TEXT NOT NULL CHECK (outcome IN ('reduced', 'failed', 'inconclusive')),
  selected_unit_id TEXT,
  result_hash TEXT,
  children_json TEXT NOT NULL CHECK (json_valid(children_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (mission_id, parent_unit_id),
  FOREIGN KEY (mission_id, parent_unit_id) REFERENCES coding_operations (mission_id, operation_id)
);

CREATE TRIGGER mission_authority_no_update BEFORE UPDATE ON mission_authority
BEGIN SELECT RAISE(ABORT, 'mission_authority: append-only'); END;
CREATE TRIGGER mission_authority_no_delete BEFORE DELETE ON mission_authority
BEGIN SELECT RAISE(ABORT, 'mission_authority: append-only'); END;
CREATE TRIGGER work_unit_authority_no_update BEFORE UPDATE ON work_unit_authority
BEGIN SELECT RAISE(ABORT, 'work_unit_authority: append-only'); END;
CREATE TRIGGER work_unit_authority_no_delete BEFORE DELETE ON work_unit_authority
BEGIN SELECT RAISE(ABORT, 'work_unit_authority: append-only'); END;
CREATE TRIGGER work_unit_reductions_no_update BEFORE UPDATE ON work_unit_reductions
BEGIN SELECT RAISE(ABORT, 'work_unit_reductions: append-only'); END;
CREATE TRIGGER work_unit_reductions_no_delete BEFORE DELETE ON work_unit_reductions
BEGIN SELECT RAISE(ABORT, 'work_unit_reductions: append-only'); END;
