import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEnvelope, makeEnvelope } from '../src/envelope.js';

const base = () => makeEnvelope({
  task_id: 'task-test-000001',
  goal: 'Fix flaky test in looptrace validator',
  origin: 'cli',
  task_type: 'coding',
  allowed_tools: ['read_file', 'apply_patch', 'run_command:test'],
  workspace: '/home/jacen/dev/looptrace',
  risk_level: 'write',
  approval_required: true,
  success_criteria: ['all tests pass', 'no unrelated diffs'],
  trace_required: true,
});

test('valid write envelope passes', () => {
  const r = validateEnvelope(base());
  assert.equal(r.ok, true, r.reasons.join('; '));
  assert.equal(r.reasons.length, 0);
  assert.ok(Object.isFrozen(r.envelope));
});

test('non-object input rejected', () => {
  for (const bad of [null, 42, 'x', [1], undefined]) {
    assert.equal(validateEnvelope(bad).ok, false);
  }
});

test('missing field rejected with named reason', () => {
  const e = base(); delete e.goal;
  const r = validateEnvelope(e);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((s) => s.includes('missing field: goal')));
});

test('unknown extra field rejected (strict envelope)', () => {
  const r = validateEnvelope({ ...base(), sneaky: true });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((s) => s.includes('unknown field: sneaky')));
});

test('invalid enums rejected', () => {
  assert.equal(validateEnvelope({ ...base(), origin: 'carrier_pigeon' }).ok, false);
  assert.equal(validateEnvelope({ ...base(), task_type: 'vibes' }).ok, false);
  assert.equal(validateEnvelope({ ...base(), risk_level: 'yolo' }).ok, false);
  assert.equal(validateEnvelope({ ...base(), network_access: 'sometimes' }).ok, false);
});

test('policy: no trace no write', () => {
  const r = validateEnvelope({ ...base(), trace_required: false });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((s) => s.includes('no trace, no write')));
});

test('policy: write requires approval_required=true', () => {
  const r = validateEnvelope({ ...base(), approval_required: false });
  assert.equal(r.ok, false);
});

test('policy: destructive requires rollback_required=true', () => {
  const r = validateEnvelope({ ...base(), risk_level: 'destructive', rollback_required: false });
  assert.equal(r.ok, false);
  const ok = validateEnvelope({ ...base(), risk_level: 'destructive', rollback_required: true });
  assert.equal(ok.ok, true, ok.reasons.join('; '));
});

test('policy: write requires non-empty success_criteria', () => {
  const r = validateEnvelope({ ...base(), success_criteria: [] });
  assert.equal(r.ok, false);
});

test('policy: coding requires workspace', () => {
  const r = validateEnvelope({ ...base(), workspace: '   ' });
  assert.equal(r.ok, false);
});

test('timeout bounds enforced', () => {
  assert.equal(validateEnvelope({ ...base(), timeout_seconds: 0 }).ok, false);
  assert.equal(validateEnvelope({ ...base(), timeout_seconds: 90000 }).ok, false);
  assert.equal(validateEnvelope({ ...base(), timeout_seconds: 1.5 }).ok, false);
});

test('read_only research envelope with defaults passes', () => {
  const r = validateEnvelope(makeEnvelope({
    goal: 'Summarize open blockers',
    task_type: 'research',
    allowed_tools: ['memory_read', 'search'],
  }));
  assert.equal(r.ok, true, r.reasons.join('; '));
});
