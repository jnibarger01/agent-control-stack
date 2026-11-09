#!/usr/bin/env node
/**
 * Native Jace Commander executor lease (the canonical ACS singleton slot).
 *
 * A managed JC serve process must hold ~/.desktop-commander/executor.lock
 * (or DESKTOP_COMMANDER_EXECUTOR_LOCK_DIR) before it serves any tool. These
 * tests pin the properties ACS relies on: exactly one live owner, identity
 * (boot id + start ticks) rather than PID, fail-closed handling of forged or
 * unreadable records, grace-window takeover of dead owners, owner-only release,
 * and a real two-process race.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireJcExecutorLease,
  executorLeaseRequired,
  releaseJcExecutorLease,
  renewJcExecutorLease,
  resolveJcReleaseIdentity,
} from '../dist/executor-lease.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const libDir = path.resolve(here, '..', 'dist', 'executor-lease.js');
const BOOT = '0b1c2d3e-4f50-4617-8899-aabbccddeeff';
const OTHER_BOOT = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const RELEASE_ROOT = '/home/jacen/.local/lib/jace-commander/current/';

let failures = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jc-lease-'));
}

/** Identity reader for a fake holder pid: alive, with the given identity. */
function fakeWorld({ alive = [], identities = {}, bootId = BOOT, selfPid = 4242, selfTicks = '777' } = {}) {
  return {
    isAlive: (pid) => alive.includes(pid) || pid === selfPid,
    readIdentity: (pid) => {
      if (pid === selfPid) return { bootId, processStartTicks: selfTicks };
      return identities[pid];
    },
  };
}

function baseOptions(dir, world, overrides = {}) {
  return {
    lockDir: dir,
    pid: 4242,
    instanceId: `jc-4242-${Math.random().toString(36).slice(2)}`,
    releaseRoot: RELEASE_ROOT,
    releaseCommit: '607128e5fee9',
    nowMs: 1_000_000,
    ttlMs: 180_000,
    graceMs: 10_000,
    ...world,
    ...overrides,
  };
}

function writeLease(dir, record) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'executor.lock'), JSON.stringify(record, null, 2));
}

function readLease(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'executor.lock'), 'utf8'));
}

const holderRecord = (overrides = {}) => ({
  instanceId: 'holder-1',
  pid: 9001,
  acquiredAt: 900_000,
  renews: 0,
  expiresAt: 1_080_000,
  hostname: os.hostname(),
  bootId: BOOT,
  processStartTicks: '5555',
  executorKind: 'jace-commander',
  releaseRoot: RELEASE_ROOT,
  releaseCommit: '607128e5fee9',
  ...overrides,
});

test('acquires an absent lease and records native JC executor identity', () => {
  const dir = tmpDir();
  const result = acquireJcExecutorLease(baseOptions(dir, fakeWorld()));
  assert.equal(result.ok, true, JSON.stringify(result));
  const onDisk = readLease(dir);
  assert.equal(onDisk.pid, 4242);
  assert.equal(onDisk.executorKind, 'jace-commander');
  assert.equal(onDisk.releaseRoot, RELEASE_ROOT);
  assert.equal(onDisk.releaseCommit, '607128e5fee9');
  assert.equal(onDisk.bootId, BOOT);
  assert.equal(onDisk.processStartTicks, '777');
  assert.equal(onDisk.instanceId, result.record.instanceId);
  assert.equal(onDisk.expiresAt, 1_000_000 + 180_000);
});

test('refuses a second owner while the first holder is alive with the same identity', () => {
  const dir = tmpDir();
  writeLease(dir, holderRecord({ pid: 9001, bootId: BOOT, processStartTicks: '5555' }));
  const world = fakeWorld({ alive: [9001], identities: { 9001: { bootId: BOOT, processStartTicks: '5555' } } });
  const result = acquireJcExecutorLease(baseOptions(dir, world));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'held-by-live-process');
  assert.equal(readLease(dir).instanceId, 'holder-1', 'live holder must not be replaced');
});

test('takes over a dead holder only after the grace window', () => {
  const dir = tmpDir();
  writeLease(dir, holderRecord({ acquiredAt: 999_000 }));
  const world = fakeWorld({ alive: [] });
  const early = acquireJcExecutorLease(baseOptions(dir, world, { nowMs: 1_000_000 }));
  assert.equal(early.ok, false);
  assert.equal(early.reason, 'stale-within-grace');

  const late = acquireJcExecutorLease(baseOptions(dir, world, { nowMs: 1_020_000 }));
  assert.equal(late.ok, true, JSON.stringify(late));
  assert.equal(late.tookOverStale, true);
  assert.equal(readLease(dir).pid, 4242);
});

