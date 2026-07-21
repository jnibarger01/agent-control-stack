CREATE TRIGGER IF NOT EXISTS work_items_state_guard_insert
BEFORE INSERT ON work_items
BEGIN
  SELECT RAISE(ABORT, 'work_items: invalid status')
    WHERE NEW.status IS NULL OR NEW.status NOT IN ('draft', 'pending_policy', 'needs_approval', 'approved', 'running', 'succeeded', 'failed', 'blocked', 'cancelled', 'rejected');
  SELECT RAISE(ABORT, 'work_items: invalid risk')
    WHERE NEW.risk IS NULL OR NEW.risk NOT IN ('low', 'medium', 'high', 'critical');
  SELECT RAISE(ABORT, 'work_items: target_json must be valid JSON')
    WHERE NEW.target_json IS NULL OR json_valid(NEW.target_json) = 0;
  SELECT RAISE(ABORT, 'work_items: requested_actions_json must be valid JSON')
    WHERE NEW.requested_actions_json IS NULL OR json_valid(NEW.requested_actions_json) = 0;
  SELECT RAISE(ABORT, 'work_items: result_json must be valid JSON')
    WHERE NEW.result_json IS NOT NULL AND json_valid(NEW.result_json) = 0;
END;

CREATE TRIGGER IF NOT EXISTS work_items_state_guard_update
BEFORE UPDATE ON work_items
BEGIN
  SELECT RAISE(ABORT, 'work_items: invalid status')
    WHERE NEW.status IS NULL OR NEW.status NOT IN ('draft', 'pending_policy', 'needs_approval', 'approved', 'running', 'succeeded', 'failed', 'blocked', 'cancelled', 'rejected');
  SELECT RAISE(ABORT, 'work_items: invalid risk')
    WHERE NEW.risk IS NULL OR NEW.risk NOT IN ('low', 'medium', 'high', 'critical');
  SELECT RAISE(ABORT, 'work_items: target_json must be valid JSON')
    WHERE NEW.target_json IS NULL OR json_valid(NEW.target_json) = 0;
  SELECT RAISE(ABORT, 'work_items: requested_actions_json must be valid JSON')
    WHERE NEW.requested_actions_json IS NULL OR json_valid(NEW.requested_actions_json) = 0;
  SELECT RAISE(ABORT, 'work_items: result_json must be valid JSON')
    WHERE NEW.result_json IS NOT NULL AND json_valid(NEW.result_json) = 0;
END;

CREATE TRIGGER IF NOT EXISTS approval_records_state_guard_insert
BEFORE INSERT ON approval_records
BEGIN
  SELECT RAISE(ABORT, 'approval_records: invalid status')
    WHERE NEW.status IS NULL OR NEW.status NOT IN ('granted', 'consumed');
END;

CREATE TRIGGER IF NOT EXISTS approval_records_state_guard_update
BEFORE UPDATE ON approval_records
BEGIN
  SELECT RAISE(ABORT, 'approval_records: invalid status')
    WHERE NEW.status IS NULL OR NEW.status NOT IN ('granted', 'consumed');
END;

CREATE TRIGGER IF NOT EXISTS connector_records_state_guard_insert
BEFORE INSERT ON connector_records
BEGIN
  SELECT RAISE(ABORT, 'connector_records: invalid status')
    WHERE NEW.status IS NULL OR NEW.status NOT IN ('active', 'revoked');
  SELECT RAISE(ABORT, 'connector_records: allowed_scopes_json must be valid JSON')
    WHERE NEW.allowed_scopes_json IS NULL OR json_valid(NEW.allowed_scopes_json) = 0;
END;

CREATE TRIGGER IF NOT EXISTS connector_records_state_guard_update
BEFORE UPDATE ON connector_records
BEGIN
  SELECT RAISE(ABORT, 'connector_records: invalid status')
    WHERE NEW.status IS NULL OR NEW.status NOT IN ('active', 'revoked');
  SELECT RAISE(ABORT, 'connector_records: allowed_scopes_json must be valid JSON')
    WHERE NEW.allowed_scopes_json IS NULL OR json_valid(NEW.allowed_scopes_json) = 0;
END;

CREATE TRIGGER IF NOT EXISTS tunnel_sessions_state_guard_insert
BEFORE INSERT ON tunnel_sessions
BEGIN
  SELECT RAISE(ABORT, 'tunnel_sessions: invalid status')
    WHERE NEW.status IS NULL OR NEW.status NOT IN ('active', 'revoked');
END;

CREATE TRIGGER IF NOT EXISTS tunnel_sessions_state_guard_update
BEFORE UPDATE ON tunnel_sessions
BEGIN
  SELECT RAISE(ABORT, 'tunnel_sessions: invalid status')
    WHERE NEW.status IS NULL OR NEW.status NOT IN ('active', 'revoked');
END;

CREATE TRIGGER IF NOT EXISTS agents_state_guard_insert
BEFORE INSERT ON agents
BEGIN
  SELECT RAISE(ABORT, 'agents: invalid status')
    WHERE NEW.status IS NULL OR NEW.status NOT IN ('UNKNOWN', 'AVAILABLE', 'BUSY', 'DEGRADED', 'OFFLINE', 'ERROR');
END;

CREATE TRIGGER IF NOT EXISTS agents_state_guard_update
BEFORE UPDATE ON agents
BEGIN
  SELECT RAISE(ABORT, 'agents: invalid status')
    WHERE NEW.status IS NULL OR NEW.status NOT IN ('UNKNOWN', 'AVAILABLE', 'BUSY', 'DEGRADED', 'OFFLINE', 'ERROR');
END;

CREATE TRIGGER IF NOT EXISTS heartbeats_state_guard_insert
BEFORE INSERT ON heartbeats
BEGIN
  SELECT RAISE(ABORT, 'heartbeats: invalid status')
    WHERE NEW.status IS NULL OR NEW.status NOT IN ('UNKNOWN', 'AVAILABLE', 'BUSY', 'DEGRADED', 'OFFLINE', 'ERROR');
END;

CREATE TRIGGER IF NOT EXISTS audit_events_json_guard_insert
BEFORE INSERT ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events: attributes must be valid JSON')
    WHERE NEW.attributes IS NULL OR json_valid(NEW.attributes) = 0;
  SELECT RAISE(ABORT, 'audit_events: body must be valid JSON')
    WHERE NEW.body IS NULL OR json_valid(NEW.body) = 0;
END;

CREATE TRIGGER IF NOT EXISTS audit_events_json_guard_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events: attributes must be valid JSON')
    WHERE NEW.attributes IS NULL OR json_valid(NEW.attributes) = 0;
  SELECT RAISE(ABORT, 'audit_events: body must be valid JSON')
    WHERE NEW.body IS NULL OR json_valid(NEW.body) = 0;
END;
