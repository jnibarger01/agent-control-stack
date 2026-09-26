import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireExecutorLease, releaseLease } from '../dist/executor-lock.js';

if (process.platform !== 'linux') {
  console.log('Linux process identity tests skipped on this platform');
} else {
  const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const stat = fs.readFileSync('/proc/self/stat', 'utf8');
  const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19];
  function check(name, identity, expected) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-lease-identity-'));
    const file = path.join(dir, 'executor.lock');
    const lease = { instanceId: 'previous-owner', pid: process.pid,
      acquiredAt: Date.now() - 60000, renews: 0, expiresAt: 0,
      hostname: os.hostname(), ...identity };
    fs.writeFileSync(file, JSON.stringify(lease));
    try {
      const result = acquireExecutorLease({ lockDir: dir, useFlock: false });
      assert.equal(result.ok, expected, name);
      if (!expected) assert.equal(JSON.parse(fs.readFileSync(file)).instanceId, 'previous-owner');
    } finally { releaseLease({ lockDir: dir }); fs.rmSync(dir, { recursive: true, force: true }); }
    console.log('ok:', name);
  }
  check('live matching process cannot be displaced even with expired TTL',
    { bootId, processStartTicks: startTicks }, false);
  check('legacy live PID without identity remains fail-closed', {}, false);
  check('malformed identity remains fail-closed', { bootId: 42, processStartTicks: [] }, false);
  check('PID reused after reboot does not block executor recovery',
    { bootId: '00000000-0000-4000-8000-000000000000', processStartTicks: startTicks }, true);
  check('PID reused within the same boot does not block recovery',
    { bootId, processStartTicks: String(BigInt(startTicks) + 1n) }, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-lease-new-identity-'));
  try {
    const result = acquireExecutorLease({ lockDir: dir, useFlock: false });
    assert.equal(result.ok, true);
    assert.equal(result.leaseInfo.bootId, bootId);
    assert.equal(result.leaseInfo.processStartTicks, startTicks);
    assert.equal(acquireExecutorLease({ lockDir: dir, instanceId: 'competitor' }).ok, false);
    console.log('ok: new leases persist boot and process identity; second executor refused');
  } finally { releaseLease({ lockDir: dir }); fs.rmSync(dir, { recursive: true, force: true }); }
}
