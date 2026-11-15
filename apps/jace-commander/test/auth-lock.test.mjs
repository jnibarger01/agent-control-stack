#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearPendingRefresh,
  pendingRefreshPath,
  readPendingRefresh,
  withAuthLock,
  writePendingRefresh,
} from '../dist/auth-lock.js';

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

await test('withAuthLock serializes concurrent in-process callers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-lock-'));
  let active = 0;
  let maxActive = 0;
  await Promise.all(
    Array.from({ length: 6 }, () =>
      withAuthLock(dir, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active -= 1;
      }),
    ),
  );
  assert.equal(maxActive, 1);
  assert.equal(fs.existsSync(path.join(dir, 'auth.lock')), false);
});

await test('withAuthLock reclaims stale lock held by a dead PID and preserves live PID lock until timeout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-lock-stale-'));
  const lockPath = path.join(dir, 'auth.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, token: 'dead', acquiredAtMs: Date.now() - 10_000 }), { mode: 0o600 });

  let ran = false;
  await withAuthLock(dir, async () => { ran = true; }, { isProcessAlive: () => false });
  assert.equal(ran, true);

  fs.writeFileSync(lockPath, JSON.stringify({ pid: 424242, token: 'live', acquiredAtMs: Date.now() }), { mode: 0o600 });
  await assert.rejects(
    () => withAuthLock(dir, async () => {}, { isProcessAlive: () => true, timeoutMs: 80, pollMs: 15 }),
    /Timed out/i,
  );
});

await test('pending-refresh journal writes 0600 atomically and clears cleanly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-pending-'));
  const record = {
    domain: 'jc-mcp',
    url: 'https://edge.test/jc/mcp',
    clientId: 'jace-commander-cli',
    deviceId: 'dev-1',
    refreshRequestId: 'req-uuid-1',
    oldRefreshTokenHash: 'abc',
    startedAt: new Date().toISOString(),
  };
  writePendingRefresh(dir, record);
  assert.equal(fs.statSync(pendingRefreshPath(dir)).mode & 0o777, 0o600);
  assert.deepEqual(readPendingRefresh(dir), record);
  clearPendingRefresh(dir);
  assert.equal(readPendingRefresh(dir), undefined);
});

console.log(`\njace-commander auth-lock: ${passed} passed`);
