-- 075_jace_commander_context_pack
-- Read-only context pack assembly (files and inline text, no writes). The allowlist row is the only change.

INSERT OR IGNORE INTO jace_commander_tools (tool_name, added_in_migration) VALUES ('context_pack', 75);
