#!/usr/bin/env node
/**
 * Principal separation for approverd (ACS review P0): a requester must not approve their own request.
 *
 * Every refusal is checked for ZERO side effects: the record stays pending, no token is granted, and no
 * `approval_decision` event is written to the audit chain. Synthetic WebAuthn authenticators; no real keys, no real root.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { Approverd, ensureApproverKey, principalSubject, operatorIsPrincipal } from '../dist/jace-commander/approverd.js';
import { JC_DECIDE_PROTOCOL_VERSION } from '../dist/jace-commander/approval-protocol.js';
import { readTraceFile } from '../dist/jace-commander/looptrace.js';

const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:7391';
const ANCHOR = '/etc/jace-commander/passkeys.json';
const RUNTIME = 'jc-test-runtime';
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-principal-')));
let clock = Date.now();
const now = () => clock;
let seq = 0;
let passed = 0;

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function makeAuthenticator(operatorId) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))], [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))]]));
  const credentialId = crypto.randomBytes(16).toString('base64url');
  const userHandle = crypto.randomBytes(16).toString('base64url');
  let counter = 0;
  return {
    credentialId, operatorId,
    entry: { credentialId, publicKey: Buffer.from(cose).toString('base64url'), userHandle, operatorId },
    sign(challenge) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false }));
      const cnt = Buffer.alloc(4); cnt.writeUInt32BE(++counter);
      const authData = Buffer.concat([crypto.createHash('sha256').update(RP_ID).digest(), Buffer.from([0x05]), cnt]);
      const signature = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(clientDataJSON).digest()]), privateKey);
      return {
        id: credentialId, rawId: credentialId, type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: clientDataJSON.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: signature.toString('base64url'), userHandle },
      };
    },
  };
}

function anchorIo(content) {
  const nodes = {
    '/': { uid: 0, mode: 0o40755, type: 'dir', ino: 1 },
    '/etc': { uid: 0, mode: 0o40755, type: 'dir', ino: 2 },
    '/etc/jace-commander': { uid: 0, mode: 0o40755, type: 'dir', ino: 3 },
    [ANCHOR]: { uid: 0, mode: 0o100644, type: 'file', ino: 4 },
  };
  const st = (n) => ({ uid: n.uid, mode: n.mode, dev: 1, ino: n.ino, size: Buffer.byteLength(content), isFile: () => n.type === 'file', isDirectory: () => n.type === 'dir', isSymbolicLink: () => false });
  return {
    lstat: (p) => { if (!nodes[p]) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return st(nodes[p]); },
    realpath: (p) => p,
    openNoFollow: (p) => { if (!nodes[p]) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return 7; },
    fstat: () => st(nodes[ANCHOR]),
    read: () => Buffer.from(content),
    close: () => {},
    writable: () => false,
    geteuid: () => 1500,
  };
}

async function setup({ requiredRiskClasses, allowSelfAssertedSeparation } = {}) {
  seq += 1;
  const base = path.join(root, `s${seq}`);
  const keyPath = path.join(base, 'key', 'approver.key');
  const keyInfo = ensureApproverKey(keyPath, 'jc-approver-test');
  const authenticator = makeAuthenticator('jace');
  const anchor = { version: 'jc.passkeys.v1', credentials: [authenticator.entry] };
  const config = {
    runtimeId: RUNTIME, stateDir: path.join(base, 'state'), keyPath, keyId: keyInfo.keyId,
    requestSocket: path.join(base, 'request', 'request.sock'), decideSocket: path.join(base, 'decide', 'decide.sock'),
    passkey: { trustAnchorPath: ANCHOR, rpId: RP_ID, origin: ORIGIN, ...(requiredRiskClasses ? { requiredRiskClasses } : {}) },
    ...(allowSelfAssertedSeparation !== undefined ? { allowSelfAssertedSeparation } : {}),
  };
  const daemon = new Approverd(config, { now, trustAnchorIo: anchorIo(JSON.stringify(anchor)) });
  await daemon.start();
  return { daemon, config, authenticator };
}

let argvSeq = 0;
/** Request an approval for a tool, bound to a requester principal. Each call gets a distinct invocation. */
function requestFor(env, principal, tool = 'privileged_exec') {
  argvSeq += 1;
  const args = tool === 'privileged_exec'
    ? { argv: ['/usr/bin/id', `--n=${argvSeq}`] }
    : { path: `/tmp/principal-${argvSeq}`, content: 'x' };
  const reply = env.daemon.handleRequestOp({ op: 'authorize', runtimeId: RUNTIME, tool, arguments: args, principal });
  assert.equal(reply.state, 'pending', JSON.stringify(reply));
  return reply.approvalId;
}
const show = (env, id) => env.daemon.handleDecideOp({ op: 'show', id }).approval;
const auditDecisions = (env) => readTraceFile(path.join(env.config.stateDir, 'audit.jsonl')).events.filter((e) => e.type === 'approval_decision');

