CREATE TABLE IF NOT EXISTS actors (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('HUMAN', 'SYSTEM', 'AGENT', 'SERVICE')),
  display_name TEXT NOT NULL,
  external_ref TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  kind TEXT NOT NULL,
  acp_role TEXT NOT NULL CHECK (acp_role IN (
    'IMPLEMENTATION_AGENT',
    'REVIEW_PLANNING_AGENT',
    'RESEARCH_BROAD_SCAN_AGENT',
    'LOCAL_CODING_AGENT',
    'ORCHESTRATION_LAYER',
    'DESKTOP_LOCAL_AGENT_BRIDGE'
  )),
  provider TEXT,
  model TEXT,
  endpoint TEXT,
  status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (status IN ('UNKNOWN', 'AVAILABLE', 'BUSY', 'DEGRADED', 'OFFLINE', 'ERROR')),
  last_heartbeat_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id)
);

CREATE INDEX IF NOT EXISTS idx_agents_acp_role ON agents(acp_role);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);

CREATE TRIGGER IF NOT EXISTS agents_immutable_guard
BEFORE UPDATE ON agents
WHEN NEW.id IS NOT OLD.id
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.created_by_actor_id IS NOT OLD.created_by_actor_id
BEGIN
  SELECT RAISE(ABORT, 'agents: immutable field modified (id, created_at, created_by_actor_id)');
END;

CREATE TABLE IF NOT EXISTS capabilities (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  input_schema TEXT CHECK (input_schema IS NULL OR json_valid(input_schema)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  UNIQUE (agent_id, name)
);

CREATE TABLE IF NOT EXISTS heartbeats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('UNKNOWN', 'AVAILABLE', 'BUSY', 'DEGRADED', 'OFFLINE', 'ERROR')),
  current_task TEXT,
  last_error TEXT,
  observed_at TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES actors(id)
);

CREATE INDEX IF NOT EXISTS idx_heartbeats_agent_observed ON heartbeats(agent_id, observed_at DESC);

CREATE TRIGGER IF NOT EXISTS heartbeats_append_only_update
BEFORE UPDATE ON heartbeats
BEGIN
  SELECT RAISE(ABORT, 'heartbeats: append-only (UPDATE blocked)');
END;

CREATE TRIGGER IF NOT EXISTS heartbeats_append_only_delete
BEFORE DELETE ON heartbeats
BEGIN
  SELECT RAISE(ABORT, 'heartbeats: append-only (DELETE blocked)');
END;

INSERT OR IGNORE INTO actors (id, actor_type, display_name, external_ref, created_at)
VALUES ('actor_system_bootstrap', 'SYSTEM', 'ACS bootstrap seed', 'migration:002_agent_registry', '2026-07-07T00:00:00.000Z');

INSERT OR IGNORE INTO agents
  (id, name, kind, acp_role, status, created_at, updated_at, created_by_actor_id, updated_by_actor_id)
VALUES
  ('codex-cli', 'Codex CLI', 'cli', 'IMPLEMENTATION_AGENT', 'UNKNOWN',
   '2026-07-07T00:00:00.000Z', '2026-07-07T00:00:00.000Z', 'actor_system_bootstrap', 'actor_system_bootstrap'),
  ('claude-code', 'Claude Code / Claude adapter', 'adapter', 'REVIEW_PLANNING_AGENT', 'UNKNOWN',
   '2026-07-07T00:00:00.000Z', '2026-07-07T00:00:00.000Z', 'actor_system_bootstrap', 'actor_system_bootstrap'),
  ('gemini-cli', 'Gemini CLI', 'cli', 'RESEARCH_BROAD_SCAN_AGENT', 'UNKNOWN',
   '2026-07-07T00:00:00.000Z', '2026-07-07T00:00:00.000Z', 'actor_system_bootstrap', 'actor_system_bootstrap'),
  ('opencode-local', 'OpenCode', 'cli', 'LOCAL_CODING_AGENT', 'UNKNOWN',
   '2026-07-07T00:00:00.000Z', '2026-07-07T00:00:00.000Z', 'actor_system_bootstrap', 'actor_system_bootstrap'),
  ('hermes-local', 'Hermes Agent', 'service', 'ORCHESTRATION_LAYER', 'UNKNOWN',
   '2026-07-07T00:00:00.000Z', '2026-07-07T00:00:00.000Z', 'actor_system_bootstrap', 'actor_system_bootstrap'),
  ('openclaw-bridge', 'OpenClaw', 'bridge', 'DESKTOP_LOCAL_AGENT_BRIDGE', 'UNKNOWN',
   '2026-07-07T00:00:00.000Z', '2026-07-07T00:00:00.000Z', 'actor_system_bootstrap', 'actor_system_bootstrap');
