#!/usr/bin/env node
/**
 * scripts/audit-gate.mjs: the documented node-forge exception must hold only
 * while it is the sole high/critical advisory on the package, no patched
 * release is published, and the package stays out of the production tree.
 * Synthetic `npm audit --json` reports; no network.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { evaluate, patchedVersions, reportShapeProblem } from '../scripts/audit-gate.mjs';

const semver = createRequire(import.meta.url)('semver');
const FORGE = 'GHSA-86w9-cpqp-85rv';
const advisory = (name, id, severity = 'high', range = '<=1.4.0') => ({
  source: 1, name, dependency: name, title: id, url: `https://github.com/advisories/${id}`, severity, range,
});
const report = (vulnerabilities) => ({ auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: {} } });
const base = () => ({
  'node-forge': { name: 'node-forge', severity: 'high', via: [advisory('node-forge', FORGE)], fixAvailable: false },
  '@anthropic-ai/mcpb': { name: '@anthropic-ai/mcpb', severity: 'high', via: ['node-forge'], fixAvailable: false },
});
const probes = (overrides = {}) => ({
  semver,
  inProduction: () => false,
  publishedVersions: () => ['1.3.0', '1.3.2', '1.4.0'],
  ...overrides,
});

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`  ✓ ${name}`); };

test('accepts the documented exception when nothing else is wrong', () => {
  const result = evaluate(report(base()), probes());
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.accepted.map((item) => item.advisory), [FORGE]);
});

test('an unrelated high advisory fails, even next to the exception', () => {
  const vulnerabilities = { ...base(), braces: { name: 'braces', severity: 'high', via: [advisory('braces', 'GHSA-vfj7-8cjw-p6xm', 'high', '<=3.0.3')], fixAvailable: false } };
  const { problems } = evaluate(report(vulnerabilities), probes());
  assert.equal(problems.length, 1);
  assert.match(problems[0], /braces.*GHSA-vfj7-8cjw-p6xm/);
});

test('mixed advisories: a second unlisted high advisory on node-forge is not swallowed by the exception', () => {
  const vulnerabilities = base();
  vulnerabilities['node-forge'].via = [advisory('node-forge', FORGE), advisory('node-forge', 'GHSA-aaaa-bbbb-cccc')];
  const { problems } = evaluate(report(vulnerabilities), probes());
  assert.ok(problems.some((problem) => /GHSA-aaaa-bbbb-cccc/.test(problem)), problems.join('\n'));
});

test('mixed advisories reached through the dependent package (mcpb) are also caught', () => {
  const vulnerabilities = base();
  vulnerabilities['@anthropic-ai/mcpb'].via = ['node-forge', advisory('@anthropic-ai/mcpb', 'GHSA-dddd-eeee-ffff', 'critical', '*')];
  const { problems } = evaluate(report(vulnerabilities), probes());
  assert.ok(problems.some((problem) => /GHSA-dddd-eeee-ffff/.test(problem)), problems.join('\n'));
});

test('a same-id advisory on a different package does not inherit the exception', () => {
  const vulnerabilities = { other: { name: 'other', severity: 'high', via: [advisory('other', FORGE)], fixAvailable: false } };
  assert.equal(evaluate(report(vulnerabilities), probes()).problems.length, 1);
});

test('a moderate advisory alongside the exception is ignored; high+ must still be listed', () => {
  const vulnerabilities = base();
  vulnerabilities['node-forge'].via.push(advisory('node-forge', 'GHSA-mmmm-mmmm-mmmm', 'moderate'));
  assert.deepEqual(evaluate(report(vulnerabilities), probes()).problems, []);
});

test('expires when a patched release is published outside the dependent package range', () => {
  // fixAvailable stays false because mcpb has not adopted 1.5.0 yet.
  const { problems } = evaluate(report(base()), probes({ publishedVersions: () => ['1.3.0', '1.4.0', '1.5.0'] }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /patched release.*1\.5\.0/);
});

test('a prerelease above the vulnerable range does not count as a patch', () => {
  assert.deepEqual(evaluate(report(base()), probes({ publishedVersions: () => ['1.4.0', '2.0.0-beta.1'] })).problems, []);
});

test('expires when npm itself reports a fix', () => {
  const vulnerabilities = base();
  vulnerabilities['node-forge'].fixAvailable = { name: '@anthropic-ai/mcpb', version: '9.0.0' };
  assert.equal(evaluate(report(vulnerabilities), probes()).problems.length, 1);
});

test('expires when the package reaches the production tree', () => {
  const { problems } = evaluate(report(base()), probes({ inProduction: () => true }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /production dependency tree/);
});

test('fails closed when the registry or the tree cannot be inspected', () => {
  const unreachable = evaluate(report(base()), probes({ publishedVersions: () => { throw new Error('ENOTFOUND'); } }));
  assert.match(unreachable.problems.join('\n'), /failing closed/);
  const broken = evaluate(report(base()), probes({ inProduction: () => { throw new Error('npm ls failed'); } }));
  assert.match(broken.problems.join('\n'), /failing closed/);
});

test('patchedVersions only returns stable versions above the highest vulnerable one', () => {
  assert.deepEqual(patchedVersions(['0.9.0', '1.4.0', '1.4.1', '2.0.0-rc.1', '2.0.0'], '<=1.4.0', semver), ['1.4.1', '2.0.0']);
  assert.deepEqual(patchedVersions(['1.0.0', '1.4.0'], '<=1.4.0', semver), []);
});

test('a {} or otherwise malformed-but-valid-JSON report is not treated as clean', () => {
  for (const bad of [{}, [], null, 'ok', { vulnerabilities: {} }, { auditReportVersion: 2, vulnerabilities: {} },
    { auditReportVersion: 2, metadata: {} }, { auditReportVersion: 2, vulnerabilities: [], metadata: {} }]) {
    const result = evaluate(bad, probes());
    assert.ok(result.problems.length > 0 && result.malformed === true, JSON.stringify(bad));
    assert.ok(reportShapeProblem(bad));
  }
  assert.equal(reportShapeProblem(report({})), undefined);
});

test('an advisory with an unknown or missing severity is treated as failing, not low', () => {
  const vulnerabilities = { x: { name: 'x', severity: 'high', via: [advisory('x', 'GHSA-zzzz-zzzz-zzzz', 'weird', '*')], fixAvailable: false } };
  assert.equal(evaluate(report(vulnerabilities), probes()).problems.length, 1);
});

console.log(`\naudit-gate: ${passed} passed`);
