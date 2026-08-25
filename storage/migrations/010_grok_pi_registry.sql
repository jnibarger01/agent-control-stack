INSERT OR IGNORE INTO agents
  (id, name, kind, acp_role, status, created_at, updated_at, created_by_actor_id, updated_by_actor_id)
VALUES
  ('grok-cli', 'Grok CLI', 'cli', 'RESEARCH_BROAD_SCAN_AGENT', 'UNKNOWN',
   '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z', 'actor_system_bootstrap', 'actor_system_bootstrap'),
  ('pi-cli', 'Pi CLI', 'cli', 'REVIEW_PLANNING_AGENT', 'UNKNOWN',
   '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z', 'actor_system_bootstrap', 'actor_system_bootstrap');
