/**
 * Tests for src/executor-lock.ts — the executor singleton lock/lease.
 *
 * Proves:
 *  1. first lease acquires
 *  2. second concurrent acquire fails with the blocker PID
 *  3. stale takeover works with a tiny staleAfterMs and a fake dead PID
 *  4. release allows reacquire
 *  5. claimCanonicalExecutor throws ExecutorLeaseConflictError when blocked
 *  6. detectCompetingExecutors reports stale lease files
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

import {
  acquireExecutorLease,
  renewLease,
  releaseLease,
  claimCanonicalExecutor,
  detectCompetingExecutors,
  ExecutorLeaseConflictError,
  isPidAlive,
} from '../dist/executor-lock.js';

function freshLockDir() {
  const dir = path.join(os.tmpdir(), `dc-executor-lock-test-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeLeaseFile(dir, leaseInfo) {
  const lockPath = path.join(dir, 'executor.lock');
  fs.writeFileSync(lockPath, JSON.stringify(leaseInfo, null, 2));
  return lockPath;
}

async function testFirstLeaseAcquires() {
  console.log('\n--- Test: first lease acquires ---');
  const dir = freshLockDir();
  const result = acquireExecutorLease({ instanceId: 'inst-1', lockDir: dir, staleAfterMs: 60_000 });
  assert.strictEqual(result.ok, true, 'first acquire must succeed');
  assert.strictEqual(result.leaseInfo.instanceId, 'inst-1');
  assert.strictEqual(result.leaseInfo.pid, process.pid);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'executor.lock'), 'utf8'));
  assert.strictEqual(onDisk.instanceId, 'inst-1', 'lease must be persisted to disk');
  releaseLease({ lockDir: dir });
  console.log('ok: first lease acquired and persisted');
}

async function testSecondConcurrentAcquireFails() {
  console.log('\n--- Test: second concurrent acquire fails with blocker PID ---');
  const dir = freshLockDir();
  const first = acquireExecutorLease({ instanceId: 'inst-A', lockDir: dir, staleAfterMs: 60_000 });
  assert.strictEqual(first.ok, true);

  const second = acquireExecutorLease({ instanceId: 'inst-B', lockDir: dir, staleAfterMs: 60_000 });
  assert.strictEqual(second.ok, false, 'second acquire must fail while first is held');
  assert.strictEqual(second.reason, 'held-by-live-process');
  assert.match(second.blockedBy, new RegExp(`pid:${process.pid}`), `blockedBy must name the holder PID, got ${second.blockedBy}`);
  assert.strictEqual(second.leaseInfo.instanceId, 'inst-A');

  releaseLease({ lockDir: dir });
  console.log(`ok: second acquire blocked by ${second.blockedBy}`);
}

async function testStaleTakeoverWithFakeDeadPid() {
  console.log('\n--- Test: stale takeover with tiny staleAfterMs and fake dead PID ---');
  const dir = freshLockDir();

  // Find a real PID that is guaranteed dead: spawn and exit.
  const { execFileSync } = await import('child_process');
  const deadPid = parseInt(
    execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).toString().trim(),
    10,
  );
  assert.strictEqual(isPidAlive(deadPid), false, 'test setup: chosen PID must be dead');

  // A lease from a dead PID, acquired "long ago" (beyond any grace window).
  writeLeaseFile(dir, {
    instanceId: 'crashed-instance',
    pid: deadPid,
    acquiredAt: Date.now() - 10 * 60 * 1000,
    renews: 0,
    expiresAt: Date.now() - 5 * 60 * 1000,
    hostname: 'old-host',
  });

  const staleEvents = [];
  const takeover = acquireExecutorLease({
    instanceId: 'new-instance',
    lockDir: dir,
    staleAfterMs: 1, // tiny: any stale lease is immediately takeable
    onStale: (info) => staleEvents.push(info),
  });

  assert.strictEqual(takeover.ok, true, 'takeover of a stale (dead PID) lease must succeed');
  assert.strictEqual(takeover.tookOverStale, true, 'result must flag tookOverStale');
  assert.strictEqual(takeover.reason, 'stale-taken-over');
  assert.ok(staleEvents.length >= 1, 'onStale must fire for the stale lease');
  assert.strictEqual(staleEvents[0].cause, 'dead-pid');
  assert.strictEqual(takeover.leaseInfo.instanceId, 'new-instance');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'executor.lock'), 'utf8'));
  assert.strictEqual(onDisk.instanceId, 'new-instance', 'lockfile must now name the new instance');

  releaseLease({ lockDir: dir });
  console.log(`ok: stale lease from dead pid ${deadPid} taken over after onStale fired`);
}

async function testReleaseAllowsReacquire() {
  console.log('\n--- Test: release allows reacquire ---');
  const dir = freshLockDir();
  const a = acquireExecutorLease({ instanceId: 'inst-1', lockDir: dir, staleAfterMs: 60_000 });
  assert.strictEqual(a.ok, true);

  const blocked = acquireExecutorLease({ instanceId: 'inst-2', lockDir: dir, staleAfterMs: 60_000 });
  assert.strictEqual(blocked.ok, false);

  const rel = releaseLease({ lockDir: dir });
  assert.strictEqual(rel.ok, true, 'release must succeed when held');
  assert.ok(!fs.existsSync(path.join(dir, 'executor.lock')), 'lockfile must be removed on release');

  const b = acquireExecutorLease({ instanceId: 'inst-2', lockDir: dir, staleAfterMs: 60_000 });
  assert.strictEqual(b.ok, true, 'reacquire after release must succeed');
  assert.strictEqual(b.leaseInfo.instanceId, 'inst-2');

  const doubleRelease = releaseLease({ lockDir: dir });
  assert.strictEqual(doubleRelease.ok, true, 'idempotent release is fine');
  releaseLease({ lockDir: dir });
  console.log('ok: release removes lockfile and reacquire succeeds');
}

async function testRenewExtendsTtl() {
  console.log('\n--- Test: renew extends the lease TTL ---');
  const dir = freshLockDir();
  acquireExecutorLease({ instanceId: 'inst-1', lockDir: dir, staleAfterMs: 50 });
  const before = JSON.parse(fs.readFileSync(path.join(dir, 'executor.lock'), 'utf8'));
  await new Promise((r) => setTimeout(r, 20));
  const renewed = renewLease({ lockDir: dir, staleAfterMs: 60_000 });
  assert.strictEqual(renewed.ok, true, 'renew must succeed while held');
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'executor.lock'), 'utf8'));
  assert.strictEqual(after.renews, before.renews + 1);
  assert.ok(after.expiresAt > before.expiresAt, 'renew must extend the expiry');
  releaseLease({ lockDir: dir });
  console.log('ok: renew bumps renews and extends expiresAt');
}

async function testClaimCanonicalExecutorThrowsWhenBlocked() {
  console.log('\n--- Test: claimCanonicalExecutor throws ExecutorLeaseConflictError ---');
  const dir = freshLockDir();
  const holder = acquireExecutorLease({ instanceId: 'holder', lockDir: dir, staleAfterMs: 60_000 });
  assert.strictEqual(holder.ok, true);

  assert.throws(
    () => claimCanonicalExecutor({ instanceId: 'challenger', lockDir: dir, staleAfterMs: 60_000 }),
    (err) => {
      assert.ok(err instanceof ExecutorLeaseConflictError, 'must be ExecutorLeaseConflictError');
      assert.match(err.blockedBy, /pid:/, 'error must name the blocking PID');
      assert.match(err.message, /singleton lease/);
      return true;
    },
    'claimCanonicalExecutor must throw when the lease is held by a live process',
  );

  releaseLease({ lockDir: dir });
  const nowFree = claimCanonicalExecutor({ instanceId: 'challenger', lockDir: dir, staleAfterMs: 60_000 });
  assert.strictEqual(nowFree.ok, true, 'claim must succeed once the lease is free');
  releaseLease({ lockDir: dir });
  console.log('ok: claimCanonicalExecutor throws on conflict, succeeds when free');
}

async function testDetectCompetingExecutorsReportsStaleLease() {
  console.log('\n--- Test: detectCompetingExecutors reports stale leases ---');
  const dir = freshLockDir();
  writeLeaseFile(dir, {
    instanceId: 'ghost',
    pid: 2 ** 22, // implausibly high pid on Linux (pid_max default 4194304-ish; use one that is surely dead)
    acquiredAt: Date.now() - 60 * 60 * 1000,
    renews: 0,
    expiresAt: Date.now() - 30 * 60 * 1000,
    hostname: 'ghost-host',
  });

  const report = detectCompetingExecutors(dir);
  assert.strictEqual(typeof report.checkedAt, 'number');
  assert.ok(Array.isArray(report.competing));
  const stale = report.staleLeases;
  assert.strictEqual(stale.length, 1, 'must report exactly the one stale lease file');
  assert.strictEqual(stale[0].kind, 'stale-lease');
  assert.match(stale[0].detail, /stale lease file/);
  assert.ok(report.competing.some((c) => c.kind === 'stale-lease'), 'competing must include the stale lease');
  console.log(`ok: detectCompetingExecutors found stale lease: ${stale[0].detail}`);
}

export default async function runTests() {
  try {
    await testFirstLeaseAcquires();
    await testSecondConcurrentAcquireFails();
    await testStaleTakeoverWithFakeDeadPid();
    await testReleaseAllowsReacquire();
    await testRenewExtendsTtl();
    await testClaimCanonicalExecutorThrowsWhenBlocked();
    await testDetectCompetingExecutorsReportsStaleLease();
    console.log('\nexecutor singleton lock tests passed.');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('executor singleton lock test failed:', message);
    if (error instanceof Error && error.stack) console.error(error.stack);
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests()
    .then((success) => process.exit(success ? 0 : 1))
    .catch((error) => {
      console.error('Unhandled error:', error);
      process.exit(1);
    });
}
