CREATE TABLE change_set_revisions (
  mission_id TEXT NOT NULL REFERENCES work_items(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  submission_id TEXT NOT NULL,
  manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
  audit_event_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  parent_manifest_hash TEXT,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  created_by_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (mission_id, revision),
  UNIQUE (mission_id, submission_id),
  UNIQUE (mission_id, manifest_hash),
  UNIQUE (mission_id, revision, manifest_hash),
  CHECK ((revision = 1 AND parent_manifest_hash IS NULL) OR
         (revision > 1 AND parent_manifest_hash IS NOT NULL)),
  FOREIGN KEY (mission_id, parent_manifest_hash)
    REFERENCES change_set_revisions(mission_id, manifest_hash)
);

CREATE TABLE change_set_heads (
  mission_id TEXT PRIMARY KEY REFERENCES work_items(id),
  revision INTEGER NOT NULL,
  manifest_hash TEXT NOT NULL,
  FOREIGN KEY (mission_id, revision, manifest_hash)
    REFERENCES change_set_revisions(mission_id, revision, manifest_hash)
);

CREATE TRIGGER change_set_revisions_no_update BEFORE UPDATE ON change_set_revisions
BEGIN SELECT RAISE(ABORT, 'change set revisions are immutable'); END;
CREATE TRIGGER change_set_revisions_no_delete BEFORE DELETE ON change_set_revisions
BEGIN SELECT RAISE(ABORT, 'change set revisions are immutable'); END;
