/**
 * Mission Router policy.
 * route(input) -> decision. Pure function; caller wires trace + dispatch.
 *
 * Guarantees:
 *   - invalid envelope        -> rejected (never dispatched)
 *   - unknown task_type       -> human_triage queue, read_only ceiling
 *   - effective write+        -> queued_for_approval = true
 *   - network violation       -> rejected (network_blocked)
 *   - no trace on write+      -> rejected upstream by envelope validation
 */
import { validateEnvelope, RISK_RANK } from './envelope.js';
import { applyRiskPolicy } from './risk-policy.js';

export const ROUTES = Object.freeze({
  coding: 'codex-swarm',
  research: 'hermes.research',
  memory_lookup: 'agent-memory',
  browser_scrape: 'page-doctor',
  deal_analysis: 'dealpilot',
  system_admin: 'approval-queue',   // system_admin never auto-dispatches
  unknown: 'human-triage',
});

/**
 * @returns {{
 *   ok: boolean,
 *   task_id: string|null,
 *   target: string|null,
 *   queued_for_approval: boolean,
 *   effective_risk: string|null,
 *   approval_required: boolean,
 *   rollback_required: boolean,
 *   failure_code: string|null,
 *   reasons: string[]
 * }}
 */
export function route(input) {
  const v = validateEnvelope(input);
  if (!v.ok) {
    return {
      ok: false, task_id: input?.task_id ?? null, target: null,
      queued_for_approval: false, effective_risk: null,
      approval_required: true, rollback_required: false,
      failure_code: 'policy_blocked', reasons: v.reasons,
    };
  }
  const env = v.envelope;
  const policy = applyRiskPolicy(env);

  if (policy.network_violation) {
    return {
      ok: false, task_id: env.task_id, target: null,
      queued_for_approval: false, effective_risk: policy.effective_risk,
      approval_required: true, rollback_required: policy.rollback_required,
      failure_code: 'network_blocked', reasons: policy.reasons,
    };
  }

  let target = ROUTES[env.task_type] ?? 'human-triage';
  const reasons = [...policy.reasons];

  // Unknown tasks: conservative — human triage, read_only ceiling.
  if (env.task_type === 'unknown') {
    reasons.push('unknown task_type: routed to human-triage with read_only ceiling');
  }

  const queued_for_approval =
    policy.approval_required &&
    (RISK_RANK[policy.effective_risk] >= RISK_RANK.write ||
      target === 'approval-queue' ||
      target === 'human-triage');

  if (queued_for_approval && target !== 'human-triage') {
    reasons.push(`approval gate: ${env.task_type}/${policy.effective_risk} held for human approval before dispatch to ${target}`);
  }

  return {
    ok: true,
    task_id: env.task_id,
    target,
    queued_for_approval,
    effective_risk: policy.effective_risk,
    approval_required: policy.approval_required,
    rollback_required: policy.rollback_required,
    failure_code: null,
    reasons,
  };
}
