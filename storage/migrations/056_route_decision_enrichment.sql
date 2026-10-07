-- Enrich the persisted authoritative route with a structured execution strategy, and add shadow-comparison accounting.
--
-- actor_routing_evidence stays the single persisted route record (no second router, no second table). New columns are
-- nullable: rows written before this migration, and callers that supply no work-unit context, keep NULL meaning
-- "not decided", never a default. Evidence rows remain append-only (the triggers from migration 050 are unchanged).
-- The Jev recommendation is deliberately NOT stored here (ADR 0025): it lives in routing_shadow_observations and is only
-- joined for comparison.
--
-- routing_execution_outcomes gains optional accounting. NULL means "not reported", which is not zero.

ALTER TABLE actor_routing_evidence ADD COLUMN executor_class TEXT
  CHECK (executor_class IS NULL OR executor_class IN ('coding', 'shell', 'desktop', 'cua', 'agent', 'swarm'));
ALTER TABLE actor_routing_evidence ADD COLUMN strategy TEXT
  CHECK (
    strategy IS NULL OR strategy IN (
      'single', 'plan_execute', 'maker_verifier', 'parallel_candidates', 'specialist_delegation', 'cua_recovery'
    )
  );
ALTER TABLE actor_routing_evidence ADD COLUMN strategy_source TEXT
  CHECK (strategy_source IS NULL OR strategy_source IN ('deterministic', 'model'));
ALTER TABLE actor_routing_evidence ADD COLUMN model_class TEXT;
ALTER TABLE actor_routing_evidence ADD COLUMN parallelism INTEGER
  CHECK (parallelism IS NULL OR (parallelism >= 1 AND parallelism <= 64));
ALTER TABLE actor_routing_evidence ADD COLUMN verification_required INTEGER
  CHECK (verification_required IS NULL OR verification_required IN (0, 1));
ALTER TABLE actor_routing_evidence ADD COLUMN checkpoint_policy TEXT;
ALTER TABLE actor_routing_evidence ADD COLUMN retry_policy TEXT;
ALTER TABLE actor_routing_evidence ADD COLUMN reasons_json TEXT
  CHECK (reasons_json IS NULL OR json_valid(reasons_json));
ALTER TABLE actor_routing_evidence ADD COLUMN deterministic_evidence_json TEXT
  CHECK (deterministic_evidence_json IS NULL OR json_valid(deterministic_evidence_json));
ALTER TABLE actor_routing_evidence ADD COLUMN enrichment_version TEXT;

ALTER TABLE routing_execution_outcomes ADD COLUMN actual_strategy TEXT
  CHECK (
    actual_strategy IS NULL OR actual_strategy IN (
      'single', 'plan_execute', 'maker_verifier', 'parallel_candidates', 'specialist_delegation', 'cua_recovery'
    )
  );
ALTER TABLE routing_execution_outcomes ADD COLUMN tool_calls INTEGER
  CHECK (tool_calls IS NULL OR tool_calls >= 0);
ALTER TABLE routing_execution_outcomes ADD COLUMN model_tokens INTEGER
  CHECK (model_tokens IS NULL OR model_tokens >= 0);
ALTER TABLE routing_execution_outcomes ADD COLUMN cost_micro_usd INTEGER
  CHECK (cost_micro_usd IS NULL OR cost_micro_usd >= 0);

-- One row per routed decision joining the incumbent route, its enrichment, the Nimble choice, the Jev shadow output
-- and the latest outcome. Read-only: it adds no authority and is the input to the shadow comparison metrics.
CREATE VIEW routing_comparison_v AS
SELECT
  d.decision_id AS decision_id,
  d.work_item_id AS work_item_id,
  e.mission_id AS mission_id,
  e.decision AS decision,
  e.source AS source,
  e.reason_code AS reason_code,
  e.fallback_reason AS fallback_reason,
  d.selected_actor_id AS executor_id,
  e.confidence AS nimble_confidence,
  e.model AS nimble_model,
  e.executor_class AS executor_class,
  e.strategy AS strategy,
  e.strategy_source AS strategy_source,
  e.parallelism AS parallelism,
  e.verification_required AS verification_required,
  e.candidate_json AS candidate_json,
  d.excluded_json AS excluded_json,
  e.created_at AS decided_at,
  s.status AS jev_status,
  s.recommended_executor_id AS jev_recommended,
  s.confidence AS jev_confidence,
  s.agrees AS jev_agrees,
  s.latency_ms AS jev_latency_ms,
  o.executor_id AS actual_executor,
  o.actual_strategy AS actual_strategy,
  o.success AS success,
  o.timed_out AS timed_out,
  o.verification_result AS verification_result,
  o.latency_ms AS wall_ms,
  o.retry_count AS retry_count,
  o.tool_calls AS tool_calls,
  o.model_tokens AS model_tokens,
  o.cost_micro_usd AS cost_micro_usd
FROM actor_routing_decisions AS d
JOIN actor_routing_evidence AS e ON e.decision_id = d.decision_id
LEFT JOIN routing_shadow_observations AS s ON s.decision_id = d.decision_id AND s.source = 'jev'
LEFT JOIN routing_execution_outcomes AS o ON o.outcome_id = (
  SELECT outcome_id FROM routing_execution_outcomes
  WHERE decision_id = d.decision_id
  ORDER BY created_at DESC, rowid DESC
  LIMIT 1
);
