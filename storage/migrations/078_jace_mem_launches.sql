-- Jace-Mem (acs.jm.v1) trusted launch registry and runtime identity attestation (JM-ACS-02).
--
-- jace_mem_launches: registered once by the trusted launcher at gateway boot. HTTP and MCP callers cannot
-- insert or rebind them. The launch's full subject is stored only as a hash.
-- jace_mem_launch_challenges: single-use bootstrap challenges (hash only), at most 120 s.
-- jace_mem_launch_attestations: proof that the Jace-Mem process answered a challenge over the bridge's private
-- stdio with exactly the launch's runtime, subject and verification-config fingerprint. Issuance requires one.
-- All three tables are append-only apart from consuming a challenge. Forward-only.

CREATE TABLE IF NOT EXISTS jace_mem_launches (
  launch_id TEXT PRIMARY KEY CHECK (length(launch_id) BETWEEN 1 AND 128),
  runtime_id TEXT NOT NULL CHECK (length(runtime_id) BETWEEN 1 AND 128),
  subject_hash TEXT NOT NULL CHECK (length(subject_hash) = 64 AND subject_hash = lower(subject_hash)),
  registered_at TEXT NOT NULL CHECK (julianday(registered_at) IS NOT NULL)
);
CREATE TRIGGER IF NOT EXISTS jace_mem_launches_no_change BEFORE UPDATE ON jace_mem_launches
  BEGIN SELECT RAISE(ABORT, 'jace_mem_launches: immutable'); END;
CREATE TRIGGER IF NOT EXISTS jace_mem_launches_no_delete BEFORE DELETE ON jace_mem_launches
  BEGIN SELECT RAISE(ABORT, 'jace_mem_launches: immutable'); END;

CREATE TABLE IF NOT EXISTS jace_mem_launch_challenges (
  challenge_hash TEXT PRIMARY KEY CHECK (length(challenge_hash) = 64 AND challenge_hash = lower(challenge_hash)),
  launch_id TEXT NOT NULL REFERENCES jace_mem_launches(launch_id),
  issued_at TEXT NOT NULL CHECK (julianday(issued_at) IS NOT NULL),
  expires_at TEXT NOT NULL CHECK (julianday(expires_at) > julianday(issued_at) AND julianday(expires_at) <= julianday(issued_at) + 120.0 / 86400.0),
  consumed_at TEXT CHECK (consumed_at IS NULL OR julianday(consumed_at) IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_jm_launch_challenges_launch ON jace_mem_launch_challenges(launch_id, issued_at);
-- A challenge may only move from unconsumed to consumed, once.
CREATE TRIGGER IF NOT EXISTS jace_mem_launch_challenges_consume_once BEFORE UPDATE ON jace_mem_launch_challenges
WHEN OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL OR NEW.challenge_hash IS NOT OLD.challenge_hash
  OR NEW.launch_id IS NOT OLD.launch_id OR NEW.issued_at IS NOT OLD.issued_at OR NEW.expires_at IS NOT OLD.expires_at
  BEGIN SELECT RAISE(ABORT, 'jace_mem_launch_challenges: a challenge is consumed at most once'); END;
CREATE TRIGGER IF NOT EXISTS jace_mem_launch_challenges_no_delete BEFORE DELETE ON jace_mem_launch_challenges
  BEGIN SELECT RAISE(ABORT, 'jace_mem_launch_challenges: append-only'); END;

CREATE TABLE IF NOT EXISTS jace_mem_launch_attestations (
  attestation_id TEXT PRIMARY KEY,
  launch_id TEXT NOT NULL REFERENCES jace_mem_launches(launch_id),
  challenge_hash TEXT NOT NULL UNIQUE REFERENCES jace_mem_launch_challenges(challenge_hash),
  config_fingerprint TEXT NOT NULL CHECK (length(config_fingerprint) = 64 AND config_fingerprint = lower(config_fingerprint)),
  attested_at TEXT NOT NULL CHECK (julianday(attested_at) IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_jm_launch_attestations_launch ON jace_mem_launch_attestations(launch_id, attested_at);
CREATE TRIGGER IF NOT EXISTS jace_mem_launch_attestations_no_change BEFORE UPDATE ON jace_mem_launch_attestations
  BEGIN SELECT RAISE(ABORT, 'jace_mem_launch_attestations: append-only'); END;
CREATE TRIGGER IF NOT EXISTS jace_mem_launch_attestations_no_delete BEFORE DELETE ON jace_mem_launch_attestations
  BEGIN SELECT RAISE(ABORT, 'jace_mem_launch_attestations: append-only'); END;
