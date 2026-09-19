/**
 * Hash-chained audit log tests.
 * Run: node test/test-audit-chain.js
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { AuditChain, verifyChain, storePayload } = await import('../dist/audit/audit-chain.js');

function readChainFileEvents(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** Rewrite one event in the chain file (for tamper tests). */
function rewriteChainFile(file, originalEvents, replacement, index) {
  const events = originalEvents.map((e, i) => (i === index ? replacement : e));
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

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
  // 6. cv:2 canonicalization binds NESTED object content into the hash.
  // Red-team fix #2: the old JSON.stringify replacer-array form dropped
  // nested keys (nested:{} emitted), so tampering with nested content did
  // not break the chain.
  const cvFile = path.join(chainDir, 'audit-cv2.jsonl');
  const cvChain = new AuditChain(cvFile);
  cvChain.append({
    kind: 'invocation',
    tool: 'run_command',
    agent: 'cv-test',
    transport: 'mcp',
    args: { command: 'ls', nested: { secret: 'original-value', deeper: { k: 1 } } },
  });
  assert.equal(verifyChain(cvFile).valid, true, 'cv:2 chain must verify');

  const cvEvents = readChainFileEvents(cvFile);
  assert.equal(cvEvents[0].cv, 2, 'new events must be stamped cv:2');
  const nestedTampered = JSON.parse(JSON.stringify(cvEvents[0]));
  // Modify NESTED content only — top-level keys untouched.
  nestedTampered.args.nested.secret = 'tampered-value';
  rewriteChainFile(cvFile, cvEvents, nestedTampered, 0);
  const nestedResult = verifyChain(cvFile);
  assert.equal(nestedResult.valid, false, 'tampering NESTED content in a cv:2 event must break the chain');
  assert.equal(nestedResult.brokenAt, 0);
  console.log(`PASS nested tamper in cv:2 event breaks chain (brokenAt=${nestedResult.brokenAt})`);

  // 7. Legacy migration: events stored WITHOUT cv (old lossy hash) still verify.
  const legacyFile = path.join(chainDir, 'audit-legacy.jsonl');
  const cryptoMod = await import('node:crypto');
  const legacyEvent = {
    seq: 1,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'invocation',
    tool: 'run_command',
    agent: 'legacy-agent',
    transport: 'mcp',
    mutations: [],
    args: { command: 'ls', nested: { dropped: 'by-legacy-canonicalizer' } },
    prevHash: '0'.repeat(64),
  };
  // Reproduce the pre-cv:2 lossy canonicalization exactly.
  const legacyHash = cryptoMod.createHash('sha256')
    .update(JSON.stringify(legacyEvent, Object.keys(legacyEvent).sort()))
    .digest('hex');
  fs.writeFileSync(legacyFile, JSON.stringify({ ...legacyEvent, hash: legacyHash }) + '\n');
  const legacyVerify = verifyChain(legacyFile);
  assert.equal(legacyVerify.valid, true, `legacy (no-cv) events must still verify: ${legacyVerify.error}`);
  console.log('PASS legacy cv-less event verifies via legacy canonicalization');

  // Appending a cv:2 event after a legacy one chains correctly across forms.
  const mixedChain = new AuditChain(legacyFile);
  mixedChain.append({ kind: 'result', agent: 'legacy-agent', exitCode: 0 });
  assert.equal(verifyChain(legacyFile).valid, true, 'mixed legacy+cv:2 chain must verify');
  console.log('PASS mixed legacy + cv:2 chain verifies');

  // 8. Concurrent writers must not fork the chain (red-team fix #9).
  const concFile = path.join(chainDir, 'audit-concurrent.jsonl');
  const auditModuleUrl = new URL('../dist/audit/audit-chain.js', import.meta.url).href;
  const childScript = `
    const { AuditChain } = await import(${JSON.stringify(auditModuleUrl)});
    const chain = new AuditChain(${JSON.stringify(concFile)});
    for (let i = 0; i < 10; i++) chain.append({ kind: 'invocation', agent: ${"'writer-' + process.pid"} , exitCode: 0 });
  `;
  await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    import('node:child_process').then(({ spawn }) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], { stdio: 'ignore' });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}`))));
    });
  })));
  const concEvents = readChainFileEvents(concFile);
  assert.equal(concEvents.length, 40, 'all 40 concurrent appends must be present');
  assert.deepEqual(
    new Set(concEvents.map((e) => e.seq)).size, 40,
    'every event must have a unique seq (chain did not fork)',
  );
  const concVerify = verifyChain(concFile);
  assert.equal(concVerify.valid, true, `concurrent-writer chain must verify: ${concVerify.error}`);
  console.log('PASS 4 concurrent writers produced one intact 40-event chain');
  console.log('ALL AUDIT TESTS PASSED');
} finally {
  fs.rmSync(fakeHome, { recursive: true, force: true });
}
