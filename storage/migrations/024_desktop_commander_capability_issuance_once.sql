-- Desktop Commander execution is single-shot per attempt lease: exactly one
-- capability may ever be issued for a given (lease_id, attempt_id) pair. This
-- index makes duplicate or concurrent issuance requests for the same attempt
-- fail closed at the database layer instead of relying on caller discipline
-- or an in-process call-site guarantee that a network-reachable HTTP issuer
-- cannot provide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_dc_capability_issuance_once
  ON desktop_commander_capability_issuances(lease_id, attempt_id);
