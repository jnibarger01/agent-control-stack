/**
 * Tests for src/cancellation/executor-recovery.ts — post-cancellation
 * recovery checkup.
 *
 * Proves:
 *  1. spawn a long-running `sleep` child, kill it → checkup reports
 *     childDead=true and clean state
 *  2. a second immediate tool-like spawn succeeds right after (regression
 *     for "next command succeeds after timeout")
 *  3. orphaned descendants in the child's process group get cleaned up
 */
import assert from 'assert';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

import { runRecoveryCheckup, verifyEnvironmentUsable } from '../dist/cancellation/executor-recovery.js';
import { isPidAlive } from '../dist/executor-lock.js';

function isAlive(pid) {
  return isPidAlive(pid);
}

async function waitUntilDead(pid, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

/** Spawn a child the way command-manager does: detached, own process group. */
function spawnDetached(cmd, args, markerFile = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.exitCodePromise = new Promise((res) => {
      child.once('exit', (code) => res(code));
      child.once('error', () => res(-1));
    });
    child.on('error', reject);
    // give the pid a moment to be real
    setTimeout(() => resolve(child), 50);
  });
}

async function testKillSleepThenRecoveryClean() {
  console.log('\n--- Test: kill long-running sleep child, recovery reports clean ---');
  const child = await spawnDetached('sleep', ['300']);
  assert.ok(child.pid > 0, 'child must have a pid');
  assert.strictEqual(isAlive(child.pid), true, 'sleep child should be alive before kill');

  // Simulate the cancel/timeout path: SIGKILL the direct child.
  process.kill(child.pid, 'SIGKILL');
  const died = await waitUntilDead(child.pid, 5000);
  assert.strictEqual(died, true, 'child must die after SIGKILL');

  const report = await runRecoveryCheckup({ killedChildPid: child.pid });
  console.log('  checkup:', JSON.stringify(report));
  assert.strictEqual(report.childDead, true, 'checkup must confirm the child is dead');
  assert.strictEqual(report.ready, true, 'checkup must report ready state');
  assert.strictEqual(typeof report.descendantsKilled, 'number');
  assert.strictEqual(typeof report.leaseStillHeld, 'boolean');
  console.log('ok: recovery checkup reports childDead=true, ready=true');
  return true;
}

async function testNextImmediateSpawnSucceeds() {
  console.log('\n--- Test: next immediate tool-like spawn succeeds after a timeout kill ---');
  // First: a long-running child that "times out" and is killed.
  const child = await spawnDetached('sleep', ['300']);
  process.kill(child.pid, 'SIGKILL');
  await waitUntilDead(child.pid, 5000);
  await runRecoveryCheckup({ killedChildPid: child.pid });

  // Regression: an immediate subsequent spawn must succeed.
  const next = await spawnDetached('echo', ['next-command-ok']);
  assert.ok(next.pid > 0, 'immediate next spawn must get a pid');
  const exitCode = await Promise.race([
    next.exitCodePromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('next spawn did not exit in time')), 5000)),
  ]);
  assert.strictEqual(exitCode, 0, `next command must exit 0, got ${exitCode}`);

  const usable = await verifyEnvironmentUsable();
  assert.strictEqual(usable, true, 'environment must be usable right after a kill+checkup');
  console.log(`ok: next command exited ${exitCode} immediately after timeout kill`);
}

async function testOrphanedGrandchildCleanedUp() {
  console.log('\n--- Test: orphaned grandchild in the process group is killed by checkup ---');
  if (process.platform === 'win32') {
    console.log('skipping on win32 (POSIX process-group semantics)');
    return;
  }
  const tag = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const pidFile = path.join(os.tmpdir(), `dc-recovery-test-${tag}.pid`);
  const scriptFile = path.join(os.tmpdir(), `dc-recovery-test-${tag}.cjs`);

  // Wrapper spawns a grandchild that ignores SIGTERM, then the wrapper exits
  // (simulating the direct child dying while its group still holds a
  // descendant). Grandchild stays in the wrapper's process group because
  // only the wrapper itself spawned detached.
  const script = `
    const { spawn } = require('child_process');
    const fs = require('fs');
    const gc = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid));
    setTimeout(() => process.exit(0), 100);
  `;
  fs.writeFileSync(scriptFile, script);

  try {
    const wrapper = await spawnDetached(process.execPath, [scriptFile]);
    // wait for the grandchild pid file, then let the wrapper exit on its own
    let grandchildPid = 0;
    for (let i = 0; i < 50 && !grandchildPid; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        grandchildPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      } catch { /* not written yet */ }
    }
    assert.ok(grandchildPid > 0, 'grandchild pid must be recorded');
    assert.strictEqual(isAlive(grandchildPid), true, 'grandchild alive before checkup');

    await waitUntilDead(wrapper.pid, 5000); // wrapper self-exits
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(isAlive(grandchildPid), true, 'grandchild must survive its parent here (orphan scenario)');

    // Recovery checkup on the (already dead) child: must clean the group.
    const report = await runRecoveryCheckup({ killedChildPid: wrapper.pid, settleMs: 100 });
    console.log('  checkup:', JSON.stringify(report));
    assert.strictEqual(report.childDead, true);
    const grandchildDied = await waitUntilDead(grandchildPid, 10000);
    assert.strictEqual(
      grandchildDied,
      true,
      'orphaned grandchild must be killed by the recovery checkup (process-group cleanup)',
    );
    assert.strictEqual(report.ready, true);
    console.log(`ok: orphaned grandchild ${grandchildPid} cleaned up by checkup`);
  } finally {
    fs.rmSync(pidFile, { force: true });
    fs.rmSync(scriptFile, { force: true });
  }
}

export default async function runTests() {
  try {
    await testKillSleepThenRecoveryClean();
    await testNextImmediateSpawnSucceeds();
    await testOrphanedGrandchildCleanedUp();
    console.log('\ncancellation recovery tests passed.');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('cancellation recovery test failed:', message);
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
