#!/usr/bin/env node
/**
 * privileged_exec enforcement inside the privilege boundary.
 * Proves: approved exact argv runs once and is audited before + after;
 * every rejection path runs NOTHING (marker file never created).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executePrivileged, loadPrivilegedConfig } from '../dist/jace-commander/privileged-core.js';
import { invokePrivilegedHelper } from '../dist/jace-commander/privileged-client.js';
import { readTraceFile, verifyChain } from '../dist/jace-commander/looptrace.js';
import { makeIssuer } from './fixtures/jc-mint.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-priv-'));
const issuer = makeIssuer();
const config = {
  acsPublicKey: issuer.publicKeyB64,
  acsKeyId: issuer.keyId,
  runtimeId: 'jc-test-runtime',
  nonceDir: path.join(tmp, 'nonces'),
  auditPath: path.join(tmp, 'audit', 'privileged.jsonl'),
};
const env = { PATH: '/usr/bin:/bin' };
const touchBin = fs.existsSync('/usr/bin/touch') ? '/usr/bin/touch' : '/bin/touch';
const echoBin = fs.existsSync('/bin/echo') ? '/bin/echo' : '/usr/bin/echo';
const sleepBin = fs.existsSync('/bin/sleep') ? '/bin/sleep' : '/usr/bin/sleep';
const auditEvents = () => (fs.existsSync(config.auditPath) ? readTraceFile(config.auditPath).events : []);

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };

await test('approved exact argv runs, returns output, and is audited as intent + outcome', async () => {
  const args = { argv: [echoBin, 'hello-root'] };
  const result = await executePrivileged({ capability: issuer.mint('privileged_exec', args), arguments: args }, config, { envOverride: env });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'hello-root\n');
  assert.equal(result.authorization.approvalId, 'appr-human-1');
  const events = auditEvents();
  assert.deepEqual(events.map((e) => e.type), ['tool_call_started', 'tool_call_finished']);
  assert.equal(verifyChain(events).ok, true);
  assert.equal(events[1].hash, result.auditEventHash);
  assert.equal(events[0].payload.approvalId, 'appr-human-1');
  assert.equal(JSON.stringify(events).includes('hello-root\\n'), false, 'output content is not audited');
});

await test('secrets on the privileged command line are redacted in the audit chain (review round 1, item 1)', async () => {
  // Fake values assembled at runtime so the repository secret scanner never sees them.
  const fake = (...parts) => parts.join('');
  const secrets = [fake('fakeTok', 'EqValue', '21'), fake('fakePw', 'Spaced', '22'), fake('fakeBearer', 'Header', '23'),
    fake('AbC9', 'dEf8', 'GhI7', 'jKl6', 'MnO5', 'pQr4', 'StU3', 'vWx2'), fake('fakeBearer', 'Split', '24')];
  const args = { argv: [echoBin, `--token=${secrets[0]}`, '--password', secrets[1], '-H', `Authorization: Bearer ${secrets[2]}`,
    secrets[3], 'Authorization:', 'Bearer', secrets[4]] };
  const before = auditEvents().length;
  const result = await executePrivileged({ capability: issuer.mint('privileged_exec', args), arguments: args }, config, { envOverride: env });
  assert.equal(result.ok, true, JSON.stringify(result));
  const events = auditEvents().slice(before);
  assert.equal(events[0].type, 'tool_call_started');
  assert.equal(events[0].payload.argv[0], echoBin);
  assert.equal(events[0].payload.argvCount, args.argv.length);
  assert.equal(events[0].payload.invocationHash, result.authorization.invocationHash);
  const text = JSON.stringify(events);
  for (const secret of secrets) assert.equal(text.includes(secret), false, `audit leaked ${secret.slice(0, 8)}…`);
  assert.equal(verifyChain(auditEvents()).ok, true);
});

const marker = path.join(tmp, 'marker');
const touchArgs = { argv: [touchBin, marker] };
const assertNothingRan = (before) => {
  assert.equal(fs.existsSync(marker), false, 'command must not run');
  assert.equal(auditEvents().length, before, 'no audit intent for rejected calls');
};

await test('replayed capability is rejected and nothing runs twice', async () => {
  const args = { argv: [echoBin, 'once'] };
  const cap = issuer.mint('privileged_exec', args);
  assert.equal((await executePrivileged({ capability: cap, arguments: args }, config, { envOverride: env })).ok, true);
  const before = auditEvents().length;
  const replay = await executePrivileged({ capability: cap, arguments: args }, config, { envOverride: env });
  assert.deepEqual(replay, { ok: false, code: 'JC_CAPABILITY_NONCE_REPLAY' });
  assert.equal(auditEvents().length, before);
});

await test('missing human approval: rejected, nothing runs', async () => {
  const before = auditEvents().length;
  const r = await executePrivileged({ capability: issuer.mint('privileged_exec', touchArgs, { approvalId: undefined }), arguments: touchArgs }, config, { envOverride: env });
  assert.deepEqual(r, { ok: false, code: 'JC_CAPABILITY_APPROVAL_REQUIRED' });
  assertNothingRan(before);
});

await test('capability approved for a different command: rejected, nothing runs', async () => {
  const before = auditEvents().length;
  const r = await executePrivileged({ capability: issuer.mint('privileged_exec', { argv: [echoBin, 'benign'] }), arguments: touchArgs }, config, { envOverride: env });
  assert.deepEqual(r, { ok: false, code: 'JC_CAPABILITY_ARGUMENTS_MISMATCH' });
  assertNothingRan(before);
});

await test('no capability at all: rejected, nothing runs', async () => {
  const before = auditEvents().length;
  const r = await executePrivileged({ capability: undefined, arguments: touchArgs }, config, { envOverride: env });
  assert.equal(r.ok, false);
  assertNothingRan(before);
});

await test('relative / non-normalized executable rejected before capability is consumed', async () => {
  for (const argv of [['touch', marker], ['/usr/bin/../bin/touch', marker]]) {
    const args = { argv };
    const r = await executePrivileged({ capability: issuer.mint('privileged_exec', args), arguments: args }, config, { envOverride: env });
    assert.deepEqual(r, { ok: false, code: 'PRIVILEGED_ARGUMENTS_INVALID' });
  }
  assert.equal(fs.existsSync(marker), false);
});

await test('unknown argument keys and bad request shape are rejected', async () => {
  const args = { ...touchArgs, user: 'root' };
  assert.deepEqual(await executePrivileged({ capability: issuer.mint('privileged_exec', args), arguments: args }, config), { ok: false, code: 'PRIVILEGED_ARGUMENTS_INVALID' });
  assert.deepEqual(await executePrivileged({ capability: {}, arguments: touchArgs, extra: 1 }, config), { ok: false, code: 'PRIVILEGED_REQUEST_INVALID' });
  assert.equal(fs.existsSync(marker), false);
});

await test('audit unavailable: fail closed, nothing runs', async () => {
  const blocked = path.join(tmp, 'audit-blocker');
  fs.writeFileSync(blocked, 'not a directory');
  const r = await executePrivileged(
    { capability: issuer.mint('privileged_exec', touchArgs), arguments: touchArgs },
    { ...config, auditPath: path.join(blocked, 'privileged.jsonl') },
    { envOverride: env },
  );
  assert.deepEqual(r, { ok: false, code: 'PRIVILEGED_AUDIT_UNAVAILABLE' });
  assert.equal(fs.existsSync(marker), false);
});

await test('tampered audit chain blocks further privileged execution', async () => {
  const tamperedPath = path.join(tmp, 'tampered', 'privileged.jsonl');
  const cfg = { ...config, auditPath: tamperedPath };
  const args = { argv: [echoBin, 'x'] };
  assert.equal((await executePrivileged({ capability: issuer.mint('privileged_exec', args), arguments: args }, cfg, { envOverride: env })).ok, true);
  fs.writeFileSync(tamperedPath, fs.readFileSync(tamperedPath, 'utf8').replace('"x"', '"y"'));
  const r = await executePrivileged({ capability: issuer.mint('privileged_exec', touchArgs), arguments: touchArgs }, cfg, { envOverride: env });
  assert.deepEqual(r, { ok: false, code: 'PRIVILEGED_AUDIT_UNAVAILABLE' });
  assert.equal(fs.existsSync(marker), false);
});

await test('timeout kills the process group and is reported', async () => {
  const args = { argv: [sleepBin, '5'], timeoutMs: 200 };
  const r = await executePrivileged({ capability: issuer.mint('privileged_exec', args), arguments: args }, config, { envOverride: env });
  assert.equal(r.ok, true);
  assert.equal(r.timedOut, true);
  assert.ok(r.durationMs < 4000);
});

await test('spawn failure of a root-controlled non-executable closes the audit intent record', async () => {
  const args = { argv: ['/etc/passwd'] };
  const before = auditEvents().length;
  const r = await executePrivileged({ capability: issuer.mint('privileged_exec', args), arguments: args }, config, { envOverride: env });
  assert.deepEqual(r, { ok: false, code: 'PRIVILEGED_SPAWN_FAILED' });
  const events = auditEvents();
  assert.equal(events.length, before + 2);
  assert.equal(events.at(-1).payload.spawnFailed, true);
  assert.equal(verifyChain(events).ok, true);
});

await test('approved executable that is not root-controlled is refused before anything runs (swap-after-approval)', async () => {
  const before = auditEvents().length;
  // A copy of echo in a world-writable dir: the agent could replace it after approval.
  const copied = path.join(tmp, 'agent-writable-tool');
  fs.copyFileSync(echoBin, copied);
  fs.chmodSync(copied, 0o755);
  const link = path.join(tmp, 'agent-link');
  fs.symlinkSync(echoBin, link);
  for (const argv of [[copied, 'x'], [link, 'x'], ['/nonexistent/binary']]) {
    const args = { argv };
    const r = await executePrivileged({ capability: issuer.mint('privileged_exec', args), arguments: args }, config, { envOverride: env });
    assert.deepEqual(r, { ok: false, code: 'PRIVILEGED_EXECUTABLE_UNTRUSTED' }, argv[0]);
  }
  assert.equal(auditEvents().length, before, 'untrusted executables never reach the audit intent');
});

await test('omitted timeoutMs never exceeds the configured maxTimeoutMs ceiling', async () => {
  const args = { argv: [sleepBin, '5'] };
  const started = Date.now();
  const r = await executePrivileged({ capability: issuer.mint('privileged_exec', args), arguments: args }, { ...config, maxTimeoutMs: 300 }, { envOverride: env });
  assert.equal(r.ok, true);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 4000);
});

await test('root config ownership check rejects group/world-writable paths', async () => {
  const cfgPath = path.join(tmp, 'privileged.json');
  fs.writeFileSync(cfgPath, JSON.stringify(config));
  assert.equal(loadPrivilegedConfig(cfgPath, false).acsKeyId, issuer.keyId);
  // os.tmpdir() is world-writable (1777), so the chain can never be trusted.
  assert.throws(() => loadPrivilegedConfig(cfgPath, true), (e) => e.code === 'PRIVILEGED_CONFIG_INVALID');
});

await test('helper binary ignores env config overrides when running as root', async () => {
  if (typeof process.geteuid !== 'function' || process.geteuid() !== 0) {
    console.log('    (skipped: not root)');
    return;
  }
  const cfgPath = path.join(tmp, 'attacker.json');
  fs.writeFileSync(cfgPath, JSON.stringify(config));
  const helper = path.join(here, '..', 'dist', 'jace-commander', 'privileged-helper.js');
  const run = spawnSync(process.execPath, [helper], {
    input: JSON.stringify({ capability: issuer.mint('privileged_exec', touchArgs), arguments: touchArgs }),
    env: { ...process.env, JC_PRIVILEGED_CONFIG: cfgPath, JC_PRIVILEGED_ALLOW_NONROOT: '1' },
  });
  assert.equal(run.status, 2);
  const out = JSON.parse(run.stdout.toString());
  // /etc/jace-commander/privileged.json is absent here, so root must refuse
  // rather than fall back to the attacker-supplied path.
  assert.equal(out.code, 'PRIVILEGED_CONFIG_INVALID');
  assert.equal(fs.existsSync(marker), false);
});

await test('client maps sudo refusal to PRIVILEGED_HELPER_UNAVAILABLE and relays helper verdicts', async () => {
  const deny = path.join(tmp, 'fake-sudo-deny');
  fs.writeFileSync(deny, '#!/bin/sh\necho "sudo: a password is required" >&2\nexit 1\n', { mode: 0o755 });
  assert.deepEqual(await invokePrivilegedHelper({ capability: {}, arguments: {} }, { sudoPath: deny, helperPath: '/x' }), { ok: false, code: 'PRIVILEGED_HELPER_UNAVAILABLE' });
  const relay = path.join(tmp, 'fake-sudo-relay');
  fs.writeFileSync(relay, '#!/bin/sh\n[ "$1" = "-n" ] && [ "$2" = "--" ] || exit 9\ncat >/dev/null\necho \'{"ok":false,"code":"JC_CAPABILITY_APPROVAL_REQUIRED"}\'\nexit 2\n', { mode: 0o755 });
  assert.deepEqual(await invokePrivilegedHelper({ capability: {}, arguments: {} }, { sudoPath: relay, helperPath: '/x' }), { ok: false, code: 'JC_CAPABILITY_APPROVAL_REQUIRED' });
  assert.deepEqual(await invokePrivilegedHelper({ capability: {}, arguments: {} }, { sudoPath: '/nonexistent/sudo', helperPath: '/x' }), { ok: false, code: 'PRIVILEGED_HELPER_UNAVAILABLE' });
});

console.log(`\njace-commander privileged: ${passed} passed`);
