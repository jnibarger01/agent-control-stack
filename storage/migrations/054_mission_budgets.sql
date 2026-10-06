-- Generalized mission budgets layered onto the existing coding-mission runtime.
-- The coding tables remain the compatibility storage contract; this table adds
-- durable cross-restart execution limits without introducing a second mission engine.
CREATE TABLE mission_budgets (
  mission_id TEXT PRIMARY KEY,
  max_iterations INTEGER NOT NULL CHECK (max_iterations BETWEEN 1 AND 100000),
  max_work_units INTEGER NOT NULL CHECK (max_work_units BETWEEN 1 AND 64),
  max_wall_time_ms INTEGER NOT NULL CHECK (max_wall_time_ms BETWEEN 1 AND 604800000),
  used_iterations INTEGER NOT NULL DEFAULT 0 CHECK (used_iterations >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES coding_missions (mission_id)
);

-- Existing coding missions receive the compatibility defaults. New missions are
-- inserted explicitly by CodingMissionStore so custom limits are durable.
INSERT INTO mission_budgets (
  mission_id, max_iterations, max_work_units, max_wall_time_ms, used_iterations, created_at, updated_at
)
SELECT mission_id, 256, 64, 86400000, 0, created_at, updated_at
FROM coding_missions;

CREATE INDEX mission_budgets_updated_idx ON mission_budgets (updated_at);
