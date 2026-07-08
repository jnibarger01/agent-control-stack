CREATE INDEX IF NOT EXISTS idx_audit_events_sequence ON audit_events(sequence);
CREATE INDEX IF NOT EXISTS idx_audit_events_time ON audit_events(time_unix_nano);
CREATE INDEX IF NOT EXISTS idx_audit_events_name ON audit_events(name);
CREATE INDEX IF NOT EXISTS idx_audit_events_work_item_id ON audit_events(json_extract(attributes, '$."work_item.id"'));
CREATE INDEX IF NOT EXISTS idx_audit_events_agent_id ON audit_events(json_extract(attributes, '$."agent.id"'));
CREATE INDEX IF NOT EXISTS idx_audit_events_worker_id ON audit_events(json_extract(attributes, '$."worker.id"'));
CREATE INDEX IF NOT EXISTS idx_audit_events_connector_id ON audit_events(json_extract(attributes, '$."connector.id"'));
CREATE INDEX IF NOT EXISTS idx_audit_events_auth_connector_id ON audit_events(json_extract(attributes, '$."auth.connector_id"'));
