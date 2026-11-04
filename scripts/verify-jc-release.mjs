#!/usr/bin/env node
/**
 * Clean, independent installation check for the native Jace Commander runtime.
 *
 *   node scripts/verify-jc-release.mjs [--keep] [--evidence <file>]
 *
 * 1. Build apps/jace-commander and stage a release directory OUTSIDE every
 *    repository (~/.cache/jc-release-verify-*), with no node_modules.
 * 2. Inside a bubblewrap mount namespace where $HOME/projects is an empty
 *    tmpfs (no monorepo, no worktrees, no vendor/desktop-commander):
 *      - npm install --omit=dev from the public registry (runtime deps only)
 *      - the installed dependency graph must lie entirely inside the release
 *      - npm audit --omit=dev of the shipped graph is recorded
 *      - the full JC test suite runs against the installed release
 *      - verify/standalone-session.mjs drives the installed runtime with a
 *        real MCP client and records every module the server resolved
 * 3. Writes a JSON evidence record.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = path.join(repo, 'apps', 'jace-commander');
const keep = process.argv.includes('--keep');
const evidenceArg = process.argv.indexOf('--evidence');
const evidenceFile = path.resolve(evidenceArg > 0 ? process.argv[evidenceArg + 1] : path.join(repo, 'verification', 'jc-release-standalone-evidence.json'));
const version = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).version;
const projects = path.join(os.homedir(), 'projects');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024, ...options });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Run `argv` with $HOME/projects masked: nothing from any checkout is reachable. */
function isolated(stage, argv) {
  return run('bwrap', [
    '--die-with-parent', '--dev-bind', '/', '/',
    '--tmpfs', projects,
    '--chdir', stage, '--', ...argv,
  ], { env: { PATH: process.env.PATH, HOME: os.homedir(), LANG: 'C.UTF-8', ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}) } });
}

