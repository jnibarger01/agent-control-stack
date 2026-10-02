-- Preserve scheduler capacity class when rebuilding admission state after restart.
ALTER TABLE admission_permits
  ADD COLUMN execution_class TEXT NOT NULL DEFAULT 'execution'
  CHECK (execution_class IN ('execution', 'wait'));
