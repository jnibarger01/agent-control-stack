-- Durable, immutable per-work-unit authority (request_child_work).
--
-- One row per work unit that carries authority. A 'root' row binds a top-level unit to a human-issued
-- autonomous_authority_grants row (migration 047) and can only be written by the operator-side bind path
-- (bound_by_actor_id is mandatory). A 'child' row is written only by the transactional request_child_work path and
-- stores the NARROWED definition the child may use, its parent authority row, the shared root grant, and the
-- requester's claim evidence (worker, attempt, a hash of the claim token; the raw token is never stored).
--
-- Agent-requested child work can therefore never create or widen a root: the only way to a root row is a grant that a
-- human issued, and every child row must chain to a parent row in the same mission with the same root grant.
-- The subset check (child definition within parent definition) runs in TypeScript in the same IMMEDIATE transaction as
-- the insert; the database enforces the structure and immutability, and that a child cannot outlive its parent.
--
-- Rows are append-only. An executing actor at claim time is read from this table, never inherited from the parent.

CREATE TABLE work_unit_authority (
  authority_id TEXT PRIMARY KEY CHECK (length(authority_id) BETWEEN 1 AND 128),
  mission_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('root', 'child')),
  parent_authority_id TEXT REFERENCES work_unit_authority (authority_id),
  root_grant_id TEXT NOT NULL REFERENCES autonomous_authority_grants (grant_id),
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  definition_hash TEXT NOT NULL CHECK (length(definition_hash) = 64),
  executing_actor_id TEXT NOT NULL CHECK (length(executing_actor_id) BETWEEN 1 AND 256),
  expires_at TEXT NOT NULL CHECK (julianday(expires_at) IS NOT NULL),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  purpose TEXT,
  work_type TEXT,
  requested_by_unit_id TEXT,
  requested_by_worker_id TEXT,
  requested_by_attempt INTEGER,
  requested_claim_hash TEXT,
  bound_by_actor_id TEXT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (mission_id, unit_id),
  UNIQUE (mission_id, request_id),
  FOREIGN KEY (mission_id, unit_id) REFERENCES coding_operations (mission_id, operation_id),
  CHECK ((kind = 'root') = (parent_authority_id IS NULL)),
  CHECK (
    kind = 'root'
    OR (
      requested_by_unit_id IS NOT NULL
      AND requested_by_worker_id IS NOT NULL
      AND requested_by_attempt IS NOT NULL
      AND requested_claim_hash IS NOT NULL
      AND length(requested_claim_hash) = 64
    )
  ),
  CHECK (kind = 'child' OR (bound_by_actor_id IS NOT NULL AND length(bound_by_actor_id) > 0))
);

CREATE INDEX idx_work_unit_authority_parent ON work_unit_authority (parent_authority_id);
CREATE INDEX idx_work_unit_authority_grant ON work_unit_authority (root_grant_id);

CREATE TRIGGER work_unit_authority_root_guard
BEFORE INSERT ON work_unit_authority
WHEN NEW.kind = 'root'
BEGIN
  SELECT RAISE(ABORT, 'root authority can only bind a top-level work unit')
  WHERE EXISTS (
    SELECT 1 FROM coding_operations o
    WHERE o.mission_id = NEW.mission_id AND o.operation_id = NEW.unit_id AND o.parent_unit_id IS NOT NULL
  );
END;

CREATE TRIGGER work_unit_authority_child_guard
BEFORE INSERT ON work_unit_authority
WHEN NEW.kind = 'child'
BEGIN
  SELECT RAISE(ABORT, 'child authority needs a parent authority in the same mission and root grant')
  WHERE NOT EXISTS (
    SELECT 1 FROM work_unit_authority p
    WHERE p.authority_id = NEW.parent_authority_id
      AND p.mission_id = NEW.mission_id
      AND p.root_grant_id = NEW.root_grant_id
  );
  SELECT RAISE(ABORT, 'child authority unit must be a child of the parent authority unit')
  WHERE NOT EXISTS (
    SELECT 1
    FROM work_unit_authority p
    JOIN coding_operations o ON o.mission_id = NEW.mission_id AND o.operation_id = NEW.unit_id
    WHERE p.authority_id = NEW.parent_authority_id AND o.parent_unit_id = p.unit_id
  );
  SELECT RAISE(ABORT, 'child authority cannot outlive its parent')
  WHERE EXISTS (
    SELECT 1 FROM work_unit_authority p
    WHERE p.authority_id = NEW.parent_authority_id AND julianday(NEW.expires_at) > julianday(p.expires_at)
  );
END;

CREATE TRIGGER work_unit_authority_no_update BEFORE UPDATE ON work_unit_authority
BEGIN SELECT RAISE(ABORT, 'work unit authority is immutable'); END;
CREATE TRIGGER work_unit_authority_no_delete BEFORE DELETE ON work_unit_authority
BEGIN SELECT RAISE(ABORT, 'work unit authority is immutable'); END;
