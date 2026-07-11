import test from 'node:test';
import assert from 'node:assert/strict';
import { route, ROUTES } from '../src/router.js';
import { applyRiskPolicy, classifyToolRisk } from '../src/risk-policy.js';
import { makeEnvelope, validateEnvelope } from '../src/envelope.js';

const env = (over = {}) => makeEnvelope({
  task_id: 'task-router-000001',
  goal: 'test routing',
  allowed_tools: ['read_file'],
  ...over,
});

test('routing table matches contract', () => {
  assert.deepEqual(ROUTES, {
    coding: 'codex-swarm',
    research: 'hermes.research',
    memory_lookup: 'agent-memory',
    browser_scrape: 'page-doctor',
    deal_analysis: 'dealpilot',
    system_admin: 'approval-queue',
    unknown: 'human-triage',
  });
});

test('invalid envelope is rejected, never routed', () => {
  const d = route({ garbage: true });
  assert.equal(d.ok, false);
  assert.equal(d.target, null);
  assert.equal(d.failure_code, 'policy_blocked');
});

test('coding write task routes to codex-swarm and queues for approval', () => {
  const d = route(env({
    task_type: 'coding',
    workspace: '/home/jacen/dev/codex-swarm',
    risk_level: 'write',
    allowed_tools: ['read_file', 'apply_patch'],
    success_criteria: ['tests pass'],
  }));
  assert.equal(d.ok, true, d.reasons.join('; '));
  assert.equal(d.target, 'codex-swarm');
  assert.equal(d.queued_for_approval, true);
  assert.equal(d.effective_risk, 'write');
});

test('read_only research dispatches without approval queue', () => {
  const d = route(env({ task_type: 'research', allowed_tools: ['search', 'memory_read'], approval_required: false }));
  assert.equal(d.ok, true);
  assert.equal(d.target, 'hermes.research');
  assert.equal(d.queued_for_approval, false);
  assert.equal(d.effective_risk, 'read_only');
});

test('tool escalation: write tool raises declared read_only to write and forces approval', () => {
  const d = route(env({
    task_type: 'research',
    risk_level: 'read_only',
    approval_required: false,
    allowed_tools: ['search', 'write_file'],
  }));
  assert.equal(d.ok, true);
  assert.equal(d.effective_risk, 'write');
  assert.equal(d.approval_required, true);
  assert.equal(d.queued_for_approval, true);
  assert.ok(d.reasons.some((s) => s.includes('tool escalation')));
});

test('unknown tool is treated as write (conservative)', () => {
  assert.equal(classifyToolRisk('quantum_flux_capacitor'), 'write');
});

test('destructive tool forces rollback_required', () => {
  const v = validateEnvelope(env({
    task_type: 'system_admin',
    risk_level: 'write',
    success_criteria: ['service restarted'],
    allowed_tools: ['systemctl_stop:openclaw'],
  }));
  assert.equal(v.ok, true, v.reasons.join('; '));
  const p = applyRiskPolicy(v.envelope);
  assert.equal(p.effective_risk, 'destructive');
  assert.equal(p.rollback_required, true);
  assert.equal(p.approval_required, true);
});

test('system_admin always lands in approval queue', () => {
  const d = route(env({
    task_type: 'system_admin',
    risk_level: 'write',
    success_criteria: ['done'],
    allowed_tools: ['systemctl'],
  }));
  assert.equal(d.target, 'approval-queue');
  assert.equal(d.queued_for_approval, true);
});

test('unknown task_type routes to human triage', () => {
  const d = route(env({ task_type: 'unknown' }));
  assert.equal(d.ok, true);
  assert.equal(d.target, 'human-triage');
  assert.equal(d.queued_for_approval, true);
  assert.ok(d.reasons.some((s) => s.includes('human-triage')));
});

test('network tool with network_access=none is blocked', () => {
  const d = route(env({
    task_type: 'browser_scrape',
    network_access: 'none',
    allowed_tools: ['browser_open', 'page_doctor_extract'],
  }));
  assert.equal(d.ok, false);
  assert.equal(d.failure_code, 'network_blocked');
});

test('network tool with declared access passes', () => {
  const d = route(env({
    task_type: 'browser_scrape',
    network_access: 'declared',
    allowed_tools: ['browser_open', 'page_doctor_extract'],
  }));
  assert.equal(d.ok, true);
  assert.equal(d.target, 'page-doctor');
});

test('coding floor is draft: pure read tools on coding task still yield draft', () => {
  const d = route(env({
    task_type: 'coding',
    workspace: '/tmp/x',
    allowed_tools: ['read_file', 'search'],
  }));
  assert.equal(d.effective_risk, 'draft');
  assert.equal(d.queued_for_approval, false);
});
