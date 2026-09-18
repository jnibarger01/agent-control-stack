/**
 * Hash-chained audit log tests.
 * Run: node test/test-audit-chain.js
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { AuditChain, verifyChain, storePayload } = await import('../dist/audit/audit-chain.js');

// Isolate HOME so we never touch the real ~/.desktop-commander.
// os.homedir() reads $HOME on POSIX, so set it BEFORE importing the module.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-audit-test-'));
process.env.HOME = fakeHome;

const chainDir = path.join(fakeHome, '.desktop-commander', 'audit');
fs.mkdirSync(chainDir, { recursive: true });
const chainFile = path.join(chainDir, 'audit-test.jsonl');

try {
  const chain = new AuditChain(chainFile);

  // 1. Append 20 events.
  for (let i = 1; i <= 20; i++) {
    const payload = storePayload(`stdout of event ${i}`);
    chain.append({
      kind: 'invocation',
      tool: 'run_command',
      agent: 'test-agent',
      transport: 'mcp',
      sourceAgent: 'chatgpt',
      executorPid: process.pid,
      durationMs: 12,
      stdoutRef: payload,
      exitCode: 0,
    });
  }

  const clean = verifyChain(chainFile);
  assert.equal(clean.valid, true, `fresh chain must verify: ${clean.error}`);
  assert.equal(clean.events, 20);
  console.log('PASS fresh 20-event chain verifies');

  // 2. Tamper with one byte in the middle of the file.
  const stat = fs.statSync(chainFile);
  const buf = fs.readFileSync(chainFile);
  // Flip a byte roughly 55% into the file — inside an event's data, not '\n'.
  const offset = Math.floor(stat.size * 0.55);
  assert.notEqual(buf[offset], 0x0a, 'tamper byte should not be a newline');
  buf[offset] = buf[offset] === 0x61 ? 0x62 : 0x61;
  fs.writeFileSync(chainFile, buf);

  const tampered = verifyChain(chainFile);
  assert.equal(tampered.valid, false, 'tampered chain must FAIL verification');
  assert.notEqual(tampered.brokenAt, null);
  console.log(`PASS tampered chain fails verify (brokenAt=${tampered.brokenAt}, ${tampered.error})`);

  // 3. Fresh chain (new file) verifies clean again.
  const freshFile = path.join(chainDir, 'audit-fresh.jsonl');
  const freshChain = new AuditChain(freshFile);
  freshChain.append({ kind: 'request', agent: 't' });
  const fresh = verifyChain(freshFile);
  assert.equal(fresh.valid, true, `fresh chain after tamper verifies: ${fresh.error}`);
  console.log('PASS fresh chain after tamper verifies clean');

  // 4. read() API.
  const { events } = freshChain.read();
  assert.equal(events.length, 1);
  const { events: limited } = freshChain.read({ limit: 1 });
  assert.equal(limited.length, 1);
  console.log('PASS read({limit}) works');

  // 5. follow tail emits appended events.
  const { follow } = freshChain.read({ follow: true });
  const received = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('follow timeout')), 5000);
    follow.on('event', (e) => { clearTimeout(timer); resolve(e); });
  });
  await new Promise((r) => setTimeout(r, 700)); // let a tail poll tick first
  freshChain.append({ kind: 'result', exitCode: 0, agent: 't' });
  const event = await received;
  follow.close();
  assert.equal(event.kind, 'result');
  console.log('PASS follow tail emits appended events');
  console.log('ALL AUDIT TESTS PASSED');
} finally {
  fs.rmSync(fakeHome, { recursive: true, force: true });
}
