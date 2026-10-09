#!/usr/bin/env node
/**
 * ADR 0026 slice 4: approverd, jc.local.v1 tokens, `approve` CLI, and the server's
 * local approval flow. Real unix sockets and a real approverd in a temp dir.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { strictCanonicalJsonV1 } from '../dist/managed-acs.js';
import { FileNonceStore } from '../dist/jace-commander/contract.js';
import { loadJcConfig } from '../dist/jace-commander/config.js';
import { Approverd, ensureApproverKey, signLocalToken } from '../dist/jace-commander/approverd.js';
import { ApproverClient, ApproverUnavailable, approverCall } from '../dist/jace-commander/approver-client.js';
import { APPROVE_EXIT, runApproveCommand } from '../dist/jace-commander/approve-cli.js';
import {
  JcLocalTokenVerifier,
  computeLocalInvocationHash,
  localTokenSigningBytes,
} from '../dist/jace-commander/local-token.js';
import { createJcServer } from '../dist/jace-commander/server.js';
import { readTraceFile, verifyChain } from '../dist/jace-commander/looptrace.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-appr-')));
const RUNTIME = 'jc-test-runtime';
let seq = 0;
let clock = Date.now();
const now = () => clock;

async function makeApprover(extra = {}) {
  seq += 1;
  const base = path.join(root, `a${seq}`);
  const keyPath = path.join(base, 'key', 'approver.key');
  const keyInfo = ensureApproverKey(keyPath, 'jc-approver-test');
  const config = {
    runtimeId: RUNTIME,
    stateDir: path.join(base, 'state'),
    keyPath,
    keyId: keyInfo.keyId,
    requestSocket: path.join(base, 'request', 'request.sock'),
    decideSocket: path.join(base, 'decide', 'decide.sock'),
    ...extra,
  };
  const daemon = new Approverd(config, { now });
  await daemon.start();
  return { daemon, config, keyInfo, base };
}
const verifierFor = (info, extra = {}) => new JcLocalTokenVerifier({
  publicKey: info.keyInfo.publicKey,
  keyId: info.keyInfo.keyId,
  runtimeId: RUNTIME,
  nonceStore: new FileNonceStore(path.join(info.base, `nonces-${Math.random().toString(16).slice(2)}`)),
  now,
  ...extra,
});
const decide = (info, id, decision, hash) => info.daemon.handleDecideOp({ op: 'decide', id, decision, confirmHash: hash, approverId: 'op-1' });
const authorize = (info, tool, args) => info.daemon.handleRequestOp({ op: 'authorize', runtimeId: RUNTIME, tool, arguments: args });
const WRITE = { path: '/work/x.txt', content: 'hi' };

// ---------------------------------------------------------------- tokens ----

await test('a token minted by approverd verifies once and only for its exact invocation', async () => {
  const info = await makeApprover();
  const pending = authorize(info, 'write_file', WRITE);
  assert.equal(pending.state, 'pending');
  const hash = computeLocalInvocationHash(RUNTIME, 'write_file', WRITE);
  assert.equal(decide(info, pending.approvalId, 'approve', hash).ok, true);
  const granted = authorize(info, 'write_file', WRITE);
  assert.equal(granted.state, 'granted');
  assert.equal(granted.token.payload.version, 'jc.local.v1');
  assert.ok(Date.parse(granted.token.payload.expiresAt) - Date.parse(granted.token.payload.issuedAt) <= 30_000);
  const verifier = verifierFor(info);
  const auth = verifier.verify('write_file', WRITE, granted.token);
  assert.equal(auth.approverId, 'op-1');
  assert.equal(auth.approvalId, pending.approvalId);
  assert.equal(JSON.stringify(auth).includes(granted.token.payload.nonce), false, 'raw nonce is never exposed');
  assert.throws(() => verifier.verify('write_file', WRITE, granted.token), { code: 'JC_LOCAL_TOKEN_REPLAY' });
  await info.daemon.stop();
});

await test('token forgery matrix: wrong key, key id, runtime, tool, arguments, expiry, ttl, extra field, version, domain', async () => {
  const info = await makeApprover();
  const hash = computeLocalInvocationHash(RUNTIME, 'write_file', WRITE);
  const pending = authorize(info, 'write_file', WRITE);
  decide(info, pending.approvalId, 'approve', hash);
  const good = authorize(info, 'write_file', WRITE).token;
  const reject = (code, tool, args, token, verifier = verifierFor(info)) => assert.throws(() => verifier.verify(tool, args, token), { code });

  reject('JC_LOCAL_TOKEN_MISSING', 'write_file', WRITE, undefined);
  reject('JC_LOCAL_TOKEN_MALFORMED', 'write_file', WRITE, 'nope');
  reject('JC_LOCAL_TOKEN_TOOL_MISMATCH', 'move_file', WRITE, good);
  reject('JC_LOCAL_TOKEN_ARGUMENTS_MISMATCH', 'write_file', { ...WRITE, content: 'evil' }, good);
  reject('JC_LOCAL_TOKEN_KEY_UNKNOWN', 'write_file', WRITE, { ...good, keyId: 'someone-else' });
  reject('JC_LOCAL_TOKEN_MALFORMED', 'write_file', WRITE, { ...good, extra: 1 });
  reject('JC_LOCAL_TOKEN_MALFORMED', 'write_file', WRITE, { ...good, payload: { ...good.payload, extra: 1 } });
  reject('JC_LOCAL_TOKEN_SIGNATURE_INVALID', 'write_file', WRITE, { ...good, payload: { ...good.payload, tokenId: 'tok-other' } });
  reject('JC_LOCAL_TOKEN_RUNTIME_MISMATCH', 'write_file', WRITE, good, verifierFor(info, { runtimeId: 'jc-other-runtime' }));

  // Signed by a different key.
  const otherKey = crypto.generateKeyPairSync('ed25519').privateKey;
  const forged = signLocalToken({ privateKey: otherKey, keyId: info.keyInfo.keyId, runtimeId: RUNTIME, tool: 'write_file', invocationHash: hash, approvalId: 'apr-x', approverId: 'op-1', tokenId: 'tok-x', nonce: crypto.randomBytes(32).toString('base64url'), now: clock, ttlMs: 20_000 });
  reject('JC_LOCAL_TOKEN_SIGNATURE_INVALID', 'write_file', WRITE, forged);

  // Correctly signed by the REAL key but outside the rules: the verifier, not the signer, is the gate.
  const realKey = crypto.createPrivateKey({ key: Buffer.from(fs.readFileSync(info.config.keyPath, 'utf8').trim(), 'base64url'), format: 'der', type: 'pkcs8' });
  const handSigned = (overrides) => {
    const payload = { ...good.payload, nonce: crypto.randomBytes(32).toString('base64url'), tokenId: `tok-${crypto.randomBytes(4).toString('hex')}`, ...overrides };
    return { keyId: info.keyInfo.keyId, payload, signature: crypto.sign(null, localTokenSigningBytes(payload), realKey).toString('base64url') };
  };
  reject('JC_LOCAL_TOKEN_TIME_INVALID', 'write_file', WRITE, handSigned({ expiresAt: new Date(clock + 60_000).toISOString(), issuedAt: new Date(clock).toISOString() }));
  reject('JC_LOCAL_TOKEN_TIME_INVALID', 'write_file', WRITE, handSigned({ issuedAt: new Date(clock - 120_000).toISOString(), expiresAt: new Date(clock - 100_000).toISOString() }));
  reject('JC_LOCAL_TOKEN_VERSION_INVALID', 'write_file', WRITE, handSigned({ version: 'jc.local.v2' }));
  reject('JC_LOCAL_TOKEN_NONCE_INVALID', 'write_file', WRITE, handSigned({ nonce: 'short' }));
  assert.equal(verifierFor(info).verify('write_file', WRITE, handSigned({})).tool, 'write_file', 'a well-formed hand-signed token from the real key is accepted exactly once');

  // Domain separation: an acs.jc.v1-style signature (no domain prefix) over the same payload is not a jc.local.v1 token.
  const noDomain = { keyId: info.keyInfo.keyId, payload: good.payload, signature: crypto.sign(null, Buffer.from(strictCanonicalJsonV1(good.payload), 'utf8'), realKey).toString('base64url') };
  reject('JC_LOCAL_TOKEN_SIGNATURE_INVALID', 'write_file', WRITE, noDomain);
  assert.throws(() => signLocalToken({ privateKey: realKey, keyId: 'k', runtimeId: RUNTIME, tool: 'write_file', invocationHash: hash, approvalId: 'a', approverId: 'b', tokenId: 't', nonce: 'n', now: clock, ttlMs: 31_000 }), RangeError);
  await info.daemon.stop();
});

// -------------------------------------------------------------- approverd ----

await test('the approval is consumed by its claim: a second call needs a new approval, and a changed argument needs its own', async () => {
  const info = await makeApprover();
  const hash = computeLocalInvocationHash(RUNTIME, 'write_file', WRITE);
  const first = authorize(info, 'write_file', WRITE);
  assert.equal(authorize(info, 'write_file', WRITE).approvalId, first.approvalId, 'identical call reuses the pending request');
  assert.equal(decide(info, first.approvalId, 'approve', hash).ok, true);
  assert.equal(authorize(info, 'write_file', WRITE).state, 'granted');
  const again = authorize(info, 'write_file', WRITE);
  assert.equal(again.state, 'pending');
  assert.notEqual(again.approvalId, first.approvalId);
  const other = authorize(info, 'write_file', { ...WRITE, content: 'different' });
  assert.equal(other.state, 'pending');
  assert.notEqual(other.approvalId, again.approvalId);
  assert.equal(decide(info, other.approvalId, 'approve', hash).code, 'CONFIRMATION_MISMATCH', 'approving with another action\'s hash is refused');
  await info.daemon.stop();
});

await test('decisions: wrong confirmation hash refused; reject reported once then a fresh request; expiry kills pending and approved', async () => {
  const info = await makeApprover({ approvalTtlMs: 60_000 });
  const hash = computeLocalInvocationHash(RUNTIME, 'write_file', WRITE);
  const a = authorize(info, 'write_file', WRITE);
  assert.equal(decide(info, a.approvalId, 'approve', 'f'.repeat(64)).code, 'CONFIRMATION_MISMATCH');
  assert.equal(decide(info, a.approvalId, 'reject', hash).ok, true);
  assert.equal(authorize(info, 'write_file', WRITE).state, 'rejected');
  const fresh = authorize(info, 'write_file', WRITE);
  assert.equal(fresh.state, 'pending');
  assert.notEqual(fresh.approvalId, a.approvalId);
  assert.equal(decide(info, fresh.approvalId, 'approve', hash).ok, true);
  clock += 61_000; // approved but never claimed
  const afterExpiry = authorize(info, 'write_file', WRITE);
  assert.equal(afterExpiry.state, 'pending', 'an expired approval grants nothing');
  clock += 61_000;
  assert.equal(decide(info, afterExpiry.approvalId, 'approve', hash).code, 'EXPIRED');
  assert.equal(decide(info, 'apr-nope', 'approve', hash).code, 'NOT_FOUND');
  await info.daemon.stop();
});

await test('request validation: runtime mismatch, reads, unknown tools, bad ops, capacity', async () => {
  const info = await makeApprover({ maxPending: 2 });
  assert.equal(info.daemon.handleRequestOp({ op: 'authorize', runtimeId: 'other', tool: 'write_file', arguments: WRITE }).code, 'RUNTIME_MISMATCH');
  assert.equal(authorize(info, 'read_file', { path: '/x' }).code, 'INVALID_REQUEST');
  assert.equal(authorize(info, 'no_such_tool', {}).code, 'INVALID_REQUEST');
  assert.equal(authorize(info, 'write_file', 'not-an-object').code, 'INVALID_REQUEST');
  assert.equal(info.daemon.handleRequestOp({ op: 'list' }).code, 'UNKNOWN_OP');
  assert.equal(info.daemon.handleRequestOp('x').code, 'INVALID_REQUEST');
  assert.equal(info.daemon.handleDecideOp({ op: 'authorize' }).code, 'UNKNOWN_OP');
  authorize(info, 'write_file', { path: '/a', content: '1' });
  authorize(info, 'write_file', { path: '/b', content: '2' });
  assert.equal(authorize(info, 'write_file', { path: '/c', content: '3' }).code, 'TOO_MANY_PENDING');
  await info.daemon.stop();
});

await test('audit is a verifiable hash chain; if it cannot be written nothing is approved or minted', async () => {
  const info = await makeApprover();
  const hash = computeLocalInvocationHash(RUNTIME, 'write_file', WRITE);
  const a = authorize(info, 'write_file', WRITE);
  decide(info, a.approvalId, 'approve', hash);
  authorize(info, 'write_file', WRITE);
  const { events } = readTraceFile(path.join(info.config.stateDir, 'audit.jsonl'));
  assert.equal(verifyChain(events).ok, true);
  assert.deepEqual(events.map((event) => `${event.type}:${event.payload.action ?? ''}`), ['approval_requested:', 'approval_decision:approved', 'approval_decision:claimed']);
  assert.equal(JSON.stringify(events).includes('"signature"'), false);

  const broken = await makeApprover();
  fs.mkdirSync(path.join(broken.config.stateDir, 'audit.jsonl'), { recursive: true }); // unreadable as a trace
  assert.equal(authorize(broken, 'write_file', WRITE).code, 'AUDIT_UNAVAILABLE');
  await info.daemon.stop();
  await broken.daemon.stop();
});

await test('pending approvals survive an approverd restart; an unreadable record means no approval', async () => {
  const info = await makeApprover();
  const a = authorize(info, 'write_file', WRITE);
  await info.daemon.stop();
  fs.writeFileSync(path.join(info.config.stateDir, 'approvals', 'apr-garbage.json'), '{nope');
  const restarted = new Approverd(info.config, { now });
  await restarted.start();
  assert.equal(restarted.handleRequestOp({ op: 'authorize', runtimeId: RUNTIME, tool: 'write_file', arguments: WRITE }).approvalId, a.approvalId);
  await restarted.stop();
});

await test('sockets: separate directories (0750), 0660 sockets, disjoint operations, 0600 key that must not be group-readable', async () => {
  const info = await makeApprover();
  const mode = (target) => fs.statSync(target).mode & 0o777;
  assert.equal(mode(path.dirname(info.config.requestSocket)), 0o750);
  assert.equal(mode(path.dirname(info.config.decideSocket)), 0o750);
  assert.equal(mode(info.config.requestSocket), 0o660);
  assert.equal(mode(info.config.decideSocket), 0o660);
  assert.notEqual(path.dirname(info.config.requestSocket), path.dirname(info.config.decideSocket));
  assert.equal(mode(info.config.keyPath), 0o600);
  // The request socket cannot decide; the decide socket cannot authorize.
  const onRequest = await approverCall(info.config.requestSocket, { op: 'decide', id: 'x', decision: 'approve' });
  assert.equal(onRequest.code, 'UNKNOWN_OP');
  const onDecide = await approverCall(info.config.decideSocket, { op: 'authorize', runtimeId: RUNTIME, tool: 'write_file', arguments: WRITE });
  assert.equal(onDecide.code, 'UNKNOWN_OP');
  assert.equal((await approverCall(info.config.decideSocket, { op: 'list' })).ok, true);
  assert.equal((await approverCall(info.config.requestSocket, { op: 'ping' })).keyId, info.keyInfo.keyId);
  await info.daemon.stop();
  assert.equal(fs.existsSync(info.config.requestSocket), false);
  fs.chmodSync(info.config.keyPath, 0o640);
  await assert.rejects(new Approverd(info.config, { now }).start(), /must not be readable by group or others/);
  fs.chmodSync(info.config.keyPath, 0o600);
});

await test('client: an unreachable or non-answering approver is ApproverUnavailable', async () => {
  const client = new ApproverClient(path.join(root, 'nothing.sock'), RUNTIME, 300);
  await assert.rejects(client.authorize('write_file', WRITE), ApproverUnavailable);
  await assert.rejects(client.ping(), ApproverUnavailable);
});

// -------------------------------------------------------------- approve CLI --

function cliIo({ tty, answer }) {
  const lines = { out: [], err: [], prompts: [] };
  return { lines, io: { isTty: tty, stdout: (t) => lines.out.push(t), stderr: (t) => lines.err.push(t), prompt: async (q) => { lines.prompts.push(q); return typeof answer === 'function' ? answer(q) : answer; } } };
}

await test('approve CLI: refuses without a TTY before showing or sending anything; needs the typed hash prefix', async () => {
  const info = await makeApprover();
  const hash = computeLocalInvocationHash(RUNTIME, 'write_file', WRITE);
  const a = authorize(info, 'write_file', WRITE);
  const deps = (io) => ({ decideSocket: info.config.decideSocket, approverId: 'op-1', io });

  const noTty = cliIo({ tty: false, answer: hash.slice(0, 8) });
  assert.equal(await runApproveCommand('approve', [a.approvalId], deps(noTty.io)), APPROVE_EXIT.notAllowed);
  assert.equal(noTty.lines.prompts.length, 0);
  assert.equal(noTty.lines.out.length, 0);
  assert.equal(info.daemon.handleDecideOp({ op: 'show', id: a.approvalId }).approval.status, 'pending');

  const wrong = cliIo({ tty: true, answer: 'yes' });
  assert.equal(await runApproveCommand('approve', [a.approvalId], deps(wrong.io)), APPROVE_EXIT.failed);
  assert.equal(info.daemon.handleDecideOp({ op: 'show', id: a.approvalId }).approval.status, 'pending');
  const shown = wrong.lines.out.join('\n');
  assert.ok(shown.includes('write_file') && shown.includes(hash) && shown.includes('/work/x.txt'));

  const right = cliIo({ tty: true, answer: hash.slice(0, 8) });
  assert.equal(await runApproveCommand('approve', [a.approvalId], deps(right.io)), APPROVE_EXIT.ok);
  assert.equal(info.daemon.handleDecideOp({ op: 'show', id: a.approvalId }).approval.approverId, 'op-1');
  assert.equal(authorize(info, 'write_file', WRITE).state, 'granted');

  const listing = cliIo({ tty: false });
  assert.equal(await runApproveCommand('pending', [], deps(listing.io)), APPROVE_EXIT.ok);
  assert.match(listing.lines.out[0], /no pending approvals/);
  assert.equal(await runApproveCommand('approve', ['bad id!'], deps(cliIo({ tty: true }).io)), APPROVE_EXIT.usage);
  assert.equal(await runApproveCommand('approve', ['x'], { decideSocket: undefined, io: cliIo({ tty: true }).io }), APPROVE_EXIT.usage);
  assert.equal(await runApproveCommand('approve', ['apr-x'], { decideSocket: path.join(root, 'none.sock'), io: cliIo({ tty: true }).io }), APPROVE_EXIT.unavailable);
  await info.daemon.stop();
});

await test('approve CLI redacts secret-looking values in the DISPLAY only; the approval still binds the exact bytes', async () => {
  const info = await makeApprover();
  const args = { path: '/work/.env', content: 'password=hunter2hunter2' };
  const a = authorize(info, 'write_file', args);
  const { io, lines } = cliIo({ tty: true, answer: 'no' });
  await runApproveCommand('approve', [a.approvalId], { decideSocket: info.config.decideSocket, io });
  assert.equal(lines.out.join('\n').includes('hunter2hunter2'), false);
  assert.equal(info.daemon.handleDecideOp({ op: 'show', id: a.approvalId }).approval.arguments.content, args.content);
  await info.daemon.stop();
});

// ------------------------------------------------------- server integration --

const work = path.join(root, 'work');
fs.mkdirSync(work);
function serverConfig(info, extra = {}) {
  return loadJcConfig({
    HOME: root,
    JC_STATE_DIR: path.join(info.base, 'jcstate'),
    JC_FS_ROOTS: work,
    JC_RUNTIME_ID: RUNTIME,
    JC_POLICY_PATH: path.join(root, 'no-policy-here.json'),
    JC_APPROVER_SOCKET: info.config.requestSocket,
    JC_APPROVER_PUBLIC_KEY: info.keyInfo.publicKey,
    JC_APPROVER_KEY_ID: info.keyInfo.keyId,
    ...extra,
  });
}
async function connectLocal(config, deps = {}) {
  const server = createJcServer(config, 'local', {
    helperAvailable: async () => false,
    fetchImpl: async () => { throw new Error('no network'); },
    now,
    policy: { state: 'builtin-default', effective: { authorizerTable: undefined, classDecisions: { read: 'allow', mutate: 'approve', exec: 'approve', network: 'approve', privileged: 'approve' }, fsRoots: undefined, fsDeniedRoots: [], allowCommands: undefined, denyCommands: [], gitRemotes: undefined }, hash: 'a'.repeat(64), sources: [], immutable: true, unsafeDev: false, errors: [] },
    ...deps,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(b);
  return client;
}
const humanApprove = async (info, id) => {
  const record = info.daemon.handleDecideOp({ op: 'show', id }).approval;
  const io = cliIo({ tty: true, answer: record.invocationHash.slice(0, 8) });
  assert.equal(await runApproveCommand('approve', [id], { decideSocket: info.config.decideSocket, approverId: 'op-1', io: io.io }), APPROVE_EXIT.ok);
};

await test('server: approve-class call -> challenge -> human approves -> identical retry runs once; the next call needs a new approval', async () => {
  const info = await makeApprover();
  const config = serverConfig(info);
  const client = await connectLocal(config);
  const target = path.join(work, 'approved.txt');
  const args = { path: target, content: 'by-human' };

  const challenge = await client.callTool({ name: 'write_file', arguments: args });
  assert.equal(challenge.structuredContent.error.code, 'JC_LOCAL_APPROVAL_REQUIRED');
  const approvalId = challenge._meta.jcApproval.approvalId;
  assert.match(challenge._meta.jcApproval.command, new RegExp(`approve ${approvalId}`));
  assert.equal(fs.existsSync(target), false);

  const stillPending = await client.callTool({ name: 'write_file', arguments: args });
  assert.equal(stillPending._meta.jcApproval.approvalId, approvalId);
  assert.equal(fs.existsSync(target), false);

  await humanApprove(info, approvalId);
  const wrongArgs = await client.callTool({ name: 'write_file', arguments: { path: target, content: 'tampered' } });
  assert.equal(wrongArgs.structuredContent.error.code, 'JC_LOCAL_APPROVAL_REQUIRED', 'the approval does not cover different arguments');
  assert.equal(fs.existsSync(target), false);

  const ran = await client.callTool({ name: 'write_file', arguments: args });
  assert.equal(ran.isError, undefined, JSON.stringify(ran.structuredContent));
  assert.equal(fs.readFileSync(target, 'utf8'), 'by-human');
  assert.equal(ran._meta.jcAuthorization.decision, 'approved');
  assert.equal(ran._meta.jcAuthorization.approvalId, approvalId);
  assert.equal(ran._meta.jcAuthorization.approverId, 'op-1');
  assert.equal(JSON.stringify(ran).includes('"signature"'), false, 'the token never reaches the client');

  fs.rmSync(target);
  const second = await client.callTool({ name: 'write_file', arguments: args });
  assert.equal(second.structuredContent.error.code, 'JC_LOCAL_APPROVAL_REQUIRED', 'single-use');
  assert.notEqual(second._meta.jcApproval.approvalId, approvalId);
  assert.equal(fs.existsSync(target), false);

  const events = (() => {
    const dir = path.join(config.stateDir, 'traces');
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).flatMap((f) => readTraceFile(path.join(dir, f)).events);
  })().filter((event) => event.payload.approvalId === approvalId && event.payload.tool === 'write_file');
  // Two challenge denials (carrying the approval id), then the executed intent/result pair.
  assert.deepEqual(events.map((event) => `${event.type}:${event.payload.code ?? 'ok'}`), [
    'tool_call_finished:JC_LOCAL_APPROVAL_REQUIRED',
    'tool_call_finished:JC_LOCAL_APPROVAL_REQUIRED',
    'tool_call_started:ok',
    'tool_call_finished:ok',
  ]);
  events.splice(0, 2);
  assert.equal(events[0].payload.approverId, 'op-1');
  await client.close();
  await info.daemon.stop();
});

await test('server: exec class also goes through approval; privileged now requests one too (the helper holds the anchor)', async () => {
  const info = await makeApprover();
  const client = await connectLocal(serverConfig(info));
  const marker = path.join(work, 'ran.txt');
  const args = { argv: [process.execPath, '-e', `require("fs").writeFileSync(${JSON.stringify(marker)},"x")`], cwd: work };
  const challenge = await client.callTool({ name: 'start_process', arguments: args });
  assert.equal(challenge.structuredContent.error.code, 'JC_LOCAL_APPROVAL_REQUIRED');
  await humanApprove(info, challenge._meta.jcApproval.approvalId);
  const started = await client.callTool({ name: 'start_process', arguments: args });
  assert.equal(started.isError, undefined, JSON.stringify(started.structuredContent));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(fs.existsSync(marker), true);
  const priv = await client.callTool({ name: 'privileged_exec', arguments: { argv: ['/usr/bin/id'] } });
  assert.equal(priv.structuredContent.error.code, 'JC_LOCAL_APPROVAL_REQUIRED');
  const pending = info.daemon.handleDecideOp({ op: 'list' }).pending;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].riskClass, 'privileged');
  await client.close();
  await info.daemon.stop();
});

await test('server: a rejected request is reported once; approverd down or unconfigured fails closed', async () => {
  const info = await makeApprover();
  const client = await connectLocal(serverConfig(info));
  const target = path.join(work, 'rejected.txt');
  const args = { path: target, content: 'x' };
  const challenge = await client.callTool({ name: 'write_file', arguments: args });
  const record = info.daemon.handleDecideOp({ op: 'show', id: challenge._meta.jcApproval.approvalId }).approval;
  const io = cliIo({ tty: true, answer: record.invocationHash.slice(0, 8) });
  await runApproveCommand('reject', [record.id], { decideSocket: info.config.decideSocket, approverId: 'op-1', io: io.io });
  const rejected = await client.callTool({ name: 'write_file', arguments: args });
  assert.equal(rejected.structuredContent.error.code, 'JC_LOCAL_APPROVAL_REJECTED');
  const again = await client.callTool({ name: 'write_file', arguments: args });
  assert.equal(again.structuredContent.error.code, 'JC_LOCAL_APPROVAL_REQUIRED');
  await info.daemon.stop();
  const down = await client.callTool({ name: 'write_file', arguments: args });
  assert.equal(down.structuredContent.error.code, 'JC_LOCAL_APPROVAL_UNAVAILABLE');
  assert.equal(fs.existsSync(target), false);
  const bare = await connectLocal(loadJcConfig({ HOME: root, JC_STATE_DIR: path.join(info.base, 'bare'), JC_FS_ROOTS: work, JC_RUNTIME_ID: RUNTIME }));
  assert.equal((await bare.callTool({ name: 'write_file', arguments: args })).structuredContent.error.code, 'JC_LOCAL_APPROVAL_UNAVAILABLE');
  await client.close();
  await bare.close();
});

await test('server: an approver reply carrying a forged, mismatched or replayed token never runs anything', async () => {
  const info = await makeApprover();
  const config = serverConfig(info);
  const target = path.join(work, 'forged.txt');
  const args = { path: target, content: 'x' };
  const hash = computeLocalInvocationHash(RUNTIME, 'write_file', args);
  const mint = (privateKey, overrides = {}) => signLocalToken({ privateKey, keyId: info.keyInfo.keyId, runtimeId: RUNTIME, tool: 'write_file', invocationHash: hash, approvalId: 'apr-f', approverId: 'op-1', tokenId: 'tok-f', nonce: crypto.randomBytes(32).toString('base64url'), now: clock, ttlMs: 20_000, ...overrides });
  const realKey = crypto.createPrivateKey({ key: Buffer.from(fs.readFileSync(info.config.keyPath, 'utf8').trim(), 'base64url'), format: 'der', type: 'pkcs8' });
  const attacker = crypto.generateKeyPairSync('ed25519').privateKey;
  const reply = (token) => ({ authorize: async () => ({ state: 'granted', approvalId: 'apr-f', token }), ping: async () => ({ runtimeId: RUNTIME, keyId: info.keyInfo.keyId }) });
  const attempt = async (token) => {
    const client = await connectLocal(config, { approver: reply(token) });
    const result = await client.callTool({ name: 'write_file', arguments: args });
    await client.close();
    return result;
  };
  assert.equal((await attempt(mint(attacker))).structuredContent.error.code, 'JC_LOCAL_TOKEN_SIGNATURE_INVALID');
  assert.equal((await attempt(mint(realKey, { tool: 'move_file' }))).structuredContent.error.code, 'JC_LOCAL_TOKEN_TOOL_MISMATCH');
  assert.equal((await attempt(mint(realKey, { invocationHash: 'c'.repeat(64) }))).structuredContent.error.code, 'JC_LOCAL_TOKEN_ARGUMENTS_MISMATCH');
  assert.equal(fs.existsSync(target), false);
  const good = mint(realKey);
  assert.equal((await attempt(good)).isError, undefined);
  assert.equal(fs.existsSync(target), true);
  fs.rmSync(target);
  assert.equal((await attempt(good)).structuredContent.error.code, 'JC_LOCAL_TOKEN_REPLAY');
  assert.equal(fs.existsSync(target), false);
  await info.daemon.stop();
});

await test('doctor/status: approver health, and a server that can open decide.sock is flagged as a failure', async () => {
  const info = await makeApprover();
  const policyOnDisk = path.join(root, 'doctor-policy.json');
  const configFor = (extra) => serverConfig(info, extra);

  const doctor = async (config) => {
    const client = await connectLocal(config);
    const status = (await client.callTool({ name: 'jc_status', arguments: {} })).structuredContent;
    const report = (await client.callTool({ name: 'jc_doctor', arguments: {} })).structuredContent;
    await client.close();
    return { status, check: report.checks.find((entry) => entry.name === 'local approver') };
  };
  const clean = await doctor(configFor({ JC_APPROVER_DECIDE_SOCKET: path.join(root, 'unreachable', 'decide.sock') }));
  assert.equal(clean.status.approver.reachable, true);
  assert.equal(clean.status.approver.keyMatches, true);
  assert.equal(clean.status.approver.serverCanDecide, false);
  assert.equal(clean.check.ok, true, clean.check.detail);
  assert.equal(clean.check.required, true);

  // Same uid as the daemon in this test, so the server CAN open decide.sock: exactly the misconfiguration to catch.
  const leaky = await doctor(configFor({ JC_APPROVER_DECIDE_SOCKET: info.config.decideSocket }));
  assert.equal(leaky.status.approver.serverCanDecide, true);
  assert.equal(leaky.check.ok, false);
  assert.match(leaky.check.detail, /CAN OPEN decide\.sock/);

  const wrongKey = await doctor(configFor({ JC_APPROVER_KEY_ID: 'someone-else' }));
  assert.equal(wrongKey.check.ok, false);
  assert.equal(fs.existsSync(policyOnDisk), false);
  await info.daemon.stop();
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\njace-commander approval: ${passed} passed`);
