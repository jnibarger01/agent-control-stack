import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGate, REQUIRED_GATES } from '../src/promotion-gate.js';

const allPass = () => ({
  head_sha_verified: true,
  worktree_clean: true,
  tests_passed: true,
  typecheck_passed: true,
  lint_passed: true,
  secret_scan_passed: true,
  unexpected_diff: false,
  reviewer_approved: true,
  approval_recorded: true,
  trace_recorded: true,
  head_sha_expected: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  head_sha_actual: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  tests_exit_code: 0,
  typecheck_exit_code: 0,
  lint_exit_code: 0,
  trace_id: 'run-abc-000001',
});

test('all gates pass -> promoted', () => {
  const r = evaluateGate(allPass());
  assert.equal(r.promoted, true, r.remediation.join('\n'));
  assert.equal(r.failures.length, 0);
});

test('each required gate failing blocks promotion with remediation', () => {
  for (const gate of REQUIRED_GATES) {
    const ev = allPass();
    ev[gate] = gate === 'unexpected_diff' ? true : false;
    // keep raw evidence consistent with the failing claim
    if (gate === 'tests_passed') ev.tests_exit_code = 1;
    if (gate === 'typecheck_passed') ev.typecheck_exit_code = 2;
    if (gate === 'lint_passed') ev.lint_exit_code = 1;
    if (gate === 'head_sha_verified') ev.head_sha_actual = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    if (gate === 'trace_recorded') delete ev.trace_id;
    const r = evaluateGate(ev);
    assert.equal(r.promoted, false, `gate ${gate} should block`);
    assert.ok(r.failures.includes(gate), `failures should name ${gate}`);
    assert.ok(r.remediation.some((m) => m.startsWith(gate)), `remediation should cover ${gate}`);
  }
});

test('missing gate key -> fail closed with gate_missing_evidence', () => {
  const ev = allPass();
  delete ev.secret_scan_passed;
  const r = evaluateGate(ev);
  assert.equal(r.promoted, false);
  assert.equal(r.failure_code, 'gate_missing_evidence');
});

test('non-boolean gate value -> fail closed', () => {
  const ev = allPass();
  ev.tests_passed = 'yes';
  const r = evaluateGate(ev);
  assert.equal(r.promoted, false);
  assert.equal(r.failure_code, 'gate_missing_evidence');
});

test('null / non-object evidence -> fail closed', () => {
  for (const bad of [null, undefined, 'ok', 42, []]) {
    assert.equal(evaluateGate(bad).promoted, false);
  }
});

test('evidence beats assertion: claimed head_sha_verified but SHA mismatch -> blocked', () => {
  const ev = allPass();
  ev.head_sha_actual = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'; // claim stays true
  const r = evaluateGate(ev);
  assert.equal(r.promoted, false);
  assert.ok(r.failures.includes('head_sha_verified'));
});

test('evidence beats assertion: tests claimed passed but exit_code=1 -> blocked as test_failed', () => {
  const ev = allPass();
  ev.tests_exit_code = 1; // claim stays true
  const r = evaluateGate(ev);
  assert.equal(r.promoted, false);
  assert.equal(r.failure_code, 'test_failed');
});

test('evidence beats assertion: trace_recorded claimed but bogus trace_id -> trace_missing', () => {
  const ev = allPass();
  ev.trace_id = 'x';
  const r = evaluateGate(ev);
  assert.equal(r.promoted, false);
  assert.equal(r.failure_code, 'trace_missing');
});

test('failure_code mapping: secret scan failure -> secret_detected', () => {
  const ev = allPass();
  ev.secret_scan_passed = false;
  assert.equal(evaluateGate(ev).failure_code, 'secret_detected');
});

test('failure_code mapping: missing approval -> approval_required', () => {
  const ev = allPass();
  ev.approval_recorded = false;
  assert.equal(evaluateGate(ev).failure_code, 'approval_required');
});

test('unexpected_diff=true blocks with unexpected_diff code', () => {
  const ev = allPass();
  ev.unexpected_diff = true;
  const r = evaluateGate(ev);
  assert.equal(r.promoted, false);
  assert.equal(r.failure_code, 'unexpected_diff');
});
