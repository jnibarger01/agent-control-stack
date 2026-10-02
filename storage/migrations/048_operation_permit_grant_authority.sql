DROP TRIGGER change_set_operation_permits_no_update;
DROP TRIGGER change_set_operation_permits_no_delete;
ALTER TABLE change_set_operation_permits RENAME TO change_set_operation_permits_previous;
CREATE TABLE change_set_operation_permits (
  permit_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  manifest_hash TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  approval_id TEXT REFERENCES change_set_approvals(approval_id),
  authorization_id TEXT REFERENCES change_set_grant_authorizations(authorization_id),
  execution_work_item_id TEXT NOT NULL UNIQUE REFERENCES work_items(id),
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  permit_hash TEXT NOT NULL CHECK (length(permit_hash) = 64),
  audit_event_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  CHECK ((approval_id IS NOT NULL AND authorization_id IS NULL) OR
         (approval_id IS NULL AND authorization_id IS NOT NULL)),
  UNIQUE (mission_id, manifest_hash, operation_id),
  FOREIGN KEY (mission_id, revision, manifest_hash)
    REFERENCES change_set_revisions(mission_id, revision, manifest_hash)
);
INSERT INTO change_set_operation_permits
  (permit_id,mission_id,revision,manifest_hash,operation_id,approval_id,authorization_id,execution_work_item_id,record_json,permit_hash,audit_event_id)
SELECT permit_id,mission_id,revision,manifest_hash,operation_id,approval_id,NULL,execution_work_item_id,record_json,permit_hash,audit_event_id
FROM change_set_operation_permits_previous;
DROP TABLE change_set_operation_permits_previous;
CREATE INDEX change_set_operation_permits_authorization ON change_set_operation_permits(authorization_id);
CREATE TRIGGER change_set_operation_permits_no_update BEFORE UPDATE ON change_set_operation_permits
BEGIN SELECT RAISE(ABORT, 'change set operation permits are immutable'); END;
CREATE TRIGGER change_set_operation_permits_no_delete BEFORE DELETE ON change_set_operation_permits
BEGIN SELECT RAISE(ABORT, 'change set operation permits are immutable'); END;
