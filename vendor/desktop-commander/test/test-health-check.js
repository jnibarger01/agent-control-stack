/**
 * Health check tests.
 * Run: node test/test-health-check.js
 */
import assert from 'node:assert/strict';

const { runHealthCheck } = await import('../dist/health/health-check.js');

const report = await runHealthCheck();

// Structured report fields exist.
assert.equal(typeof report.healthy, 'boolean');
assert.equal(typeof report.degraded, 'boolean');
assert.ok(Array.isArray(report.checks));
for (const c of report.checks) {
  assert.ok(c.name, 'check name');
  assert.ok(['PASS', 'FAIL', 'DEGRADED'].includes(c.status), `check status ${c.status}`);
  assert.equal(typeof c.detail, 'string');
  assert.equal(typeof c.durationMs, 'number');
}
assert.equal(typeof report.activeLeases, 'number');
assert.equal(typeof report.activeProcesses, 'number');
assert.equal(typeof report.staleExecutors, 'number');
console.log('PASS runHealthCheck returns structured report:', JSON.stringify(report.checks.map((c) => `${c.name}=${c.status}`)));

// Executor spawn check passes.
const executor = report.checks.find((c) => c.name === 'Desktop executor');
assert.ok(executor, 'executor check present');
assert.equal(executor.status, 'PASS', `executor check: ${executor.detail}`);
console.log('PASS executor spawn check passes:', executor.detail);

console.log('ALL HEALTH TESTS PASSED');
