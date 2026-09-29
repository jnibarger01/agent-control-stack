-- 030_jace_commander_search_tools
-- Read-only search tools. The allowlist remains the lookup table from 029.

INSERT OR IGNORE INTO jace_commander_tools (tool_name, added_in_migration) VALUES
  ('start_search', 30),
  ('get_more_search_results', 30),
  ('list_searches', 30),
  ('stop_search', 30);
