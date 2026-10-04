-- Record whether an admin-mode row was explicitly set under sticky semantics.
--
-- Admin execution mode is sticky by default: it persists until an operator
-- explicitly disables it. But an admin row written by an EARLIER release was
-- time-boxed (the former one-hour default). Without a marker, upgrading would
-- silently reinterpret a previously bounded elevation as indefinite.
--
-- sticky_admin:
--   1 = explicitly set under sticky semantics -> honors the no-expiry default
--   0 or NULL = legacy bounded row            -> keeps the former one-hour bound
--
-- Existing rows are deliberately left NULL: an elevation that was authorized
-- while time-boxed must not silently become permanent on upgrade. Only admin
-- modes enabled after this migration are marked sticky. Forward-only.

ALTER TABLE execution_mode_state ADD COLUMN sticky_admin INTEGER;

CREATE INDEX IF NOT EXISTS idx_execution_mode_sticky
  ON execution_mode_state (id)
  WHERE sticky_admin = 1;