-- Canonical execution-mode state. One row, one authority.
-- strict is the default. Admin is an explicit, audited policy change.
-- This is not break-glass and not an executor bypass.
-- Forward-only: do not alter historical migrations.

CREATE TABLE IF NOT EXISTS execution_mode_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL CHECK (mode IN ('strict', 'admin')),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  reason TEXT NOT NULL
);

INSERT INTO execution_mode_state (id, mode, updated_at, updated_by, reason)
VALUES (1, 'strict', '1970-01-01T00:00:00.000Z', 'system', 'default strict')
ON CONFLICT (id) DO NOTHING;
