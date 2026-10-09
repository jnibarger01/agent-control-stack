-- Mission authority, narrowed per-unit authority, and explicit child-result reduction.
--
-- A human approves a mission's authority once, as an autonomous authority grant (migration 047). mission_authority binds
-- the mission to that grant (write-once) and snapshots its definition so later reads can be integrity-checked. Every work
-- unit created as child work receives a definition derived from its parent's by intersection, never union
-- (work_unit_authority, write-once, with the grant it traces back to). A reducer's decision over a unit's children is
-- recorded once (work_unit_reductions), so the last child to finish can never silently overwrite the result.
-- All three tables are append-only. Missions without an authority binding cannot create child work (fail closed).

CREATE TABLE mission_authority (
  mission_id TEXT PRIMARY KEY REFERENCES coding_missions (mission_id),
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
  envelope_hash TEXT NOT NULL CHECK (length(envelope_hash) = 64),
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  approver_id TEXT NOT NULL CHECK (length(approver_id) BETWEEN 1 AND 256),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 4000),
  grant_id TEXT NOT NULL CHECK (length(grant_id) BETWEEN 1 AND 256),
  grant_hash TEXT NOT NULL CHECK (length(grant_hash) = 64),
  policy_approved_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE work_unit_authority (
  mission_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  parent_unit_id TEXT,
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
  envelope_hash TEXT NOT NULL CHECK (length(envelope_hash) = 64),
  derived_from_hash TEXT NOT NULL CHECK (length(derived_from_hash) = 64),
  grant_id TEXT NOT NULL CHECK (length(grant_id) BETWEEN 1 AND 256),
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

-- INSERT OR REPLACE resolves a key conflict by deleting the old row without firing DELETE triggers (recursive_triggers
-- is off), so write-once also needs a BEFORE INSERT guard. It fires before conflict resolution and refuses any insert
-- whose key already exists, which closes REPLACE as well as a plain duplicate.
CREATE TRIGGER mission_authority_write_once BEFORE INSERT ON mission_authority
WHEN EXISTS (SELECT 1 FROM mission_authority WHERE mission_id = NEW.mission_id)
BEGIN SELECT RAISE(ABORT, 'mission_authority: append-only'); END;
CREATE TRIGGER work_unit_authority_write_once BEFORE INSERT ON work_unit_authority
WHEN EXISTS (SELECT 1 FROM work_unit_authority WHERE mission_id = NEW.mission_id AND unit_id = NEW.unit_id)
BEGIN SELECT RAISE(ABORT, 'work_unit_authority: append-only'); END;
CREATE TRIGGER work_unit_reductions_write_once BEFORE INSERT ON work_unit_reductions
WHEN EXISTS (SELECT 1 FROM work_unit_reductions WHERE mission_id = NEW.mission_id AND parent_unit_id = NEW.parent_unit_id)
BEGIN SELECT RAISE(ABORT, 'work_unit_reductions: append-only'); END;

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