async function passkeyComplete(env, id, operatorId = 'jace') {
  const invocationHash = show(env, id).invocationHash;
  const begun = env.daemon.handleDecideOp({ op: 'decide_begin', protocol: JC_DECIDE_PROTOCOL_VERSION, id, confirmHash: invocationHash });
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const webauthn = env.authenticator.sign(begun.webauthn.challenge);
  return env.daemon.handleDecideOp({
    op: 'decide_complete', protocol: JC_DECIDE_PROTOCOL_VERSION, id, decision: 'approve',
    assertion: { approvalId: id, challenge: begun.challenge, invocationHash, operatorId, issuedAt: begun.issuedAt, expiresAt: begun.expiresAt, webauthn },
  });
}

// ---- pure helpers ----------------------------------------------------------------------
await test('the principal subject strips the gateway separator and the chatgpt prefix', () => {
  assert.equal(principalSubject('chatgpt:jace|client-1'), 'jace');
  assert.equal(principalSubject('jace|client-1'), 'jace');
  assert.equal(principalSubject('jace'), 'jace');
});

await test('an operator is the principal when it matches the subject or the whole principal, and not otherwise', () => {
  assert.equal(operatorIsPrincipal('jace', 'chatgpt:jace|client-1'), true);
  assert.equal(operatorIsPrincipal('jace', 'jace'), true);
  assert.equal(operatorIsPrincipal('alice', 'chatgpt:jace|client-1'), false);
  assert.equal(operatorIsPrincipal('jace-admin', 'jace'), false, 'a different operator id must not match a prefix');
});

// ---- passkey path (authenticated operator) -------------------------------------------------
await test('a requester cannot approve their own request with their passkey: refused, zero side effects', async () => {
  const env = await setup({ requiredRiskClasses: ['privileged'] });
  try {
    const id = requestFor(env, 'chatgpt:jace|client-1');
    const done = await passkeyComplete(env, id, 'jace');
    assert.equal(done.ok, false);
    assert.equal(done.code, 'SELF_APPROVAL_DENIED');
    assert.equal(show(env, id).status, 'pending', 'the record must stay pending');
    assert.equal(auditDecisions(env).filter((e) => e.payload.approvalId === id).length, 0, 'no decision may be audited');
  } finally { await env.daemon.stop(); }
});

await test('a different authenticated operator may approve a request made by another principal', async () => {
  const env = await setup({ requiredRiskClasses: ['privileged'] });
  try {
    const id = requestFor(env, 'chatgpt:alice|client-1');
    const done = await passkeyComplete(env, id, 'jace');
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(show(env, id).status, 'approved');
  } finally { await env.daemon.stop(); }
});

// ---- legacy decide op (self-asserted approver) ----------------------------------------------
await test('the legacy decide op cannot approve a principal-bound record: refused, zero side effects', async () => {
  const env = await setup();
  try {
    const id = requestFor(env, 'chatgpt:jace|client-1', 'write_file');
    const reply = env.daemon.handleDecideOp({ op: 'decide', id, decision: 'approve', approverId: 'jace', confirmHash: show(env, id).invocationHash });
    assert.equal(reply.ok, false);
    assert.equal(reply.code, 'PRINCIPAL_SEPARATION_REQUIRES_PASSKEY');
    assert.equal(show(env, id).status, 'pending');
    assert.equal(auditDecisions(env).filter((e) => e.payload.approvalId === id).length, 0);
  } finally { await env.daemon.stop(); }
});

await test('the legacy decide op still approves a record with no requester principal (local preset unchanged)', async () => {
  const env = await setup();
  try {
    const id = requestFor(env, undefined, 'write_file');
    const reply = env.daemon.handleDecideOp({ op: 'decide', id, decision: 'approve', approverId: 'jace', confirmHash: show(env, id).invocationHash });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(show(env, id).status, 'approved');
  } finally { await env.daemon.stop(); }
});

await test('the explicit, configured opt-out lets the legacy op approve a principal-bound record', async () => {
  const env = await setup({ allowSelfAssertedSeparation: true });
  try {
    const id = requestFor(env, 'chatgpt:jace|client-1', 'write_file');
    const reply = env.daemon.handleDecideOp({ op: 'decide', id, decision: 'approve', approverId: 'jace', confirmHash: show(env, id).invocationHash });
    assert.equal(reply.ok, true, JSON.stringify(reply));
  } finally { await env.daemon.stop(); }
});

await test('the opt-out flag must be a boolean', async () => {
  seq += 1;
  const base = path.join(root, `bad${seq}`);
  const keyPath = path.join(base, 'key', 'approver.key');
  const keyInfo = ensureApproverKey(keyPath, 'jc-approver-test');
  assert.throws(() => new Approverd({
    runtimeId: RUNTIME, stateDir: path.join(base, 'state'), keyPath, keyId: keyInfo.keyId,
    requestSocket: path.join(base, 'r.sock'), decideSocket: path.join(base, 'd.sock'),
    allowSelfAssertedPrivileged: true, allowSelfAssertedSeparation: 'yes',
  }, { now }), /allowSelfAssertedSeparation must be a boolean/);
});

console.log(`principal separation: ${passed} passed`);