const build = run('npm', ['run', 'build', '-w', 'apps/jace-commander'], { cwd: repo });
if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}${build.stderr}`);
const commit = run('git', ['-C', repo, 'rev-parse', 'HEAD']).stdout.trim();

const base = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'jc-release-verify-'));
const stage = path.join(base, `jace-commander-${version}`);
fs.mkdirSync(stage);
for (const entry of ['package.json', 'dist', 'deploy', 'docs', 'verify', 'test', 'README.md']) {
  if (fs.existsSync(path.join(app, entry))) fs.cpSync(path.join(app, entry), path.join(stage, entry), { recursive: true });
}
fs.rmSync(path.join(stage, 'dist', '.tsbuildinfo'), { force: true });

const evidence = { verdict: 'FAIL', date: new Date().toISOString(), commit, version, stage, maskedPath: projects, steps: {} };
try {
  const visible = isolated(stage, ['sh', '-c', `ls -A "${projects}" | wc -l; test -e "${projects}/agent-control-stack/vendor/desktop-commander" && echo VENDOR_VISIBLE || echo vendor-absent`]);
  evidence.steps.isolation = visible.stdout.trim().split('\n');
  if (!/vendor-absent/.test(visible.stdout) || visible.stdout.trim().split('\n')[0] !== '0') throw new Error(`checkouts are visible inside the verification namespace: ${visible.stdout}`);

  const install = isolated(stage, ['npm', 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock']);
  evidence.steps.install = { status: install.status, tail: install.stdout.trim().split('\n').slice(-2) };
  if (install.status !== 0) throw new Error(`npm install failed:\n${install.stderr}`);

  const graph = isolated(stage, ['npm', 'ls', '--omit=dev', '--all', '--parseable']);
  const paths = graph.stdout.trim().split('\n').filter(Boolean);
  const escaped = paths.filter((entry) => entry !== stage && !entry.startsWith(`${stage}${path.sep}`));
  const tree = JSON.parse(isolated(stage, ['npm', 'ls', '--omit=dev', '--all', '--json']).stdout || '{}');
  const packages = new Set();
  const walk = (node) => { for (const [name, child] of Object.entries(node.dependencies ?? {})) { packages.add(`${name}@${child.version}`); walk(child); } };
  walk(tree);
  evidence.steps.dependencyGraph = { installedPaths: paths.length, outsideRelease: escaped, packages: packages.size, direct: Object.keys(tree.dependencies ?? {}).map((name) => `${name}@${tree.dependencies[name].version}`) };
  if (escaped.length) throw new Error(`dependency graph escapes the release: ${escaped.join(', ')}`);
  if ([...packages].some((entry) => /desktop-commander|^@agent-control-stack\//.test(entry))) throw new Error('release depends on Desktop Commander or a workspace package');

  const audit = isolated(stage, ['npm', 'audit', '--omit=dev', '--json']);
  try {
    const parsed = JSON.parse(audit.stdout);
    evidence.steps.shippedAudit = { vulnerabilities: parsed.metadata?.vulnerabilities, findings: Object.entries(parsed.vulnerabilities ?? {}).map(([name, value]) => `${value.severity} ${name}`) };
  } catch {
    evidence.steps.shippedAudit = { error: 'audit unavailable (offline?)', stderr: audit.stderr.slice(0, 500) };
  }

  // Full suite from the installed release (outside every repository; Node's
  // resolution from ~/.cache never walks into $HOME/projects).
  if (fs.existsSync(path.join(os.homedir(), 'node_modules'))) throw new Error('~/node_modules exists and could satisfy resolution from outside the release');
  const env = { PATH: process.env.PATH, HOME: os.homedir(), LANG: 'C.UTF-8', ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}) };
  const suites = run('node', ['test/run-all.mjs'], { cwd: stage, env });
  evidence.steps.testSuite = { where: 'installed release, outside all repositories', status: suites.status, summary: suites.stdout.trim().split('\n').slice(-2), failed: suites.stdout.split('\n').filter((line) => line.startsWith('FAIL')) };
  if (suites.status !== 0) throw new Error(`installed-release test suite failed:\n${suites.stdout.slice(-4000)}`);
  // Again with every checkout masked. Root ownership cannot be observed in an
  // unprivileged user namespace (root maps to the overflow uid), so the three
  // suites that verify root-owned trust anchors run only in the pass above.
  const rootOwnership = ['policy.test.mjs', 'privileged-local.test.mjs', 'privileged.test.mjs'];
  const masked = isolated(stage, ['node', 'test/run-all.mjs', '--exclude', ...rootOwnership]);
  evidence.steps.testSuiteMasked = { where: '$HOME/projects masked', excluded: rootOwnership, reason: 'root-owned trust-anchor checks need the host uid mapping', status: masked.status, summary: masked.stdout.trim().split('\n').slice(-2) };
  if (masked.status !== 0) throw new Error(`masked test suite failed:\n${masked.stdout.slice(-4000)}`);

  const sessionEvidence = path.join(base, 'session.json');
  const session = isolated(stage, ['node', 'verify/standalone-session.mjs', sessionEvidence]);
  evidence.steps.mcpSession = fs.existsSync(sessionEvidence) ? JSON.parse(fs.readFileSync(sessionEvidence, 'utf8')) : { verdict: 'FAIL', stderr: session.stderr.slice(-2000) };
  if (session.status !== 0 || evidence.steps.mcpSession.verdict !== 'PASS') throw new Error(`MCP session failed:\n${session.stdout.slice(-3000)}${session.stderr.slice(-2000)}`);

  evidence.verdict = 'PASS';
} catch (error) {
  evidence.error = String(error?.message ?? error);
  process.exitCode = 1;
} finally {
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  if (!keep) fs.rmSync(base, { recursive: true, force: true });
}
console.log(`jace-commander release verification: ${evidence.verdict}${evidence.error ? ` (${evidence.error.split('\n')[0]})` : ''}\nevidence: ${evidenceFile}`);
