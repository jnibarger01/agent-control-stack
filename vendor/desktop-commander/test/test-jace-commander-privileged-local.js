#!/usr/bin/env node
/**
 * ADR 0026 slice 5: the root helper keeps TWO trust anchors (ACS and the local
 * approver), read only from its root-owned config. Also pins that each installer's
 * file list is a complete import closure (a missing file means a dead helper).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Approverd, ensureApproverKey, signLocalToken } from '../dist/jace-commander/approverd.js';
import { APPROVE_EXIT, runApproveCommand } from '../dist/jace-commander/approve-cli.js';
import { loadJcConfig } from '../dist/jace-commander/config.js';
import { computeLocalInvocationHash } from '../dist/jace-commander/local-token.js';
import { executePrivileged, loadPrivilegedConfig } from '../dist/jace-commander/privileged-core.js';
import { readTraceFile, verifyChain } from '../dist/jace-commander/looptrace.js';
import { createJcServer } from '../dist/jace-commander/server.js';
import { makeIssuer } from './fixtures/jc-mint.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-privlocal-')));
const RUNTIME = 'jc-test-runtime';
const touchBin = fs.existsSync('/usr/bin/touch') ? '/usr/bin/touch' : '/bin/touch';
const echoBin = fs.existsSync('/bin/echo') ? '/bin/echo' : '/usr/bin/echo';
const env = { PATH: '/usr/bin:/bin' };

const acs = makeIssuer();
const approverKeyPath = path.join(tmp, 'approver-key', 'approver.key');
const approver = ensureApproverKey(approverKeyPath, 'jc-approver-test');
const approverPrivate = () => crypto.createPrivateKey({ key: Buffer.from(fs.readFileSync(approverKeyPath, 'utf8').trim(), 'base64url'), format: 'der', type: 'pkcs8' });
let n = 0;
const freshConfig = (extra = {}) => {
  n += 1;
  return {
    acsPublicKey: acs.publicKeyB64,
    acsKeyId: acs.keyId,
    runtimeId: RUNTIME,
    nonceDir: path.join(tmp, `nonces${n}`),
    auditPath: path.join(tmp, `audit${n}`, 'privileged.jsonl'),
    localPublicKey: approver.publicKey,
    localKeyId: approver.keyId,
    ...extra,
  };
};
const localToken = (args, overrides = {}) => signLocalToken({
  privateKey: approverPrivate(),
  keyId: approver.keyId,
  runtimeId: RUNTIME,
  tool: 'privileged_exec',
  invocationHash: computeLocalInvocationHash(RUNTIME, 'privileged_exec', args),
  approvalId: 'apr-human-9',
  approverId: 'op-1',
  tokenId: `tok-${crypto.randomBytes(4).toString('hex')}`,
  nonce: crypto.randomBytes(32).toString('base64url'),
  now: Date.now(),
  ttlMs: 20_000,
  ...overrides,
});

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };

await test('config: local anchor must be a pair, well formed, and different from the ACS anchor', () => {
  const load = (config) => {
    const file = path.join(tmp, `cfg-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(config));
    return loadPrivilegedConfig(file, false);
  };
  assert.equal(load(freshConfig()).localKeyId, approver.keyId);
  assert.equal(load({ ...freshConfig(), localPublicKey: undefined, localKeyId: undefined }).localKeyId, undefined);
  for (const [label, bad] of Object.entries({
    'only key id': { ...freshConfig(), localPublicKey: undefined },
    'only public key': { ...freshConfig(), localKeyId: undefined },
    'same key id as ACS': { ...freshConfig(), localKeyId: acs.keyId },
    'same public key as ACS': { ...freshConfig(), localPublicKey: acs.publicKeyB64 },
    'malformed key': { ...freshConfig(), localPublicKey: 'not base64url!' },
    'malformed id': { ...freshConfig(), localKeyId: 'bad id' },
  })) assert.throws(() => load(bad), (error) => error.code === 'PRIVILEGED_CONFIG_INVALID', label);
});

await test('a human-approved local token runs the exact argv once and is audited with its approval, not an ACS work item', async () => {
  const config = freshConfig();
  const args = { argv: [echoBin, 'hello-local'] };
  const token = localToken(args);
  const result = await executePrivileged({ capability: token, arguments: args }, config, { envOverride: env });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.stdout, 'hello-local\n');
  assert.deepEqual({ ...result.authorization }, { authority: 'jc.local.v1', approvalId: 'apr-human-9', approverId: 'op-1', tokenId: token.payload.tokenId, invocationHash: token.payload.invocationHash });
  const events = readTraceFile(config.auditPath).events;
  assert.deepEqual(events.map((event) => event.type), ['tool_call_started', 'tool_call_finished']);
  assert.equal(verifyChain(events).ok, true);
  assert.equal(events[0].payload.authority, 'jc.local.v1');
  assert.equal(events[0].payload.approvalId, 'apr-human-9');
  assert.equal(events[0].payload.workItemId, undefined);
  assert.equal(JSON.stringify(events).includes(token.signature), false, 'the token signature is never audited');
  const replay = await executePrivileged({ capability: token, arguments: args }, config, { envOverride: env });
  assert.deepEqual(replay, { ok: false, code: 'JC_LOCAL_TOKEN_REPLAY' });
});

await test('both anchors coexist: an ACS capability still works on the same helper, attributed to ACS', async () => {
  const config = freshConfig();
  const args = { argv: [echoBin, 'via-acs'] };
  const result = await executePrivileged({ capability: acs.mint('privileged_exec', args), arguments: args }, config, { envOverride: env });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.authorization.authority, 'acs.jc.v1');
  assert.equal(result.authorization.approvalId, 'appr-human-1');
  assert.equal(readTraceFile(config.auditPath).events[0].payload.authority, 'acs.jc.v1');
});

await test('anchors do not cross: each key verifies only its own artifact, and nothing runs on any rejection', async () => {
  const marker = path.join(tmp, 'must-not-exist');
  const args = { argv: [touchBin, marker] };
  const config = freshConfig();
  const attempt = async (capability, cfg = config, a = args) => executePrivileged({ capability, arguments: a }, cfg, { envOverride: env });
  const local = localToken(args);
  const aclCap = acs.mint('privileged_exec', args);

  // ACS-signed payload dressed in the local key id, and the local token dressed in the ACS key id.
  assert.deepEqual(await attempt({ ...aclCap, keyId: approver.keyId }), { ok: false, code: 'JC_LOCAL_TOKEN_MALFORMED' });
  assert.equal((await attempt({ ...local, keyId: acs.keyId })).ok, false);
  assert.equal((await attempt({ ...local, keyId: 'some-other-key' })).code, 'JC_CAPABILITY_KEY_UNKNOWN');
  // A helper that was never given the local anchor treats a local token as an unknown key.
  const noLocal = freshConfig({ localPublicKey: undefined, localKeyId: undefined });
  assert.equal((await attempt(localToken(args), noLocal)).code, 'JC_CAPABILITY_KEY_UNKNOWN');
  // Wrong signer, wrong runtime, other argv, expiry, lifetime over 30 s.
  const attacker = crypto.generateKeyPairSync('ed25519').privateKey;
  assert.equal((await attempt(localToken(args, { privateKey: attacker }))).code, 'JC_LOCAL_TOKEN_SIGNATURE_INVALID');
  assert.equal((await attempt(localToken(args, { runtimeId: 'other-runtime', invocationHash: computeLocalInvocationHash('other-runtime', 'privileged_exec', args) }))).code, 'JC_LOCAL_TOKEN_RUNTIME_MISMATCH');
  assert.equal((await attempt(localToken({ argv: [touchBin, `${marker}-other`] }))).code, 'JC_LOCAL_TOKEN_ARGUMENTS_MISMATCH');
  assert.equal((await attempt(localToken(args, { now: Date.now() - 120_000 }))).code, 'JC_LOCAL_TOKEN_TIME_INVALID');
  assert.throws(() => localToken(args, { ttlMs: 31_000 }), RangeError);
  // Not a root-controlled executable: refused even with a valid local token.
  const own = path.join(tmp, 'own-bin');
  fs.writeFileSync(own, '#!/bin/sh\ntouch "$1"\n', { mode: 0o755 });
  const ownArgs = { argv: [own, marker] };
  assert.equal((await attempt(localToken(ownArgs), config, ownArgs)).code, 'PRIVILEGED_EXECUTABLE_UNTRUSTED');
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(`${marker}-other`), false);
});

// ---- the real helper binary -------------------------------------------------

const helperJs = path.join(dist, 'jace-commander', 'privileged-helper.js');
const runHelper = (config, request, extraEnv = {}) => {
  const cfgPath = path.join(tmp, `helper-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify(config));
  const run = spawnSync(process.execPath, [helperJs], {
    input: JSON.stringify(request),
    env: { PATH: process.env.PATH, JC_PRIVILEGED_ALLOW_NONROOT: '1', JC_PRIVILEGED_CONFIG: cfgPath, ...extraEnv },
  });
  return { status: run.status, out: JSON.parse(run.stdout.toString()) };
};

await test('helper binary: accepts a local token from its config anchor, and ignores any local key supplied by the environment', async () => {
  const marker = path.join(tmp, 'helper-ran');
  const args = { argv: [touchBin, marker] };
  const withAnchor = runHelper(freshConfig(), { capability: localToken(args), arguments: args });
  assert.equal(withAnchor.status, 0, JSON.stringify(withAnchor.out));
  assert.equal(withAnchor.out.authorization.authority, 'jc.local.v1');
  assert.equal(fs.existsSync(marker), true);
  fs.rmSync(marker);

  // Config WITHOUT the anchor + attacker-supplied env pointing at their own key: still rejected, nothing runs.
  const attackerKeyPath = path.join(tmp, 'attacker', 'a.key');
  const attacker = ensureApproverKey(attackerKeyPath, 'attacker-key');
  const attackerPrivate = crypto.createPrivateKey({ key: Buffer.from(fs.readFileSync(attackerKeyPath, 'utf8').trim(), 'base64url'), format: 'der', type: 'pkcs8' });
  const forged = signLocalToken({ privateKey: attackerPrivate, keyId: attacker.keyId, runtimeId: RUNTIME, tool: 'privileged_exec', invocationHash: computeLocalInvocationHash(RUNTIME, 'privileged_exec', args), approvalId: 'apr-x', approverId: 'op', tokenId: 'tok-x', nonce: crypto.randomBytes(32).toString('base64url'), now: Date.now(), ttlMs: 20_000 });
  const noAnchor = freshConfig({ localPublicKey: undefined, localKeyId: undefined });
  const blocked = runHelper(noAnchor, { capability: forged, arguments: args }, {
    JC_LOCAL_PUBLIC_KEY: attacker.publicKey, JC_LOCAL_KEY_ID: attacker.keyId, JC_APPROVER_PUBLIC_KEY: attacker.publicKey, JC_APPROVER_KEY_ID: attacker.keyId,
  });
  assert.equal(blocked.status, 2);
  assert.equal(blocked.out.code, 'JC_CAPABILITY_KEY_UNKNOWN');
  assert.equal(fs.existsSync(marker), false);
});

// ---- server -> approverd -> real helper, end to end ------------------------

const cliIo = (answer) => ({ isTty: true, stdout: () => {}, stderr: () => {}, prompt: async () => answer });
await test('end to end: privileged_exec under the local preset needs a human, then the REAL helper runs it once', async () => {
  const marker = path.join(tmp, 'e2e-ran');
  const argv = [touchBin, marker];
  const base = path.join(tmp, 'e2e');
  const daemonConfig = {
    runtimeId: RUNTIME, stateDir: path.join(base, 'state'), keyPath: approverKeyPath, keyId: approver.keyId,
    requestSocket: path.join(base, 'request', 'request.sock'), decideSocket: path.join(base, 'decide', 'decide.sock'),
  };
  const daemon = new Approverd(daemonConfig);
  await daemon.start();

  // A stand-in for `sudo -n -- helper`: runs the real helper with the test config (non-root dev mode).
  const helperConfig = freshConfig();
  const cfgPath = path.join(tmp, 'e2e-helper.json');
  fs.writeFileSync(cfgPath, JSON.stringify(helperConfig));
  const fakeSudo = path.join(tmp, 'fake-sudo');
  fs.writeFileSync(fakeSudo, `#!/bin/sh\n[ "$1" = "-n" ] && [ "$2" = "--" ] || exit 9\nexec env -i PATH=/usr/bin:/bin JC_PRIVILEGED_ALLOW_NONROOT=1 JC_PRIVILEGED_CONFIG=${cfgPath} ${process.execPath} ${helperJs}\n`, { mode: 0o755 });

  const work = path.join(tmp, 'work');
  fs.mkdirSync(work, { recursive: true });
  const config = loadJcConfig({
    HOME: tmp, JC_STATE_DIR: path.join(base, 'jc'), JC_FS_ROOTS: work, JC_RUNTIME_ID: RUNTIME,
    JC_POLICY_PATH: path.join(tmp, 'no-policy.json'), JC_SUDO_PATH: fakeSudo, JC_PRIVILEGED_HELPER: '/ignored-by-fake-sudo',
    JC_APPROVER_SOCKET: daemonConfig.requestSocket, JC_APPROVER_PUBLIC_KEY: approver.publicKey, JC_APPROVER_KEY_ID: approver.keyId,
  });
  const server = createJcServer(config, 'local', {
    helperAvailable: async () => true,
    fetchImpl: async () => { throw new Error('no network'); },
    policy: { state: 'builtin-default', effective: { authorizerTable: undefined, classDecisions: { read: 'allow', mutate: 'approve', exec: 'approve', network: 'approve', privileged: 'approve' }, fsRoots: undefined, fsDeniedRoots: [], allowCommands: undefined, denyCommands: [], gitRemotes: undefined }, hash: 'b'.repeat(64), sources: [], immutable: true, unsafeDev: false, errors: [] },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(b);

  // A client-supplied ACS capability must not bypass the local authorizer.
  const smuggled = await client.callTool({ name: 'privileged_exec', arguments: { argv }, _meta: { acsCapability: acs.mint('privileged_exec', { argv }) } });
  assert.equal(smuggled.structuredContent.error.code, 'JC_LOCAL_APPROVAL_REQUIRED');
  assert.equal(fs.existsSync(marker), false);

  const approvalId = smuggled._meta.jcApproval.approvalId;
  const record = daemon.handleDecideOp({ op: 'show', id: approvalId }).approval;
  assert.equal(record.riskClass, 'privileged');
  assert.equal(await runApproveCommand('approve', [approvalId], { decideSocket: daemonConfig.decideSocket, approverId: 'op-1', io: cliIo(record.invocationHash.slice(0, 8)) }), APPROVE_EXIT.ok);

  const ran = await client.callTool({ name: 'privileged_exec', arguments: { argv } });
  assert.equal(ran.isError, undefined, JSON.stringify(ran.structuredContent));
  assert.equal(fs.existsSync(marker), true, 'the root helper ran the approved argv');
  assert.equal(ran.structuredContent.authorization.authority, 'jc.local.v1');
  assert.equal(ran.structuredContent.authorization.approvalId, approvalId);
  assert.equal(ran._meta.jcAuthorization.decision, 'approved');
  assert.equal(ran._meta.acsAuthorization.decision, 'not-required');

  fs.rmSync(marker);
  const again = await client.callTool({ name: 'privileged_exec', arguments: { argv } });
  assert.equal(again.structuredContent.error.code, 'JC_LOCAL_APPROVAL_REQUIRED', 'the approval was single-use');
  assert.equal(fs.existsSync(marker), false);

  // Helper without the local anchor: the approval is spent, the helper refuses, nothing runs.
  fs.writeFileSync(cfgPath, JSON.stringify(freshConfig({ localPublicKey: undefined, localKeyId: undefined })));
  const id2 = again._meta.jcApproval.approvalId;
  const rec2 = daemon.handleDecideOp({ op: 'show', id: id2 }).approval;
  await runApproveCommand('approve', [id2], { decideSocket: daemonConfig.decideSocket, approverId: 'op-1', io: cliIo(rec2.invocationHash.slice(0, 8)) });
  const refused = await client.callTool({ name: 'privileged_exec', arguments: { argv } });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.error.code, 'JC_CAPABILITY_KEY_UNKNOWN');
  assert.equal(fs.existsSync(marker), false);

  await client.close();
  await daemon.stop();
});

// ---- installer closure ------------------------------------------------------

function importClosure(entry) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = fs.readFileSync(path.join(dist, file), 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s*['"](\.{1,2}\/[^'"]+\.js)['"]/g)) {
      visit(path.normalize(path.join(path.dirname(file), match[1])));
    }
  };
  visit(entry);
  return [...seen].sort();
}
function installerFiles(script) {
  const text = fs.readFileSync(path.join(here, '..', 'deploy', 'jace-commander', script), 'utf8');
  const match = text.match(/^FILES=\(([^)]*)\)/m);
  assert.ok(match, `${script} must declare FILES=(...)`);
  return match[1].trim().split(/\s+/).sort();
}

await test('installers copy a COMPLETE import closure (a missing module means a dead helper or approver)', () => {
  assert.deepEqual(installerFiles('install-privileged-helper.sh'), importClosure('jace-commander/privileged-helper.js'));
  assert.deepEqual(installerFiles('install-approverd.sh'), importClosure('jace-commander/approverd-cli.js'));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\njace-commander privileged-local: ${passed} passed`);
