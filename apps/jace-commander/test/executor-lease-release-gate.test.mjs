#!/usr/bin/env node
/**
 * End-to-end release gate for the managed executor lease (PR #450, Codex P2).
 *
 * Runs the real built CLI as a managed `serve` process. A development checkout
 * must refuse before it can occupy the canonical executor slot; the same build
 * staged as an installed release (releases/<id> + current + RELEASE.json with a
 * git commit, as install-user-release.sh lays it out) must acquire it.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JC_EXIT } from '../dist/mcp-http-client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '..');
const repoNodeModules = path.resolve(app, '..', '..', 'node_modules');
const COMMIT = '0c0ffee5ab1e';

let failures = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

function managedEnv(base) {
  const { publicKey } = generateKeyPairSync('ed25519');
  return {
    PATH: process.env.PATH,
    HOME: path.join(base, 'home'),
    JC_STATE_DIR: path.join(base, 'state'),
    JC_ACS_PUBLIC_KEY: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    JC_ACS_KEY_ID: 'release-gate-test',
    DESKTOP_COMMANDER_EXECUTOR_LOCK_DIR: path.join(base, 'locks'),
  };
}

/** Runs `<entrypoint> serve` in managed mode until it exits or `until` matches stderr. */
function serve(entrypoint, env, until) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint, 'serve'], { env, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out; stderr:\n${stderr}`)); }, 30_000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (until && until.test(stderr)) {
        clearTimeout(timer);
        resolve({ child, stderr, running: true });
      }
    });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stderr, running: false }); });
    child.on('error', reject);
  });
}

test('REGRESSION: a managed serve from the development checkout refuses and never writes the lease', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-gate-dev-'));
  const env = managedEnv(base);
  const result = await serve(path.join(app, 'dist', 'cli.js'), env);
  assert.equal(result.running, false, result.stderr);
  assert.equal(result.code, JC_EXIT.authorityUnavailable, result.stderr);
  assert.match(result.stderr, /requires a verified installed release \(not-an-installed-release/u, result.stderr);
  assert.equal(fs.existsSync(path.join(env.DESKTOP_COMMANDER_EXECUTOR_LOCK_DIR, 'executor.lock')), false, 'dev checkout must not occupy the slot');
  fs.rmSync(base, { recursive: true, force: true });
});

test('the same build staged as an installed release acquires the lease bound to its commit', async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-gate-rel-')));
  const rel = path.join(base, 'releases', `1.0.0-${COMMIT}`);
  fs.mkdirSync(rel, { recursive: true });
  fs.cpSync(path.join(app, 'dist'), path.join(rel, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(app, 'package.json'), path.join(rel, 'package.json'));
  fs.symlinkSync(repoNodeModules, path.join(rel, 'node_modules'));
  fs.writeFileSync(path.join(rel, 'RELEASE.json'), JSON.stringify({ version: '1.0.0', commit: COMMIT }));
  fs.symlinkSync(rel, path.join(base, 'current'));
  const env = managedEnv(base);
  const result = await serve(path.join(base, 'current', 'dist', 'cli.js'), env, /holding executor lease/u);
  try {
    assert.equal(result.running, true, result.stderr);
    const lease = JSON.parse(fs.readFileSync(path.join(env.DESKTOP_COMMANDER_EXECUTOR_LOCK_DIR, 'executor.lock'), 'utf8'));
    assert.equal(lease.executorKind, 'jace-commander');
    assert.equal(lease.releaseCommit, COMMIT);
    assert.equal(lease.releaseRoot, path.join(base, 'current'));
  } finally {
    // Stop the child before removing the release it runs from.
    if (result.child) {
      const exited = new Promise((resolve) => result.child.once('exit', resolve));
      result.child.kill('SIGTERM');
      await exited;
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
});

let passed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(`\n${passed}/${cases.length} executor-lease release-gate checks passed`);
if (failures > 0) process.exit(1);