test('treats PID reuse as a stale holder, never as ownership', () => {
  const dir = tmpDir();
  writeLease(dir, holderRecord({ pid: 9001, processStartTicks: '5555', acquiredAt: 900_000 }));
  const world = fakeWorld({ alive: [9001], identities: { 9001: { bootId: BOOT, processStartTicks: '9999' } } });
  const result = acquireJcExecutorLease(baseOptions(dir, world, { nowMs: 2_000_000 }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.tookOverStale, true);
});

test('treats a lease from a previous boot as stale', () => {
  const dir = tmpDir();
  writeLease(dir, holderRecord({ pid: 9001, bootId: OTHER_BOOT, processStartTicks: '5555', acquiredAt: 900_000 }));
  const world = fakeWorld({ alive: [9001], identities: { 9001: { bootId: BOOT, processStartTicks: '5555' } } });
  const result = acquireJcExecutorLease(baseOptions(dir, world, { nowMs: 2_000_000 }));
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('a malformed or forged lease file fails closed and is never taken over', () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'executor.lock'), '{not json');
  const result = acquireJcExecutorLease(baseOptions(dir, fakeWorld(), { nowMs: 9_000_000 }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'lease-unreadable');
  assert.equal(fs.readFileSync(path.join(dir, 'executor.lock'), 'utf8'), '{not json');
});

test('refuses to acquire when this process identity cannot be established', () => {
  const dir = tmpDir();
  const result = acquireJcExecutorLease(baseOptions(dir, { isAlive: () => true, readIdentity: () => undefined }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'process-identity-unavailable');
  assert.equal(fs.existsSync(path.join(dir, 'executor.lock')), false);
});

test('renewal extends the deadline for the same owner', () => {
  const dir = tmpDir();
  const world = fakeWorld();
  const acquired = acquireJcExecutorLease(baseOptions(dir, world));
  const renewed = renewJcExecutorLease({ lockDir: dir, record: acquired.record, nowMs: 1_060_000, ttlMs: 180_000 });
  assert.equal(renewed.ok, true);
  const onDisk = readLease(dir);
  assert.equal(onDisk.instanceId, acquired.record.instanceId);
  assert.equal(onDisk.expiresAt, 1_060_000 + 180_000);
  assert.equal(onDisk.renews, 1);
});

test('renewal reports loss when another owner has replaced the lease', () => {
  const dir = tmpDir();
  const acquired = acquireJcExecutorLease(baseOptions(dir, fakeWorld()));
  writeLease(dir, holderRecord({ instanceId: 'usurper' }));
  const renewed = renewJcExecutorLease({ lockDir: dir, record: acquired.record, nowMs: 1_060_000, ttlMs: 180_000 });
  assert.equal(renewed.ok, false);
  assert.equal(renewed.reason, 'lost');
  assert.equal(readLease(dir).instanceId, 'usurper');
});

test('release removes only a lease this process still owns', () => {
  const dir = tmpDir();
  const acquired = acquireJcExecutorLease(baseOptions(dir, fakeWorld()));
  assert.equal(releaseJcExecutorLease({ lockDir: dir, record: acquired.record }).ok, true);
  assert.equal(fs.existsSync(path.join(dir, 'executor.lock')), false);

  writeLease(dir, holderRecord({ instanceId: 'other-owner' }));
  assert.equal(releaseJcExecutorLease({ lockDir: dir, record: acquired.record }).ok, false);
  assert.equal(readLease(dir).instanceId, 'other-owner');
});

test('release identity comes from the spelled entrypoint and its RELEASE.json', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'cli.js'), '');
  fs.writeFileSync(path.join(root, 'RELEASE.json'), JSON.stringify({ version: '1.0.0', commit: '607128e5fee9' }));
  assert.deepEqual(resolveJcReleaseIdentity(path.join(root, 'dist', 'cli.js')), { releaseRoot: root, releaseCommit: '607128e5fee9' });

  const bare = tmpDir();
  fs.mkdirSync(path.join(bare, 'dist'), { recursive: true });
  assert.deepEqual(
    resolveJcReleaseIdentity(path.join(bare, 'dist', 'cli.js')),
    { releaseRoot: bare, releaseCommit: 'unreleased' },
    'a runtime outside an installed release is recorded as unreleased, never as a release',
  );
});

test('standalone and local presets never require or acquire the managed lease', () => {
  assert.equal(executorLeaseRequired('managed'), true);
  assert.equal(executorLeaseRequired('standalone'), false);
  assert.equal(executorLeaseRequired('local'), false);
});

test('concurrent startup from two real processes yields exactly one owner', async () => {
  const dir = tmpDir();
  const script = `
    const { acquireJcExecutorLease } = await import(${JSON.stringify(libDir)});
    const fs = await import('node:fs');
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = fs.readFileSync('/proc/' + process.pid + '/stat', 'utf8');
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/)[19];
    const result = acquireJcExecutorLease({
      lockDir: ${JSON.stringify(dir)}, pid: process.pid, instanceId: 'racer-' + process.pid,
      releaseRoot: ${JSON.stringify(RELEASE_ROOT)}, releaseCommit: 'deadbeef', nowMs: Date.now(), ttlMs: 180000, graceMs: 10000,
      isAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } },
      readIdentity: (pid) => {
        try {
          const b = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
          const s = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
          return { bootId: b, processStartTicks: s.slice(s.lastIndexOf(')') + 2).trim().split(/\\s+/)[19] };
        } catch { return undefined; }
      },
    });
    process.stdout.write(JSON.stringify({ ok: result.ok, reason: result.reason ?? null }));
    if (result.ok) await new Promise((resolve) => setTimeout(resolve, 1500));
    process.exit(0);
  `;
  const start = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('exit', () => resolve(JSON.parse(out || '{"ok":false,"reason":"no-output"}')));
    child.on('error', reject);
  });
  const results = await Promise.all([start(), start(), start(), start()]);
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  assert.equal(results.filter((r) => !r.ok).every((r) => r.reason === 'held-by-live-process'), true, JSON.stringify(results));
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
console.log(`\n${passed}/${cases.length} executor-lease checks passed`);
if (failures > 0) process.exit(1);
