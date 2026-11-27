-- Add the read-only Herdr Core tools to the durable Jace Commander tool
-- allowlist. These tools are capability-only: ACS must issue an acs.jc.v1
-- capability before Jace Commander may run them. They do not require approval,
-- so the append-only issuance CHECK in migration 078 is unchanged.
INSERT OR IGNORE INTO jace_commander_tools (tool_name, added_in_migration) VALUES
  ('herdr_status', 84),
  ('herdr_terminals', 84),
  ('herdr_read', 84);
