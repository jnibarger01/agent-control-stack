INSERT OR IGNORE INTO agents
  (id, name, kind, acp_role, status, created_at, updated_at, created_by_actor_id, updated_by_actor_id)
VALUES
  ('muse-code', 'Muse', 'cli', 'LOCAL_CODING_AGENT', 'UNKNOWN',
   '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z', 'actor_system_bootstrap', 'actor_system_bootstrap');
