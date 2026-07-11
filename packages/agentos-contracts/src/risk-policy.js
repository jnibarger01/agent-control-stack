/**
 * Risk policy.
 * Effective risk = max(declared risk, tool-derived risk, task-type floor).
 * Never downgrades. Unknown tools are treated as write (conservative).
 * Network-tagged tools with network_access === 'none' -> network_blocked.
 */
import { RISK_RANK, RISK_LEVELS } from './envelope.js';

// Tool classification. Prefix match on tool name (lowercased).
const TOOL_RISK = Object.freeze([
  // destructive
  { re: /^(rm|delete|drop|force_push|force-push|git_push_force|prune|wipe|format|shutdown|systemctl_stop)/, risk: 'destructive' },
  // write
  { re: /^(write|edit|create|move|rename|git_commit|git_push|git_merge|apply_patch|install|deploy|exec|shell|run_command|db_write|systemctl)/, risk: 'write' },
  // draft
  { re: /^(draft|propose|plan|generate_patch|open_pr_draft)/, risk: 'draft' },
  // read_only
  { re: /^(read|list|search|grep|stat|get|fetch_local|view|log|diff_read|memory_read|trace_read)/, risk: 'read_only' },
]);

const NETWORK_TOOLS = /^(fetch|http|browser|scrape|curl|download|web_|firecrawl|page_doctor)/;

const TASK_TYPE_FLOOR = Object.freeze({
  coding: 'draft',          // coding produces at least reviewable diffs
  research: 'read_only',
  memory_lookup: 'read_only',
  browser_scrape: 'read_only',
  deal_analysis: 'read_only',
  system_admin: 'write',    // system_admin is never below write
  unknown: 'read_only',     // conservative ceiling handled by router (approval queue)
});

export function classifyToolRisk(tool) {
  const t = String(tool).toLowerCase();
  for (const { re, risk } of TOOL_RISK) if (re.test(t)) return risk;
  return 'write'; // unknown tool -> conservative
}

function maxRisk(a, b) {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

/**
 * @param {object} envelope  a VALID envelope
 * @returns {{ effective_risk: string, approval_required: boolean, rollback_required: boolean,
 *             network_violation: boolean, reasons: string[] }}
 */
export function applyRiskPolicy(envelope) {
  const reasons = [];
  let risk = envelope.risk_level;

  const floor = TASK_TYPE_FLOOR[envelope.task_type] ?? 'write';
  if (RISK_RANK[floor] > RISK_RANK[risk]) {
    reasons.push(`risk floor: task_type=${envelope.task_type} raises risk to ${floor}`);
    risk = floor;
  }

  for (const tool of envelope.allowed_tools) {
    const tr = classifyToolRisk(tool);
    if (RISK_RANK[tr] > RISK_RANK[risk]) {
      reasons.push(`tool escalation: ${tool} -> ${tr}`);
      risk = maxRisk(risk, tr);
    }
  }

  let network_violation = false;
  if (envelope.network_access === 'none') {
    for (const tool of envelope.allowed_tools) {
      if (NETWORK_TOOLS.test(String(tool).toLowerCase())) {
        network_violation = true;
        reasons.push(`network_blocked: tool ${tool} requires declared network access`);
      }
    }
  }

  // Never downgrade approval; force it at write+.
  let approval_required = envelope.approval_required;
  if (RISK_RANK[risk] >= RISK_RANK.write && !approval_required) {
    approval_required = true;
    reasons.push('approval forced: effective risk >= write');
  }

  let rollback_required = envelope.rollback_required;
  if (risk === 'destructive' && !rollback_required) {
    rollback_required = true;
    reasons.push('rollback forced: effective risk = destructive');
  }

  if (!RISK_LEVELS.includes(risk)) risk = 'destructive'; // unreachable, fail-closed anyway

  return { effective_risk: risk, approval_required, rollback_required, network_violation, reasons };
}
