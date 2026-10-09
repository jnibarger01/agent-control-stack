#!/usr/bin/env node
/**
 * Dependency audit gate for vendor/desktop-commander.
 *
 * Equivalent to `npm audit --audit-level=high`, except for the exceptions
 * listed below. An exception is accepted only while ALL of these hold:
 *   - every high/critical advisory behind the audit entry is itself listed here
 *     (a second, unlisted advisory on the same package fails the gate);
 *   - no patched release of the vulnerable package has been published, checked
 *     against the registry directly (not via `fixAvailable`, which only says
 *     whether npm can fix *this* tree and stays false when the dependent
 *     package, e.g. mcpb, has not yet adopted a published patch);
 *   - the vulnerable package is absent from the production dependency tree
 *     (`npm ls <pkg> --omit=dev` is empty), i.e. it is a build/dev tool only.
 * Any other high or critical advisory fails the gate, in dev or prod. If the
 * registry or the tree cannot be inspected, the gate fails closed.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const EXCEPTIONS = [
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
// An unknown or missing severity is not trusted to be low.
const isFailing = (severity) => LEVELS.indexOf(severity) === -1 || LEVELS.indexOf(severity) >= FAIL_AT;

/** Returns a description when `report` cannot be a genuine npm audit report, else undefined. */
export function reportShapeProblem(report) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) return 'npm audit output is not a JSON object';
  if (typeof report.auditReportVersion !== 'number') return 'npm audit output has no auditReportVersion; refusing to treat it as clean';
  if (report.vulnerabilities === null || typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities)) {
    return 'npm audit output has no vulnerabilities object; refusing to treat it as clean';
  }
  if (report.metadata === null || typeof report.metadata !== 'object' || Array.isArray(report.metadata)) {
    return 'npm audit output has no metadata object; refusing to treat it as clean';
  }
  return undefined;
}

/** Every advisory behind `name`, following dependency chains (e.g. mcpb -> node-forge). */
function advisoriesFor(report, name, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const out = [];
  for (const via of report.vulnerabilities?.[name]?.via ?? []) {
    if (typeof via === 'string') out.push(...advisoriesFor(report, via, seen));
    else out.push({ id: String(via.url ?? '').split('/').pop(), severity: via.severity, package: via.name, range: via.range });
  }
  return out;
}

/** A published, stable version above every vulnerable one that the advisory range does not cover. */
export function patchedVersions(versions, range, semver) {
  const stable = versions.filter((version) => semver.valid(version) && !semver.prerelease(version));
  const vulnerable = stable.filter((version) => semver.satisfies(version, range));
  const highestVulnerable = vulnerable.sort(semver.compare).at(-1);
  return stable.filter((version) => !semver.satisfies(version, range) && (!highestVulnerable || semver.gt(version, highestVulnerable)));
}

/**
 * @param report   parsed `npm audit --json`
 * @param probes   { inProduction(pkg): boolean, publishedVersions(pkg): string[], semver }
 * @returns        { problems: string[], accepted: exception[] }
 */
export function evaluate(report, probes) {
  const problems = [];
  const accepted = new Map();

  // Fail closed on anything that is not a real `npm audit --json` report. `{}` and other valid-but-empty JSON
  // would otherwise read as "no vulnerabilities".
  const shapeProblem = reportShapeProblem(report);
  if (shapeProblem) return { problems: [shapeProblem], accepted: [], malformed: true };

  for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
    if (!isFailing(vulnerability.severity)) continue;
    const failing = advisoriesFor(report, name).filter((advisory) => isFailing(advisory.severity));
    if (failing.length === 0) {
      problems.push(`${name} (${vulnerability.severity}): cannot attribute to a specific advisory; see npm audit`);
      continue;
    }
    for (const advisory of failing) {
      const exception = EXCEPTIONS.find((item) => item.advisory === advisory.id && item.package === advisory.package);
      if (exception) accepted.set(exception.advisory, { exception, range: advisory.range });
      else problems.push(`${name} (${advisory.severity}): ${advisory.id} on ${advisory.package}`);
    }
  }

  for (const { exception, range } of accepted.values()) {
    const entry = report.vulnerabilities?.[exception.package];
    if (entry?.fixAvailable) {
      problems.push(`${exception.package}: npm reports a fix (${JSON.stringify(entry.fixAvailable)}); remove its exception from scripts/audit-gate.mjs`);
    }
    try {
      const patched = patchedVersions(probes.publishedVersions(exception.package), range, probes.semver);
      if (patched.length > 0) {
        problems.push(`${exception.package}: patched release(s) ${patched.join(', ')} outside ${range} are published; update to one (or the dependent package) and remove the exception`);
      }
    } catch (error) {
      problems.push(`${exception.package}: cannot check the registry for a patched release (${error.message}); failing closed`);
    }
    try {
      if (probes.inProduction(exception.package)) {
        problems.push(`${exception.package} is now in the production dependency tree; the dev-only exception no longer applies`);
      }
    } catch (error) {
      problems.push(`${exception.package}: cannot inspect the production tree (${error.message}); failing closed`);
    }
  }
  return { problems, accepted: [...accepted.values()].map((item) => item.exception) };
}

function npm(args) {
  try {
    return execFileSync('npm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    // npm audit / npm ls exit non-zero when they have findings; the JSON is still on stdout.
    if (typeof error.stdout === 'string' && error.stdout.trim()) return error.stdout;
    throw error;
  }
}

function main() {
  const report = JSON.parse(npm(['audit', '--json']));
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    console.error('audit-gate: npm audit output is not a JSON object');
    process.exit(2);
  }
  if (report.error) {
    console.error(`audit-gate: npm audit could not run: ${report.error.summary ?? JSON.stringify(report.error)}`);
    process.exit(2);
  }
  const semver = createRequire(import.meta.url)('semver');
  const { problems, accepted, malformed } = evaluate(report, {
    semver,
    inProduction: (pkg) => Object.keys(JSON.parse(npm(['ls', pkg, '--omit=dev', '--json'])).dependencies ?? {}).length > 0,
    publishedVersions: (pkg) => {
      const versions = JSON.parse(npm(['view', pkg, 'versions', '--json']));
      return Array.isArray(versions) ? versions : [versions];
    },
  });
  for (const exception of accepted) {
    console.log(`audit-gate: accepted ${exception.advisory} (${exception.package}): ${exception.reason}`);
  }
  if (malformed) {
    console.error('audit-gate: FAILED (malformed npm audit report)');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(2);
  }
  if (problems.length > 0) {
    console.error('audit-gate: FAILED');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`audit-gate: ok (${accepted.length} documented exception${accepted.length === 1 ? '' : 's'}, no other high or critical advisories)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
