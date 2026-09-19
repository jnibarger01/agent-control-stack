-- Native routing authority is distinct from legacy actor routing. Records are append-only.
CREATE TABLE IF NOT EXISTS mission_intake_records (
  intake_hash TEXT PRIMARY KEY CHECK (length(intake_hash) = 64),
  schema_version TEXT NOT NULL CHECK (schema_version = 'acs.mission-intake.v1'),
  canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json)),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mission_classifier_evidence_records (
  evidence_hash TEXT PRIMARY KEY CHECK (length(evidence_hash) = 64),
  intake_hash TEXT NOT NULL REFERENCES mission_intake_records(intake_hash),
  schema_version TEXT NOT NULL CHECK (schema_version = 'acs.classifier-evidence.v1'),
  canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json)),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mission_route_evidence_records (
  route_evidence_hash TEXT PRIMARY KEY CHECK (length(route_evidence_hash) = 64),
  intake_hash TEXT NOT NULL REFERENCES mission_intake_records(intake_hash),
  classifier_evidence_hash TEXT NOT NULL REFERENCES mission_classifier_evidence_records(evidence_hash),
  route_table_version TEXT NOT NULL CHECK (route_table_version = 'acs.native-route-table.v1'),
  route_table_hash TEXT NOT NULL CHECK (length(route_table_hash) = 64),
  decision TEXT NOT NULL CHECK (decision IN ('routed', 'blocked')),
  engine_id TEXT,
  canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json)),
  created_at TEXT NOT NULL,
  CHECK ((decision = 'routed' AND engine_id IS NOT NULL) OR (decision = 'blocked' AND engine_id IS NULL))
);
CREATE TABLE IF NOT EXISTS work_item_mission_routing (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(id),
  intake_hash TEXT NOT NULL REFERENCES mission_intake_records(intake_hash),
  classifier_evidence_hash TEXT NOT NULL REFERENCES mission_classifier_evidence_records(evidence_hash),
  route_evidence_hash TEXT NOT NULL UNIQUE REFERENCES mission_route_evidence_records(route_evidence_hash),
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS mission_intake_records_no_update BEFORE UPDATE ON mission_intake_records BEGIN SELECT RAISE(ABORT, 'mission intake records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS mission_intake_records_no_delete BEFORE DELETE ON mission_intake_records BEGIN SELECT RAISE(ABORT, 'mission intake records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS mission_classifier_evidence_records_no_update BEFORE UPDATE ON mission_classifier_evidence_records BEGIN SELECT RAISE(ABORT, 'classifier evidence records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS mission_classifier_evidence_records_no_delete BEFORE DELETE ON mission_classifier_evidence_records BEGIN SELECT RAISE(ABORT, 'classifier evidence records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS mission_route_evidence_records_no_update BEFORE UPDATE ON mission_route_evidence_records BEGIN SELECT RAISE(ABORT, 'route evidence records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS mission_route_evidence_records_no_delete BEFORE DELETE ON mission_route_evidence_records BEGIN SELECT RAISE(ABORT, 'route evidence records are append-only'); END;
