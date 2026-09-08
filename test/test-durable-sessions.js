/**
 * P2.1 durable process sessions — end-to-end invariants from
 * docs/architecture/p2.1-durable-sessions.md, verified against real
 * spawned processes and a real (isolated, temp) session-store directory.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TerminalManager } from '../dist/terminal-manager.js';
import { reconcileSessionsOnStartup } from '../dist/session-reconciliation.js';
import {
  writeSessionRecord,
  readSessionRecord,
  newSessionId,
  sessionSchemaVersion,
  sessionsDirectory,
} from '../dist/session-store.js';
import { getProcessStartFingerprint } from '../dist/utils/process-identity.js';
import {
  ManagedAcsGuard,
  computeDesktopCommanderInvocationHash,
  strictCanonicalJsonV1,
} from '../dist/managed-acs.js';

const NODE = process.execPath;

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitUntilDead(pid, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

async function waitUntil(fn, timeoutMs, intervalMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

let stateDirCounter = 0;
async function withIsolatedStateDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `dc-durable-sessions-${stateDirCounter++}-`));
  const previous = process.env.DESKTOP_COMMANDER_STATE_DIR;
  process.env.DESKTOP_COMMANDER_STATE_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.DESKTOP_COMMANDER_STATE_DIR;
    else process.env.DESKTOP_COMMANDER_STATE_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Test 1: a live durable session can be rediscovered after a simulated restart
// ---------------------------------------------------------------------------
async function testLiveSessionRediscoveredAfterRestart() {
  console.log('\n--- Test: a live session is rediscovered after a simulated restart ---');
  await withIsolatedStateDir(async () => {
    const manager = new TerminalManager();
    const result = await manager.executeCommand(
      `${JSON.stringify(NODE)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
      500,
    );
    assert.ok(result.pid > 0);

    try {
      // "Restart": a brand-new TerminalManager knows nothing about `manager`'s
      // in-memory state — only the durable record on disk exists to recover from.
      const freshManager = new TerminalManager();
      const summary = await reconcileSessionsOnStartup();
      assert.equal(summary.recovered.length, 1, 'exactly the one live session must be recovered');
      assert.equal(summary.recovered[0].pid, result.pid);

      for (const handle of summary.recovered) freshManager.registerRecoveredSession(handle);

      const active = freshManager.listActiveSessions();
      const recoveredEntry = active.find((s) => s.pid === result.pid);
      assert.ok(recoveredEntry, 'recovered session must appear in listActiveSessions');
      assert.equal(recoveredEntry.recovered, true);

      assert.equal(freshManager.forceTerminate(result.pid), true, 'a recovered session must be terminable');
      assert.ok(await waitUntilDead(result.pid, 5000), 'the process must actually die');
    } finally {
      freshTerminateIfAlive(result.pid);
    }
  });
  console.log('ok: live session survives a simulated restart and remains terminable');
}

// ---------------------------------------------------------------------------
// Test 2: a completed process is not incorrectly resurrected
// ---------------------------------------------------------------------------
async function testCompletedProcessNotResurrected() {
  console.log('\n--- Test: a completed process is not resurrected on reconciliation ---');
  await withIsolatedStateDir(async () => {
    const manager = new TerminalManager();
    const result = await manager.executeCommand(`${JSON.stringify(NODE)} -e "process.exit(0)"`, 5000);
    assert.equal(result.pid > 0, true);

    // Give the async persistSessionExit() write a moment to land.
    await waitUntil(async () => {
      const files = await fs.readdir(sessionsDirectory()).catch(() => []);
      if (files.length === 0) return false;
      const record = await readSessionRecord(path.basename(files[0], '.json'));
      return record?.status === 'completed';
    }, 3000);

    const summary = await reconcileSessionsOnStartup();
    assert.equal(summary.recovered.length, 0, 'a completed session must never be recovered as live');
    assert.equal(summary.alreadyTerminal, 1);
  });
  console.log('ok: completed sessions stay completed, never resurrected');
}

// ---------------------------------------------------------------------------
// Test 3: a stale record (process genuinely gone) is classified safely
// ---------------------------------------------------------------------------
async function testStaleRecordClassifiedSafely() {
  console.log('\n--- Test: a stale record (process gone) is classified safely, not adopted ---');
  await withIsolatedStateDir(async () => {
    // Spawn and let it exit on its own, outside of terminal-manager, to get
    // a pid that is guaranteed not alive and not one of our tracked sessions.
    const { spawn } = await import('node:child_process');
    const child = spawn(NODE, ['-e', 'process.exit(0)']);
    const deadPid = child.pid;
    await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(isAlive(deadPid), false);

    const now = new Date().toISOString();
    await writeSessionRecord({
      schemaVersion: sessionSchemaVersion(),
      sessionId: newSessionId(),
      pid: deadPid,
      processStartFingerprint: 'linux:starttime:999999999', // irrelevant — pid is dead either way
      command: 'echo test',
      ownerRuntimeId: 'runtime-test',
      createdAt: now,
      updatedAt: now,
      status: 'running',
    });

    const summary = await reconcileSessionsOnStartup();
    assert.equal(summary.recovered.length, 0, 'a dead pid must never be recovered');
    assert.equal(summary.markedStale, 1);
  });
  console.log('ok: a running-but-now-dead record is marked stale, never adopted');
}

// ---------------------------------------------------------------------------
// Test 4: PID reuse / identity mismatch is rejected, not adopted
// ---------------------------------------------------------------------------
async function testPidReuseRejected() {
  console.log('\n--- Test: PID reuse is detected and rejected, not adopted as a recovered session ---');
  await withIsolatedStateDir(async () => {
    const { spawn } = await import('node:child_process');
    const impostor = spawn(NODE, ['-e', 'setInterval(() => {}, 1000)']);
    try {
      await waitUntil(() => isAlive(impostor.pid), 2000);
      const realFingerprint = await getProcessStartFingerprint(impostor.pid);
      assert.ok(realFingerprint, 'must be able to fingerprint a real live process on this platform');

      const now = new Date().toISOString();
      await writeSessionRecord({
        schemaVersion: sessionSchemaVersion(),
        sessionId: newSessionId(),
        pid: impostor.pid,
        // Deliberately wrong fingerprint — simulates: this pid belonged to a
        // Desktop Commander session before, but the OS has since reused it
        // for an unrelated process (here: `impostor` itself stands in for
        // that unrelated process).
        processStartFingerprint: 'linux:starttime:1',
        command: 'some other command entirely',
        ownerRuntimeId: 'runtime-test',
        createdAt: now,
        updatedAt: now,
        status: 'running',
      });

      const summary = await reconcileSessionsOnStartup();
      assert.equal(summary.recovered.length, 0, 'a fingerprint mismatch must never be adopted, even though the pid is alive');
      assert.equal(summary.markedStale, 1);

      const record = (await fs.readdir(sessionsDirectory()))
        .filter((f) => f.endsWith('.json'))[0];
      const persisted = await readSessionRecord(path.basename(record, '.json'));
      assert.equal(persisted.status, 'stale');
      assert.match(persisted.staleReason, /reused/);
    } finally {
      impostor.kill('SIGKILL');
    }
  });
  console.log('ok: PID reuse is detected via start-time fingerprint mismatch and rejected');
}

// ---------------------------------------------------------------------------
// Test 5: corrupt persisted state fails closed at the reconciliation level
// ---------------------------------------------------------------------------
async function testCorruptStateFailsClosedOnReconciliation() {
  console.log('\n--- Test: corrupt persisted state fails closed during reconciliation ---');
  await withIsolatedStateDir(async () => {
    const dir = sessionsDirectory();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(dir, `${crypto.randomUUID()}.json`), 'not even json');

    const summary = await reconcileSessionsOnStartup();
    assert.equal(summary.recovered.length, 0);
    assert.equal(summary.corrupt, 1);
  });
  console.log('ok: corrupt records never become recovered sessions, and are reported');
}

// ---------------------------------------------------------------------------
// Test 6: cancellation/force termination after recovery still uses
// process-tree semantics (no orphaned grandchildren)
// ---------------------------------------------------------------------------
async function testForceTerminateAfterRecoveryKillsWholeTree() {
  console.log('\n--- Test: force_terminate after recovery still reaches the whole process tree ---');
  await withIsolatedStateDir(async () => {
    const tag = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const pidFile = path.join(os.tmpdir(), `dc-durable-orphan-${tag}.pid`);
    const scriptFile = path.join(os.tmpdir(), `dc-durable-orphan-${tag}.cjs`);
    const script = `
      const { spawn } = require('child_process');
      const fs = require('fs');
      const gc = spawn(process.execPath, ['-e', "process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid));
      process.on('SIGINT', () => {});
      setInterval(() => {}, 1000);
    `;
    await fs.writeFile(scriptFile, script);

    let wrapperPid;
    let grandchildPid;
    try {
      const manager = new TerminalManager();
      const result = await manager.executeCommand(`${JSON.stringify(NODE)} ${JSON.stringify(scriptFile)}`, 1500);
      wrapperPid = result.pid;
      assert.ok(result.pid > 0);

      await waitUntil(() => fsSync.existsSync(pidFile), 5000);
      grandchildPid = parseInt((await fs.readFile(pidFile, 'utf8')).trim(), 10);
      assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);

      // Simulated restart.
      const freshManager = new TerminalManager();
      const summary = await reconcileSessionsOnStartup();
      assert.equal(summary.recovered.length, 1);
      freshManager.registerRecoveredSession(summary.recovered[0]);

      assert.equal(freshManager.forceTerminate(result.pid), true);
      assert.ok(await waitUntilDead(result.pid, 5000), 'wrapper must die');
      assert.ok(
        await waitUntilDead(grandchildPid, 10000),
        'grandchild must not be orphaned — recovered-session termination must use the same process-tree kill as a live session',
      );
    } finally {
      if (wrapperPid) freshTerminateIfAlive(wrapperPid);
      if (grandchildPid) freshTerminateIfAlive(grandchildPid);
      await fs.rm(pidFile, { force: true }).catch(() => undefined);
      await fs.rm(scriptFile, { force: true }).catch(() => undefined);
    }
  });
  console.log('ok: recovered-session termination reaches the whole process tree, no orphans');
}

// ---------------------------------------------------------------------------
// Test 7: recovered-session actions still pass through authorization checks
// ---------------------------------------------------------------------------
function testRecoveryDoesNotBypassAuthorization() {
  console.log('\n--- Test: recovery creates no new authority — authorize() knows nothing about it ---');

  // Same repository-owned public test keypair used by test-managed-acs.js
  // and test/fixtures/acs-test-fixture.js.
  const rawPublicKey = Buffer.from('11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo', 'base64url');
  const publicKeyDer = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawPublicKey]);
  const privateKeyDer = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'),
  ]);
  const privateKey = crypto.createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' });

  const now = Date.parse('2026-01-01T00:00:10.000Z');
  const guard = new ManagedAcsGuard({
    mode: 'managed',
    runtimeId: 'runtime_01',
    publicKey: publicKeyDer.toString('base64url'),
    keyId: 'test-key-1',
    allowedScopes: ['process.exec'],
    now: () => now,
  });
  guard.initialize({
    acsRuntimeBootstrap: {
      schemaVersion: 1,
      runtimeId: 'runtime_01',
      challenge: Buffer.alloc(32, 7).toString('base64url'),
      scopes: ['process.exec'],
    },
  });

  const pid = 4242; // arbitrary — the point is authorize() never looks this up anywhere
  const args = { pid };

  function sign(payload) {
    return {
      payload,
      keyId: 'test-key-1',
      signature: crypto.sign(null, Buffer.from(strictCanonicalJsonV1(payload)), privateKey).toString('base64url'),
    };
  }
  function payload(overrides = {}) {
    const normalizedArguments = overrides.normalizedArguments ?? args;
    const toolName = overrides.toolName ?? 'read_process_output';
    return {
      version: 'acs.dc.v1',
      issuer: 'acs',
      audience: 'desktop-commander',
      runtimeId: 'runtime_01',
      workItemId: 'work_01',
      attemptId: 'attempt_01',
      leaseId: 'lease_01',
      leaseEpoch: 1,
      toolName,
      normalizedArguments,
      invocationHash: computeDesktopCommanderInvocationHash(toolName, normalizedArguments),
      actionHash: 'b'.repeat(64),
      requestHash: 'e'.repeat(64),
      planHash: 'd'.repeat(64),
      scopes: ['process.exec'],
      issuedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:00:30.000Z',
      nonce: crypto.randomBytes(32).toString('base64url'),
      ...overrides,
    };
  }

  // A pid that happens to belong to a recovered session is, to authorize(),
  // indistinguishable from any other pid — its signature only ever sees
  // (toolName, normalizedArguments, meta). No branch anywhere in this
  // codebase asks "was this session recovered?" before authorizing.
  assert.throws(
    () => guard.authorize('read_process_output', args, undefined),
    (error) => error.code === 'ACS_CAPABILITY_MISSING',
    'no capability at all must still be denied for a recovered-session pid, exactly as for any other',
  );

  const granted = guard.authorize('read_process_output', args, { acsCapability: sign(payload()) });
  assert.equal(granted.toolName, 'read_process_output');
  assert.deepEqual(granted, guard.authorize('read_process_output', args, { acsCapability: sign(payload()) }));

  console.log('ok: authorization is a pure function of (toolName, args, capability) — recovery adds no authority');
}

// ---------------------------------------------------------------------------
// Test 8: repeated reconciliation is idempotent
// ---------------------------------------------------------------------------
async function testReconciliationIsIdempotent() {
  console.log('\n--- Test: running reconciliation twice does not duplicate or re-mutate state ---');
  await withIsolatedStateDir(async () => {
    const manager = new TerminalManager();
    const result = await manager.executeCommand(
      `${JSON.stringify(NODE)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
      500,
    );

    try {
      const freshManager = new TerminalManager();
      const first = await reconcileSessionsOnStartup();
      assert.equal(first.recovered.length, 1);
      for (const handle of first.recovered) freshManager.registerRecoveredSession(handle);

      const second = await reconcileSessionsOnStartup();
      assert.equal(second.recovered.length, 1, 'the still-live session reconciles the same way every time');
      for (const handle of second.recovered) freshManager.registerRecoveredSession(handle);

      // No duplication: exactly one entry for this pid, not two.
      const activeForPid = freshManager.listActiveSessions().filter((s) => s.pid === result.pid);
      assert.equal(activeForPid.length, 1, 'registering the same recovered session twice must not duplicate it');
    } finally {
      freshTerminateIfAlive(result.pid);
    }
  });
  console.log('ok: reconciliation and recovered-session registration are both idempotent');
}

function freshTerminateIfAlive(pid) {
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

export default async function runTests() {
  try {
    await testLiveSessionRediscoveredAfterRestart();
    await testCompletedProcessNotResurrected();
    await testStaleRecordClassifiedSafely();
    await testPidReuseRejected();
    await testCorruptStateFailsClosedOnReconciliation();
    await testForceTerminateAfterRecoveryKillsWholeTree();
    testRecoveryDoesNotBypassAuthorization();
    await testReconciliationIsIdempotent();

    console.log('\nDurable session (P2.1) tests passed.');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Durable session test failed:', message);
    if (error instanceof Error && error.stack) console.error(error.stack);
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then((success) => process.exit(success ? 0 : 1));
}
