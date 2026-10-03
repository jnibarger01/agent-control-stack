#!/usr/bin/env node
/**
 * Dependency audit gate for vendor/desktop-commander.
 *
 * Equivalent to `npm audit --audit-level=high`, except for the exceptions
 * listed below. An exception is accepted only while ALL of these hold:
 *   - the advisory has no patched release (the gate fails the moment one exists,
 *     so the exception cannot outlive its reason);
 *   - the vulnerable package is absent from the production dependency tree
 *     (`npm ls <pkg> --omit=dev` is empty), i.e. it is a build/dev tool only.
 * Any other high or critical advisory fails the gate, in dev or prod.
 */
import { execFileSync } from 'node:child_process';

const EXCEPTIONS = [
  {
    package: 'node-forge',
    advisory: 'GHSA-86w9-cpqp-85rv',
    reason:
      'RSA PKCS#1 v1.5 signature verification flaw; no patched release (<= 1.4.0 is latest). ' +
      'Only reachable through the dev-only @anthropic-ai/mcpb CLI, whose validate/pack commands ' +
      'used by scripts/build-mcpb.cjs do not verify signatures. Not shipped or loaded at runtime.',
  },
];

const LEVELS = ['info', 'low', 'moderate', 'high', 'critical'];
const FAIL_AT = LEVELS.indexOf('high');

function run(args) {
  try {
    return execFileSync('npm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    // npm audit / npm ls exit non-zero when they have findings; the JSON is still on stdout.
    if (typeof error.stdout === 'string' && error.stdout.trim()) return error.stdout;
    throw error;
  }
}

const report = JSON.parse(run(['audit', '--json']));
if (report.error) {
  console.error(`audit-gate: npm audit could not run: ${report.error.summary ?? JSON.stringify(report.error)}`);
  process.exit(2);
}

/** Advisory ids (GHSA-...) that make `name` vulnerable, directly or via a dependency chain. */
function advisoryIds(name, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const vulnerability = report.vulnerabilities?.[name];
  if (!vulnerability) return [];
  const ids = [];
  for (const via of vulnerability.via ?? []) {
    if (typeof via === 'string') ids.push(...advisoryIds(via, seen));
    else if (via.url) ids.push(via.url.split('/').pop());
  }
  return ids;
}

const problems = [];
const accepted = [];

for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
  if (LEVELS.indexOf(vulnerability.severity) < FAIL_AT) continue;
  const ids = advisoryIds(name);
  const exception = EXCEPTIONS.find((item) => ids.includes(item.advisory));
  if (!exception) {
    problems.push(`${name} (${vulnerability.severity}): ${ids.join(', ') || 'see npm audit'}`);
    continue;
  }
  // The exception is for the root package; packages that merely depend on it (e.g. mcpb) ride along.
  if (name === exception.package) accepted.push(exception);
}

for (const exception of accepted) {
  const vulnerability = report.vulnerabilities[exception.package];
  if (vulnerability.fixAvailable) {
    problems.push(`${exception.package}: a fix is now available (${JSON.stringify(vulnerability.fixAvailable)}); remove its exception from scripts/audit-gate.mjs`);
  }
  const prod = JSON.parse(run(['ls', exception.package, '--omit=dev', '--json']));
  if (prod.dependencies && Object.keys(prod.dependencies).length > 0) {
    problems.push(`${exception.package} is now in the production dependency tree; the dev-only exception no longer applies`);
  }
}

for (const exception of accepted) {
  console.log(`audit-gate: accepted ${exception.advisory} (${exception.package}): ${exception.reason}`);
}
if (problems.length > 0) {
  console.error('audit-gate: FAILED');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`audit-gate: ok (${accepted.length} documented exception${accepted.length === 1 ? '' : 's'}, no other high or critical advisories)`);
