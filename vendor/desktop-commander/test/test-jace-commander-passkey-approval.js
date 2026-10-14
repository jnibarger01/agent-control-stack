#!/usr/bin/env node
/**
 * Passkey (WebAuthn UV) approvals for approverd: jc.decide.v2 decide_begin / decide_complete.
 * Jace's decision 2026-10-13; #355 review F1-F5; R/V findings in #356.
 * Synthetic P-256 authenticators are generated here; no real keys, no real root (fake fs seam for the anchor).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { Approverd, ensureApproverKey } from '../dist/jace-commander/approverd.js';
import { JcHumanAssertionGate, JC_DECIDE_PROTOCOL_VERSION } from '../dist/jace-commander/approval-protocol.js';
import { FileSignCountStore, JcPasskeyVerifier, MemorySignCountStore, assertPasskeyRelyingParty, loadPasskeyTrustAnchor } from '../dist/jace-commander/passkey-verifier.js';
import { APPROVE_EXIT, runApproveCommand } from '../dist/jace-commander/approve-cli.js';
import net from 'node:net';
import { localCeremonyPort } from '../dist/jace-commander/passkey-ceremony.js';
import { readTraceFile } from '../dist/jace-commander/looptrace.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:7391';
const ANCHOR = '/etc/jace-commander/passkeys.json';
const RUNTIME = 'jc-test-runtime';
const PRIV = { argv: ['/usr/bin/id'] };
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-passkey-')));
let clock = Date.now();
const now = () => clock;

// ---- synthetic authenticator ----------------------------------------------------
function makeAuthenticator(operatorId = 'jace') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))], [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))]]));
  const credentialId = crypto.randomBytes(16).toString('base64url');
  const userHandle = crypto.randomBytes(16).toString('base64url');
  let counter = 0;
  return {
    credentialId, userHandle, operatorId,
    entry: { credentialId, publicKey: Buffer.from(cose).toString('base64url'), userHandle, operatorId },
    setCounter(n) { counter = n; },
    sign(challenge, { rpId = RP_ID, origin = ORIGIN, uv = true, up = true, counterOverride, type = 'webauthn.get', handle = userHandle } = {}) {
      const c = counterOverride ?? ++counter;
      const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
      const flags = (up ? 0x01 : 0) | (uv ? 0x04 : 0);
      const cnt = Buffer.alloc(4); cnt.writeUInt32BE(c);
      const authData = Buffer.concat([crypto.createHash('sha256').update(rpId).digest(), Buffer.from([flags]), cnt]);
      const signature = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(clientDataJSON).digest()]), privateKey);
      return {
        id: credentialId, rawId: credentialId, type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: clientDataJSON.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: signature.toString('base64url'), ...(handle ? { userHandle: handle } : {}) },
      };
    },
  };
}

// ---- fake root-owned filesystem for the trust anchor --------------------------------
function anchorIo(content, overrides = {}) {
  const nodes = {
    '/': { uid: 0, mode: 0o40755, type: 'dir', ino: 1 },
    '/etc': { uid: 0, mode: 0o40755, type: 'dir', ino: 2 },
    '/etc/jace-commander': { uid: 0, mode: 0o40755, type: 'dir', ino: 3 },
    [ANCHOR]: { uid: 0, mode: 0o100644, type: 'file', ino: 4 },
    ...overrides,
  };
  const st = (n) => ({ uid: n.uid, mode: n.mode, dev: 1, ino: n.ino, size: Buffer.byteLength(content()), isFile: () => n.type === 'file', isDirectory: () => n.type === 'dir', isSymbolicLink: () => n.type === 'link' });
  return {
    lstat: (p) => { if (!nodes[p]) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return st(nodes[p]); },
    realpath: (p) => p,
    openNoFollow: (p) => { if (!nodes[p]) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return 7; },
    fstat: () => st(nodes[ANCHOR]),
    read: () => Buffer.from(content()),
    close: () => {},
    writable: () => false,
    geteuid: () => 1500,
  };
}

let seq = 0;
async function setup({ authenticators = [makeAuthenticator()], io, humanVerifier, approvalTtlMs, verifierTimeoutMs, anchorContent, requiredRiskClasses } = {}) {
  seq += 1;
  const base = path.join(root, `p${seq}`);
  const keyPath = path.join(base, 'key', 'approver.key');
  const keyInfo = ensureApproverKey(keyPath, 'jc-approver-test');
  const anchor = { version: 'jc.passkeys.v1', credentials: authenticators.map((a) => a.entry) };
  const content = anchorContent ?? (() => JSON.stringify(anchor));
  const config = {
    runtimeId: RUNTIME, stateDir: path.join(base, 'state'), keyPath, keyId: keyInfo.keyId,
    requestSocket: path.join(base, 'request', 'request.sock'), decideSocket: path.join(base, 'decide', 'decide.sock'),
    passkey: { trustAnchorPath: ANCHOR, rpId: RP_ID, origin: ORIGIN, ...(verifierTimeoutMs ? { verifierTimeoutMs } : {}), ...(requiredRiskClasses ? { requiredRiskClasses } : {}) },
    ...(approvalTtlMs ? { approvalTtlMs } : {}),
  };
  const trustAnchorIo = io ?? anchorIo(content);
  const daemon = new Approverd(config, { now, trustAnchorIo, ...(humanVerifier ? { humanVerifier: humanVerifier(trustAnchorIo) } : {}) });
  await daemon.start();
  return { daemon, config, a: authenticators[0], authenticators, trustAnchorIo };
}

const request = (env, tool = 'privileged_exec', args = PRIV) => env.daemon.handleRequestOp({ op: 'authorize', runtimeId: RUNTIME, tool, arguments: { ...args, argv: [...args.argv, `--n=${++seq}`] } });
const show = (env, id) => env.daemon.handleDecideOp({ op: 'show', id }).approval;
const begin = (env, id, extra = {}) => env.daemon.handleDecideOp({ op: 'decide_begin', protocol: JC_DECIDE_PROTOCOL_VERSION, id, confirmHash: show(env, id).invocationHash, ...extra });
const assertion = (b, webauthn, extra = {}) => ({ approvalId: b.approvalId, challenge: b.challenge, invocationHash: b.invocationHash, operatorId: 'jace', issuedAt: b.issuedAt, expiresAt: b.expiresAt, webauthn, ...extra });
const complete = (env, b, webauthn, extra = {}, id = b.approvalId) => Promise.resolve(env.daemon.handleDecideOp({ op: 'decide_complete', protocol: JC_DECIDE_PROTOCOL_VERSION, id, decision: 'approve', assertion: assertion(b, webauthn, extra) }));
const fresh = async (env) => { const p = request(env); assert.equal(p.state, 'pending'); const b = begin(env, p.approvalId); assert.equal(b.ok, true, JSON.stringify(b)); return b; };
const statusOf = (env, id) => show(env, id).status;

// ------------------------------------------------------------------------------------

await test('happy path: UV passkey approves; audit records the principal with webauthn-uv; the token mints once', async () => {
  const env = await setup();
  const b = await fresh(env);
  assert.equal(Buffer.from(b.challenge, 'base64url').length, 32);
  assert.equal(b.expiresAt - b.issuedAt, 30_000);
  assert.equal(b.webauthn.rpId, RP_ID);
  assert.equal(b.webauthn.origin, ORIGIN);
  assert.equal(b.webauthn.userVerification, 'required');
  assert.deepEqual(b.webauthn.allowCredentials.map((c) => c.id), [env.a.credentialId]);
  const done = await complete(env, b, env.a.sign(b.webauthn.challenge));
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.approverIdAssurance, 'webauthn-uv');
  assert.equal(statusOf(env, b.approvalId), 'approved');
  const audit = readTraceFile(path.join(env.config.stateDir, 'audit.jsonl')).events.filter((e) => e.type === 'approval_decision');
  assert.equal(audit.at(-1).payload.approverIdAssurance, 'webauthn-uv');
  assert.equal(audit.at(-1).payload.approverId, 'jace');
  assert.equal(audit.at(-1).payload.credentialId, env.a.credentialId);
  const granted = env.daemon.handleRequestOp({ op: 'authorize', runtimeId: RUNTIME, tool: 'privileged_exec', arguments: show(env, b.approvalId).arguments });
  assert.equal(granted.state, 'granted');
  await env.daemon.stop();
});

await test('no assertion is denied and does not burn the challenge (F4)', async () => {
  const env = await setup();
  const b = await fresh(env);
  for (const bad of [undefined, null, {}, { id: env.a.credentialId }]) {
    assert.equal((await complete(env, b, bad)).ok, false);
  }
  assert.equal((await env.daemon.handleDecideOp({ op: 'decide_complete', protocol: JC_DECIDE_PROTOCOL_VERSION, id: b.approvalId, decision: 'approve' })).code, 'INVALID_REQUEST');
  assert.equal(statusOf(env, b.approvalId), 'pending');
  assert.equal((await complete(env, b, env.a.sign(b.webauthn.challenge))).ok, true);
  await env.daemon.stop();
});

await test('UV=0 (and UP=0) assertions are denied', async () => {
  const env = await setup();
  let b = await fresh(env);
  assert.equal((await complete(env, b, env.a.sign(b.webauthn.challenge, { uv: false }))).code, 'PASSKEY_DENIED');
  assert.equal(statusOf(env, b.approvalId), 'pending');
  b = await fresh(env);
  assert.equal((await complete(env, b, env.a.sign(b.webauthn.challenge, { up: false, uv: false }))).code, 'PASSKEY_DENIED');
  await env.daemon.stop();
});

await test('UP=0 with UV=1 is denied (user presence enforced, #360 R/V F1)', async () => {
  const env = await setup();
  const b = await fresh(env);
  assert.equal((await complete(env, b, env.a.sign(b.webauthn.challenge, { up: false, uv: true }))).code, 'PASSKEY_DENIED');
  assert.equal(statusOf(env, b.approvalId), 'pending');
  await env.daemon.stop();
});

await test('wrong RP ID, wrong origin and wrong ceremony type are denied', async () => {
  const env = await setup();
  for (const opts of [{ rpId: 'evil.example' }, { origin: 'http://localhost:9999' }, { origin: 'https://localhost:7391' }, { type: 'webauthn.create' }]) {
    const b = await fresh(env);
    assert.equal((await complete(env, b, env.a.sign(b.webauthn.challenge, opts))).code, 'PASSKEY_DENIED', JSON.stringify(opts));
    assert.equal(statusOf(env, b.approvalId), 'pending');
  }
  await env.daemon.stop();
});

await test('an assertion for a different approval id or invocation hash is denied', async () => {
  const env = await setup();
  const one = await fresh(env);
  const two = await fresh(env);
  // Signed over approval two's challenge, submitted for approval one.
  assert.equal((await complete(env, one, env.a.sign(two.webauthn.challenge))).code, 'PASSKEY_DENIED');
  // Gate fields of two sent under id one.
  assert.equal((await complete(env, two, env.a.sign(two.webauthn.challenge), {}, one.approvalId)).code, 'INVALID_REQUEST');
  // A different invocation hash (structural mismatch: denied, challenge kept, then the right one succeeds).
  const three = await fresh(env);
  assert.equal((await complete(env, three, env.a.sign(three.webauthn.challenge), { invocationHash: two.invocationHash })).code, 'PASSKEY_DENIED');
  assert.equal(statusOf(env, one.approvalId), 'pending');
  assert.equal(statusOf(env, three.approvalId), 'pending');
  assert.equal(statusOf(env, two.approvalId), 'pending');
  await env.daemon.stop();
});

await test('a replayed assertion is denied (same approval and a new approval)', async () => {
  const env = await setup();
  const b = await fresh(env);
  const signed = env.a.sign(b.webauthn.challenge);
  assert.equal((await complete(env, b, signed)).ok, true);
  assert.equal((await complete(env, b, signed)).ok, false);
  const next = await fresh(env);
  assert.equal((await complete(env, next, signed, { challenge: next.challenge })).code, 'PASSKEY_DENIED');
  assert.equal(statusOf(env, next.approvalId), 'pending');
  await env.daemon.stop();
});

await test('a challenge cannot be reused: begin while live is refused (F4); a consumed challenge is unknown', async () => {
  const env = await setup();
  const b = await fresh(env);
  assert.equal(begin(env, b.approvalId).code, 'CHALLENGE_LIVE');
  assert.equal((await complete(env, b, env.a.sign(b.webauthn.challenge, { uv: false }))).code, 'PASSKEY_DENIED');
  // The failed (but structurally valid) attempt consumed it; the old challenge is gone.
  assert.equal((await complete(env, b, env.a.sign(b.webauthn.challenge))).code, 'CHALLENGE_UNKNOWN');
  const again = begin(env, b.approvalId);
  assert.equal(again.ok, true);
  assert.notEqual(again.challenge, b.challenge);
  assert.equal((await complete(env, again, env.a.sign(again.webauthn.challenge))).ok, true);
  await env.daemon.stop();
});

await test('an expired challenge is denied; expired challenges are swept on issue (F5)', async () => {
  const env = await setup();
  const b = await fresh(env);
  clock += 30_001;
  assert.equal((await complete(env, b, env.a.sign(b.webauthn.challenge))).ok, false);
  assert.equal(statusOf(env, b.approvalId), 'pending');
  const gate = new JcHumanAssertionGate({ verify: async () => false }, { now });
  const rec = (i) => ({ id: `r${i}`, runtimeId: RUNTIME, tool: 'write_file', status: 'pending', invocationHash: 'a'.repeat(64), expiresAt: new Date(clock + 600_000).toISOString() });
  for (let i = 0; i < 5; i += 1) gate.issue(rec(i));
  assert.equal(gate.size, 5);
  clock += 30_001;
  gate.issue(rec(99));
  assert.equal(gate.size, 1);
  await env.daemon.stop();
});

await test('a sign counter that goes backwards (or repeats) is denied', async () => {
  const env = await setup();
  let b = await fresh(env);
  env.a.setCounter(10);
  assert.equal((await complete(env, b, env.a.sign(b.webauthn.challenge))).ok, true); // counter 11
  b = await fresh(env);
  assert.equal((await complete(env, b, env.a.sign(b.webauthn.challenge, { counterOverride: 5 }))).code, 'PASSKEY_DENIED');
  b = await fresh(env);
  assert.equal((await complete(env, b, env.a.sign(b.webauthn.challenge, { counterOverride: 11 }))).code, 'PASSKEY_DENIED');
  b = await fresh(env);
  assert.equal((await complete(env, b, env.a.sign(b.webauthn.challenge, { counterOverride: 12 }))).ok, true);
  // Counters persist in approverd's state dir.
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.config.stateDir, 'passkey-counters.json'), 'utf8'))[env.a.credentialId], 12);
  await env.daemon.stop();
});

await test('a record decided or expired between begin and complete is not approved (F1 re-check)', async () => {
  let release;
  const slowVerifier = (io) => {
    const real = new JcPasskeyVerifier({ rpId: RP_ID, origin: ORIGIN, loadTrustAnchor: () => loadPasskeyTrustAnchor(ANCHOR, io), signCounts: new MemorySignCountStore() });
    return { precheck: (x) => real.precheck(x), allowCredentials: () => real.allowCredentials(), verify: async (x, c) => { await new Promise((r) => { release = r; }); return real.verify(x, c); } };
  };
  const env = await setup({ humanVerifier: slowVerifier });
  // Decided meanwhile (rejected through the legacy path, which stays allowed for rejection).
  let b = await fresh(env);
  let pending = complete(env, b, env.a.sign(b.webauthn.challenge));
  await new Promise((r) => setImmediate(r));
  assert.equal(env.daemon.handleDecideOp({ op: 'decide', id: b.approvalId, decision: 'reject', confirmHash: b.invocationHash, approverId: 'op' }).ok, true);
  release();
  assert.equal((await pending).code, 'NOT_PENDING');
  assert.equal(statusOf(env, b.approvalId), 'rejected');
  await env.daemon.stop();
  // Expired meanwhile: record TTL shorter than the challenge window.
  const short = await setup({ humanVerifier: slowVerifier, approvalTtlMs: 10_000 });
  b = await fresh(short);
  pending = complete(short, b, short.a.sign(b.webauthn.challenge));
  await new Promise((r) => setImmediate(r));
  clock += 10_001;
  release();
  const res = await pending;
  assert.equal(res.ok, false);
  assert.ok(['EXPIRED', 'PASSKEY_DENIED'].includes(res.code), res.code);
  assert.equal(statusOf(short, b.approvalId), 'expired');
  await short.daemon.stop();
});

await test('legacy one-step decide is refused for privileged approvals while a verifier is configured, even if it is down', async () => {
  const broken = await setup({ anchorContent: () => { throw new Error('anchor unavailable'); } });
  const p = request(broken);
  const hash = show(broken, p.approvalId).invocationHash;
  assert.equal(broken.daemon.handleDecideOp({ op: 'decide', id: p.approvalId, decision: 'approve', confirmHash: hash, approverId: 'jace' }).code, 'PASSKEY_REQUIRED');
  assert.equal(begin(broken, p.approvalId).code, 'PASSKEY_UNAVAILABLE');
  assert.equal(statusOf(broken, p.approvalId), 'pending');
  // Rejecting through the legacy path stays possible (it can only deny).
  assert.equal(broken.daemon.handleDecideOp({ op: 'decide', id: p.approvalId, decision: 'reject', confirmHash: hash, approverId: 'jace' }).ok, true);
  // Non-privileged classes keep the legacy flow (default requiredRiskClasses = ['privileged']).
  const w = broken.daemon.handleRequestOp({ op: 'authorize', runtimeId: RUNTIME, tool: 'write_file', arguments: { path: '/work/a', content: 'x' } });
  assert.equal(broken.daemon.handleDecideOp({ op: 'decide', id: w.approvalId, decision: 'approve', confirmHash: show(broken, w.approvalId).invocationHash, approverId: 'jace' }).ok, true);
  // Unknown protocol versions are refused.
  assert.equal(broken.daemon.handleDecideOp({ op: 'decide_begin', protocol: 'jc.decide.v1', id: p.approvalId, confirmHash: hash }).code, 'PROTOCOL_UNSUPPORTED');
  await broken.daemon.stop();
});

await test('a verifier error denies; a hung verifier times out as a deny without consuming the record (#356 f)', async () => {
  let fail = false;
  const a0 = makeAuthenticator();
  const env = await setup({ authenticators: [a0], anchorContent: () => { if (fail) throw new Error('down'); return JSON.stringify({ version: 'jc.passkeys.v1', credentials: [a0.entry] }); } });
  const b = await fresh(env);
  fail = true;
  assert.equal((await complete(env, b, env.a.sign(b.webauthn.challenge))).code, 'PASSKEY_DENIED');
  assert.equal(statusOf(env, b.approvalId), 'pending');
  await env.daemon.stop();
  const hung = await setup({ humanVerifier: () => ({ allowCredentials: () => [], verify: () => new Promise(() => {}) }), verifierTimeoutMs: 50 });
  const h = await fresh(hung);
  assert.equal((await complete(hung, h, { id: 'x', rawId: 'x', type: 'public-key', response: {} })).code, 'PASSKEY_TIMEOUT');
  assert.equal(statusOf(hung, h.approvalId), 'pending');
  assert.equal(begin(hung, h.approvalId).ok, true);
  await hung.daemon.stop();
});

await test('an unregistered credential, a mismatched user handle and a wrong claimed operator (F2) are denied', async () => {
  const env = await setup();
  const stranger = makeAuthenticator('jace');
  let b = await fresh(env);
  assert.equal((await complete(env, b, stranger.sign(b.webauthn.challenge))).code, 'PASSKEY_DENIED');
  b = await fresh(env);
  assert.equal((await complete(env, b, env.a.sign(b.webauthn.challenge, { handle: crypto.randomBytes(16).toString('base64url') }))).code, 'PASSKEY_DENIED');
  b = await fresh(env);
  assert.equal((await complete(env, b, env.a.sign(b.webauthn.challenge), { operatorId: 'mallory' })).code, 'PASSKEY_DENIED');
  assert.equal(statusOf(env, b.approvalId), 'pending');
  await env.daemon.stop();
});

await test('a trust anchor that is non-root-owned, group/world-writable, or under a writable parent is rejected', async () => {
  const a = makeAuthenticator();
  const content = () => JSON.stringify({ version: 'jc.passkeys.v1', credentials: [a.entry] });
  for (const [label, override] of [
    ['owned by uid 1000', { [ANCHOR]: { uid: 1000, mode: 0o100644, type: 'file', ino: 4 } }],
    ['owned by the approverd account', { [ANCHOR]: { uid: 1500, mode: 0o100444, type: 'file', ino: 4 } }],
    ['group-writable', { [ANCHOR]: { uid: 0, mode: 0o100664, type: 'file', ino: 4 } }],
    ['world-writable', { [ANCHOR]: { uid: 0, mode: 0o100646, type: 'file', ino: 4 } }],
    ['writable parent', { '/etc/jace-commander': { uid: 0, mode: 0o40777, type: 'dir', ino: 3 } }],
    ['non-root parent', { '/etc/jace-commander': { uid: 1000, mode: 0o40755, type: 'dir', ino: 3 } }],
  ]) {
    const io = anchorIo(content, override);
    assert.throws(() => loadPasskeyTrustAnchor(ANCHOR, io), /owned|writable/, label);
    const env = await setup({ authenticators: [a], io });
    const p = request(env);
    assert.equal(begin(env, p.approvalId).code, 'PASSKEY_UNAVAILABLE', label);
    await env.daemon.stop();
  }
  // Root-owned 0644 under a root chain loads.
  assert.equal(loadPasskeyTrustAnchor(ANCHOR, anchorIo(content)).credentials.length, 1);
});

await test('two concurrent completes for the same challenge: exactly one wins', async () => {
  const env = await setup();
  const b = await fresh(env);
  const signed = env.a.sign(b.webauthn.challenge);
  const results = await Promise.all([complete(env, b, signed), complete(env, b, signed)]);
  assert.deepEqual(results.map((r) => r.ok).sort(), [false, true]);
  assert.equal(statusOf(env, b.approvalId), 'approved');
  await env.daemon.stop();
});

await test('a clock that moved backwards denies and drops the challenge (#356 b)', async () => {
  const env = await setup();
  const b = await fresh(env);
  clock -= 5_000;
  assert.equal((await complete(env, b, env.a.sign(b.webauthn.challenge))).code, 'CLOCK_ERROR');
  clock += 5_000;
  assert.equal((await complete(env, b, env.a.sign(b.webauthn.challenge))).code, 'CHALLENGE_UNKNOWN');
  assert.equal(statusOf(env, b.approvalId), 'pending');
  await env.daemon.stop();
});

await test('the gate validates its verifier and timeout (#356 d)', () => {
  assert.throws(() => new JcHumanAssertionGate(undefined), TypeError);
  assert.throws(() => new JcHumanAssertionGate({}), TypeError);
  assert.throws(() => new JcHumanAssertionGate({ verify: async () => false, precheck: 'yes' }), TypeError);
  assert.throws(() => new JcHumanAssertionGate({ verify: async () => false }, { verifierTimeoutMs: 0 }), RangeError);
  assert.throws(() => new JcHumanAssertionGate({ verify: async () => false }, { verifierTimeoutMs: 30_001 }), RangeError);
  assert.throws(() => new Approverd({ runtimeId: RUNTIME, stateDir: root, keyPath: 'k', keyId: 'k', requestSocket: 'r', decideSocket: 'd', passkey: { trustAnchorPath: ANCHOR, rpId: RP_ID, origin: 'http://evil.example' } }));
  assert.throws(() => new Approverd({ runtimeId: RUNTIME, stateDir: root, keyPath: 'k', keyId: 'k', requestSocket: 'r', decideSocket: 'd', passkey: { trustAnchorPath: 'relative.json', rpId: RP_ID, origin: ORIGIN } }));
});

await test('passkey origins without a supported ceremony are rejected at config load (https, 127.0.0.1, no port)', () => {
  const base = { runtimeId: RUNTIME, stateDir: os.tmpdir(), keyPath: 'k', keyId: 'k', requestSocket: 'r', decideSocket: 'd' };
  const noCeremony = /only origin with a supported passkey ceremony/;
  for (const [rpId, origin] of [['example.com', 'https://example.com'], ['example.com', 'https://approve.example.com:8443'], ['localhost', 'https://localhost:7391'], ['127.0.0.1', 'http://127.0.0.1:7391'], ['localhost', 'http://localhost']]) {
    assert.throws(() => new Approverd({ ...base, passkey: { trustAnchorPath: ANCHOR, rpId, origin } }), noCeremony, `approverd accepted ${origin}`);
    assert.throws(() => assertPasskeyRelyingParty(rpId, origin), noCeremony, `assertPasskeyRelyingParty accepted ${origin}`);
    assert.throws(() => new JcPasskeyVerifier({ rpId, origin, loadTrustAnchor: () => ({}), signCounts: new MemorySignCountStore() }), noCeremony);
  }
  // Every origin config load accepts must also be one the ceremony can serve.
  assertPasskeyRelyingParty(RP_ID, ORIGIN);
  assert.equal(localCeremonyPort(ORIGIN), 7391);
  new Approverd({ ...base, passkey: { trustAnchorPath: ANCHOR, rpId: RP_ID, origin: ORIGIN } });
});

await test('approve CLI: decide_begin, typed hash, browser ceremony, decide_complete over the real decide socket', async () => {
  const env = await setup();
  const p = request(env);
  const lines = [];
  const io = { stdout: (t) => lines.push(t), stderr: (t) => lines.push(t), isTty: true, prompt: async () => show(env, p.approvalId).invocationHash.slice(0, 8) };
  const code = await runApproveCommand('approve', [p.approvalId], {
    decideSocket: env.config.decideSocket, approverId: 'jace', io,
    passkeyCeremony: async (b) => env.a.sign(b.webauthn.challenge),
  });
  assert.equal(code, APPROVE_EXIT.ok, lines.join('\n'));
  assert.equal(statusOf(env, p.approvalId), 'approved');
  // Without a ceremony the CLI refuses rather than falling back to the legacy decide.
  const q = request(env);
  const code2 = await runApproveCommand('approve', [q.approvalId], { decideSocket: env.config.decideSocket, approverId: 'jace', io: { ...io, prompt: async () => show(env, q.approvalId).invocationHash.slice(0, 8) } });
  assert.equal(code2, APPROVE_EXIT.failed);
  assert.equal(statusOf(env, q.approvalId), 'pending');
  await env.daemon.stop();
});

// ---- review fixes (#360 threads) ------------------------------------------------------

const WRITE_ARGS = { path: '/work/x.txt', content: 'hi' };
const authorizeExact = (env, tool, args) => env.daemon.handleRequestOp({ op: 'authorize', runtimeId: RUNTIME, tool, arguments: args });
const legacyDecide = (env, id, decision = 'approve') => env.daemon.handleDecideOp({ op: 'decide', id, decision, confirmHash: show(env, id).invocationHash, approverId: 'jace' });
const blockPersist = (env, id) => fs.mkdirSync(path.join(env.config.stateDir, 'approvals', `${id}.json.${process.pid}.tmp`), { recursive: true });
const unblockPersist = (env, id) => fs.rmSync(path.join(env.config.stateDir, 'approvals', `${id}.json.${process.pid}.tmp`), { recursive: true });
const recordFile = (env, id) => path.join(env.config.stateDir, 'approvals', `${id}.json`);
async function restart(env) {
  await env.daemon.stop();
  const daemon = new Approverd(env.config, { now, trustAnchorIo: env.trustAnchorIo });
  await daemon.start();
  return { ...env, daemon };
}

await test('fix 1: requiredRiskClasses is a union with privileged, never a replacement', async () => {
  const env = await setup({ requiredRiskClasses: ['mutate'] });
  const p = request(env); // privileged_exec
  assert.equal(legacyDecide(env, p.approvalId).code, 'PASSKEY_REQUIRED');
  assert.equal(statusOf(env, p.approvalId), 'pending');
  const w = authorizeExact(env, 'write_file', WRITE_ARGS); // mutate, widened in
  assert.equal(legacyDecide(env, w.approvalId).code, 'PASSKEY_REQUIRED');
  assert.equal(begin(env, p.approvalId).ok, true);
  await env.daemon.stop();
  // An empty or misspelled list still keeps privileged.
  for (const requiredRiskClasses of [[], ['privilegd']]) {
    const e = await setup({ requiredRiskClasses });
    const q = request(e);
    assert.equal(legacyDecide(e, q.approvalId).code, 'PASSKEY_REQUIRED', JSON.stringify(requiredRiskClasses));
    await e.daemon.stop();
  }
});

await test('fix 1: no passkey block refuses to start unless the explicit opt-out is set, and the opt-out is audited', async () => {
  const base = path.join(root, `noconf${++seq}`);
  const keyPath = path.join(base, 'key', 'approver.key');
  const keyInfo = ensureApproverKey(keyPath, 'jc-approver-test');
  const config = { runtimeId: RUNTIME, stateDir: path.join(base, 'state'), keyPath, keyId: keyInfo.keyId,
    requestSocket: path.join(base, 'request', 'request.sock'), decideSocket: path.join(base, 'decide', 'decide.sock') };
  assert.throws(() => new Approverd(config), /requires a `passkey` config block/);
  assert.throws(() => new Approverd({ ...config, allowSelfAssertedPrivileged: false }), /requires a `passkey` config block/);
  assert.throws(() => new Approverd({ ...config, allowSelfAssertedPrivileged: 'yes' }), TypeError);
  assert.throws(() => new Approverd({ ...config, allowSelfAssertedPrivileged: true, passkey: { trustAnchorPath: ANCHOR, rpId: RP_ID, origin: ORIGIN } }), /cannot be combined/);
  const daemon = new Approverd({ ...config, allowSelfAssertedPrivileged: true }, { now });
  await daemon.start();
  const events = readTraceFile(path.join(config.stateDir, 'audit.jsonl')).events;
  assert.equal(events[0].type, 'risk_classified');
  assert.equal(events[0].payload.optOut, 'allowSelfAssertedPrivileged');
  assert.equal(events[0].payload.approverIdAssurance, 'self-asserted');
  await daemon.stop();
  // If the opt-out cannot be audited, approverd does not start.
  fs.rmSync(path.join(config.stateDir, 'audit.jsonl'));
  fs.mkdirSync(path.join(config.stateDir, 'audit.jsonl'));
  await assert.rejects(new Approverd({ ...config, allowSelfAssertedPrivileged: true }, { now }).start(), /refusing to start/);
});

await test('fix 2: a failed persist leaves the record pending and unclaimable (passkey and legacy decide)', async () => {
  const env = await setup();
  const b = await fresh(env);
  blockPersist(env, b.approvalId);
  const done = await complete(env, b, env.a.sign(b.webauthn.challenge));
  assert.equal(done.code, 'PERSIST_FAILED', JSON.stringify(done));
  assert.equal(statusOf(env, b.approvalId), 'pending');
  assert.equal(authorizeExact(env, 'privileged_exec', show(env, b.approvalId).arguments).state, 'pending');
  unblockPersist(env, b.approvalId);
  // Legacy decide (a class outside the passkey set).
  const w = authorizeExact(env, 'write_file', WRITE_ARGS);
  blockPersist(env, w.approvalId);
  assert.equal(legacyDecide(env, w.approvalId).code, 'PERSIST_FAILED');
  assert.equal(statusOf(env, w.approvalId), 'pending');
  assert.equal(authorizeExact(env, 'write_file', WRITE_ARGS).state, 'pending');
  unblockPersist(env, w.approvalId);
  assert.equal(legacyDecide(env, w.approvalId).ok, true);
  assert.equal(authorizeExact(env, 'write_file', WRITE_ARGS).state, 'granted');
  await env.daemon.stop();
});

await test('fix 3: a malformed sign counter is rejected, never treated as 0', () => {
  const dir = fs.mkdtempSync(path.join(root, 'counters-'));
  const file = path.join(dir, 'passkey-counters.json');
  for (const bad of ['{"cred":"corrupt"}', '{"cred":-1}', '{"cred":1.5}', '{"cred":null}', '[]', 'null', '7']) {
    fs.writeFileSync(file, bad);
    const store = new FileSignCountStore(file);
    assert.throws(() => store.get('cred'), /unreadable/, bad);
    assert.throws(() => store.get('other'), /unreadable/, bad);
    assert.throws(() => store.set('cred', 9), /unreadable/, bad);
  }
  fs.writeFileSync(file, '{"cred":5}');
  assert.equal(new FileSignCountStore(file).get('cred'), 5);
});

await test('fix 4: on restart a passkey approval must match its webauthn-uv audit entry', async () => {
  let env = await setup();
  const good = await fresh(env);
  assert.equal((await complete(env, good, env.a.sign(good.webauthn.challenge))).ok, true);
  const bad = await fresh(env);
  assert.equal((await complete(env, bad, env.a.sign(bad.webauthn.challenge))).ok, true);
  const tampered = JSON.parse(fs.readFileSync(recordFile(env, bad.approvalId), 'utf8'));
  tampered.approverId = 'mallory';
  fs.writeFileSync(recordFile(env, bad.approvalId), JSON.stringify(tampered));
  env = await restart(env);
  assert.equal(statusOf(env, good.approvalId), 'approved');
  assert.equal(env.daemon.handleDecideOp({ op: 'show', id: bad.approvalId }).code, 'NOT_FOUND');
  assert.equal(authorizeExact(env, 'privileged_exec', tampered.arguments).state, 'pending');
  await env.daemon.stop();

  // A privileged approval that was only self-asserted (opt-out era) is not restored once passkeys are on.
  const legacy = await setup();
  await legacy.daemon.stop();
  const optOut = new Approverd({ ...legacy.config, passkey: undefined, allowSelfAssertedPrivileged: true }, { now });
  await optOut.start();
  const p = optOut.handleRequestOp({ op: 'authorize', runtimeId: RUNTIME, tool: 'privileged_exec', arguments: PRIV });
  const h = optOut.handleDecideOp({ op: 'show', id: p.approvalId }).approval.invocationHash;
  assert.equal(optOut.handleDecideOp({ op: 'decide', id: p.approvalId, decision: 'approve', confirmHash: h, approverId: 'jace' }).ok, true);
  await optOut.stop();
  const env2 = await restart(legacy);
  assert.equal(env2.daemon.handleDecideOp({ op: 'show', id: p.approvalId }).code, 'NOT_FOUND');
  assert.equal(authorizeExact(env2, 'privileged_exec', PRIV).state, 'pending');
  await env2.daemon.stop();
});

await test('fix 5: decide_begin honors the risk class; the CLI falls back for non-passkey classes', async () => {
  const env = await setup();
  const w = authorizeExact(env, 'write_file', WRITE_ARGS);
  assert.equal(begin(env, w.approvalId).code, 'PASSKEY_NOT_REQUIRED');
  const lines = [];
  const io = { stdout: (t) => lines.push(t), stderr: (t) => lines.push(t), isTty: true, prompt: async () => show(env, w.approvalId).invocationHash.slice(0, 8) };
  assert.equal(await runApproveCommand('approve', [w.approvalId], { decideSocket: env.config.decideSocket, approverId: 'jace', io }), APPROVE_EXIT.ok, lines.join('\n'));
  assert.equal(statusOf(env, w.approvalId), 'approved');
  await env.daemon.stop();
});

await test('fix 5: the CLI handles an older daemon that answers UNKNOWN_OP to decide_begin', async () => {
  const base = path.join(root, `old${++seq}`);
  const keyPath = path.join(base, 'key', 'approver.key');
  const keyInfo = ensureApproverKey(keyPath, 'jc-approver-test');
  const daemon = new Approverd({ runtimeId: RUNTIME, stateDir: path.join(base, 'state'), keyPath, keyId: keyInfo.keyId, allowSelfAssertedPrivileged: true,
    requestSocket: path.join(base, 'request', 'request.sock'), decideSocket: path.join(base, 'decide', 'decide.sock') }, { now });
  await daemon.start();
  // A pre-v2 approverd: no decide_begin/decide_complete.
  const oldSock = path.join(base, 'old.sock');
  const ops = [];
  const server = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => {
      buf += d; const nl = buf.indexOf('\n'); if (nl < 0) return;
      const msg = JSON.parse(buf.slice(0, nl)); ops.push(msg.op);
      const reply = msg.op === 'decide_begin' || msg.op === 'decide_complete' ? { ok: false, code: 'UNKNOWN_OP' } : daemon.handleDecideOp(msg);
      c.end(`${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise((resolve) => server.listen(oldSock, resolve));
  const p = daemon.handleRequestOp({ op: 'authorize', runtimeId: RUNTIME, tool: 'write_file', arguments: WRITE_ARGS });
  const hash = daemon.handleDecideOp({ op: 'show', id: p.approvalId }).approval.invocationHash;
  const lines = [];
  const io = { stdout: (t) => lines.push(t), stderr: (t) => lines.push(t), isTty: true, prompt: async () => hash.slice(0, 8) };
  assert.equal(await runApproveCommand('approve', [p.approvalId], { decideSocket: oldSock, approverId: 'jace', io }), APPROVE_EXIT.ok, lines.join('\n'));
  assert.match(lines.join('\n'), /older daemon/);
  assert.deepEqual(ops, ['show', 'decide_begin', 'decide']);
  assert.equal(daemon.handleDecideOp({ op: 'show', id: p.approvalId }).approval.status, 'approved');
  await new Promise((resolve) => server.close(resolve));
  await daemon.stop();
});

await test('fix 5: Node engines match the WebAuthn library and the installer ships it root-owned', () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
  const lib = JSON.parse(fs.readFileSync(path.join(here, '..', 'node_modules', '@simplewebauthn', 'server', 'package.json'), 'utf8'));
  const major = (range) => Number(/>=\s*(\d+)/.exec(range)[1]);
  assert.ok(major(pkg.engines.node) >= major(lib.engines.node), `engines ${pkg.engines.node} < library ${lib.engines.node}`);
  assert.equal(pkg.dependencies['@simplewebauthn/server'], lib.version);
  const sh = fs.readFileSync(path.join(here, '..', 'deploy', 'jace-commander', 'install-approverd.sh'), 'utf8');
  assert.match(sh, /WEBAUTHN_PKG=@simplewebauthn\/server/);
  assert.match(sh, /\/opt\/jace-commander\/node_modules/);
  assert.match(sh, /chown -R root:root \/opt\/jace-commander\/node_modules/);
  assert.match(sh, /installed \$WEBAUTHN_PKG/);
  assert.doesNotMatch(sh, /if \[\[ -f "\$SRC\/\$f" \]\]; then install/); // passkey files are no longer optional
  assert.match(sh, /"passkey": \{ \\"trustAnchorPath|\\"passkey\\": \{/);
  // The shipped example config must be startable under the mandatory-passkey rule.
  const example = JSON.parse(fs.readFileSync(path.join(here, '..', 'deploy', 'jace-commander', 'approverd.example.json'), 'utf8'));
  assert.ok(example.passkey, 'approverd.example.json has a passkey block');
  assert.doesNotThrow(() => new Approverd({ ...example, runtimeId: RUNTIME }));
});

console.log(`jace-commander passkey approval: ${passed} passed`);
