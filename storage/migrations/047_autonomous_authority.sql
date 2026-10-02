CREATE TABLE autonomous_authority_grants (
  grant_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES work_items(id),
  request_id TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  grant_hash TEXT NOT NULL CHECK (length(grant_hash) = 64),
  audit_event_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  UNIQUE (mission_id, request_id)
);
CREATE TABLE autonomous_authority_revocations (
  grant_id TEXT PRIMARY KEY REFERENCES autonomous_authority_grants(grant_id),
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  audit_event_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id)
);
CREATE TABLE change_set_grant_authorizations (
  authorization_id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES autonomous_authority_grants(grant_id),
  mission_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  manifest_hash TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  authorization_hash TEXT NOT NULL CHECK (length(authorization_hash) = 64),
  audit_event_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  UNIQUE (grant_id, manifest_hash),
  FOREIGN KEY (mission_id, revision, manifest_hash)
    REFERENCES change_set_revisions(mission_id, revision, manifest_hash)
);
CREATE TRIGGER autonomous_authority_grants_no_update BEFORE UPDATE ON autonomous_authority_grants
BEGIN SELECT RAISE(ABORT, 'autonomous authority grants are immutable'); END;
CREATE TRIGGER autonomous_authority_grants_no_delete BEFORE DELETE ON autonomous_authority_grants
BEGIN SELECT RAISE(ABORT, 'autonomous authority grants are immutable'); END;
CREATE TRIGGER autonomous_authority_revocations_no_update BEFORE UPDATE ON autonomous_authority_revocations
BEGIN SELECT RAISE(ABORT, 'autonomous authority revocations are immutable'); END;
CREATE TRIGGER autonomous_authority_revocations_no_delete BEFORE DELETE ON autonomous_authority_revocations
BEGIN SELECT RAISE(ABORT, 'autonomous authority revocations are immutable'); END;
CREATE TRIGGER change_set_grant_authorizations_no_update BEFORE UPDATE ON change_set_grant_authorizations
BEGIN SELECT RAISE(ABORT, 'grant authorizations are immutable'); END;
CREATE TRIGGER change_set_grant_authorizations_no_delete BEFORE DELETE ON change_set_grant_authorizations
BEGIN SELECT RAISE(ABORT, 'grant authorizations are immutable'); END;
