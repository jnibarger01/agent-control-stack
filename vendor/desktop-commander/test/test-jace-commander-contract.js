#!/usr/bin/env node
/**
 * acs.jc.v1 capability verification: every binding fails closed.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileNonceStore, JcCapabilityVerifier, JcAuthorizationError, JC_TOOL_POLICIES } from '../dist/jace-commander/contract.js';
import { assertToolPolicyCoverage, JC_TOOLS } from '../dist/jace-commander/server.js';
import { makeIssuer } from './fixtures/jc-mint.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-contract-'));
const issuer = makeIssuer();
let storeCounter = 0;
const verifier = (opts = {}) => new JcCapabilityVerifier({
  publicKey: issuer.publicKeyB64,
  keyId: issuer.keyId,
  runtimeId: 'jc-test-runtime',
  nonceStore: new FileNonceStore(path.join(tmp, `nonces-${storeCounter++}`)),
  ...opts,
});

function rejects(fn, code) {
  assert.throws(fn, (error) => error instanceof JcAuthorizationError && error.code === code, `expected ${code}`);
}

const readArgs = { view: 'health' };
const privArgs = { argv: ['/usr/bin/apt-get', 'update'], timeoutMs: 120000 };
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`  ✓ ${name}`); };

test('valid read capability is granted and returns attribution', () => {
  const auth = verifier().verify('acs_read', readArgs, issuer.mint('acs_read', readArgs));
  assert.equal(auth.workItemId, 'wi-123');
  assert.deepEqual([...auth.scopes], ['integration.read']);
  assert.equal(auth.approvalId, undefined);
  assert.match(auth.nonceHash, /^[a-f0-9]{64}$/);
});

test('nonce is single-use (replay rejected), including across verifier instances sharing a store', () => {
  const store = new FileNonceStore(path.join(tmp, 'shared'));
  const cap = issuer.mint('acs_read', readArgs);
  verifier({ nonceStore: store }).verify('acs_read', readArgs, cap);
  rejects(() => verifier({ nonceStore: store }).verify('acs_read', readArgs, cap), 'JC_CAPABILITY_NONCE_REPLAY');
});

test('missing capability', () => rejects(() => verifier().verify('acs_read', readArgs, undefined), 'JC_CAPABILITY_MISSING'));
test('extra envelope field', () => rejects(() => verifier().verify('acs_read', readArgs, { ...issuer.mint('acs_read', readArgs), alg: 'none' }), 'JC_CAPABILITY_EXTRA_FIELD'));
test('extra payload field', () => {
  const cap = issuer.mint('acs_read', readArgs, { sudo: true });
  rejects(() => verifier().verify('acs_read', readArgs, cap), 'JC_CAPABILITY_EXTRA_FIELD');
});
test('unknown key id', () => rejects(() => verifier().verify('acs_read', readArgs, { ...issuer.mint('acs_read', readArgs), keyId: 'other' }), 'JC_CAPABILITY_KEY_UNKNOWN'));
test('signature from a different key', () => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  rejects(() => verifier().verify('acs_read', readArgs, issuer.mint('acs_read', readArgs, {}, { privateKey })), 'JC_CAPABILITY_SIGNATURE_INVALID');
});
test('payload mutated after signing', () => {
  const cap = issuer.mint('acs_read', readArgs);
  cap.payload.workItemId = 'wi-evil';
  rejects(() => verifier().verify('acs_read', readArgs, cap), 'JC_CAPABILITY_SIGNATURE_INVALID');
});
test('acs.dc.v1 capability cannot be replayed against jace-commander', () => {
  rejects(() => verifier().verify('acs_read', readArgs, issuer.mint('acs_read', readArgs, { version: 'acs.dc.v1' })), 'JC_CAPABILITY_VERSION_INVALID');
  rejects(() => verifier().verify('acs_read', readArgs, issuer.mint('acs_read', readArgs, { audience: 'desktop-commander' })), 'JC_CAPABILITY_AUDIENCE_INVALID');
});
test('issuer must be acs', () => rejects(() => verifier().verify('acs_read', readArgs, issuer.mint('acs_read', readArgs, { issuer: 'swarm' })), 'JC_CAPABILITY_ISSUER_INVALID'));
test('runtime mismatch', () => rejects(() => verifier().verify('acs_read', readArgs, issuer.mint('acs_read', readArgs, { runtimeId: 'other-host' })), 'JC_CAPABILITY_RUNTIME_MISMATCH'));
test('tool mismatch', () => rejects(() => verifier().verify('swarm_read', readArgs, issuer.mint('acs_read', readArgs)), 'JC_CAPABILITY_TOOL_MISMATCH'));
test('arguments mismatch (delivered args differ from bound args)', () => {
  rejects(() => verifier().verify('acs_read', { view: 'work-items' }, issuer.mint('acs_read', readArgs)), 'JC_CAPABILITY_ARGUMENTS_MISMATCH');
});
test('privileged argv change is rejected even by one argument', () => {
  const cap = issuer.mint('privileged_exec', privArgs);
  rejects(() => verifier().verify('privileged_exec', { ...privArgs, argv: ['/usr/bin/apt-get', 'upgrade'] }, cap), 'JC_CAPABILITY_ARGUMENTS_MISMATCH');
});
test('invocation hash must match normalized arguments', () => {
  rejects(() => verifier().verify('acs_read', readArgs, issuer.mint('acs_read', readArgs, { invocationHash: 'a'.repeat(64) })), 'JC_CAPABILITY_INVOCATION_HASH_MISMATCH');
});
test('scope must equal the tool policy exactly', () => {
  rejects(() => verifier().verify('acs_read', readArgs, issuer.mint('acs_read', readArgs, { scopes: ['integration.read', 'process.privileged'] })), 'JC_CAPABILITY_SCOPE_MISMATCH');
  rejects(() => verifier().verify('privileged_exec', privArgs, issuer.mint('privileged_exec', privArgs, { scopes: ['integration.write'] })), 'JC_CAPABILITY_SCOPE_MISMATCH');
});
test('privileged_exec requires a human approvalId', () => {
  rejects(() => verifier().verify('privileged_exec', privArgs, issuer.mint('privileged_exec', privArgs, { approvalId: undefined })), 'JC_CAPABILITY_APPROVAL_REQUIRED');
  const auth = verifier().verify('privileged_exec', privArgs, issuer.mint('privileged_exec', privArgs));
  assert.equal(auth.approvalId, 'appr-human-1');
});
test('approvalId is forbidden on non-approval tools', () => {
  rejects(() => verifier().verify('acs_read', readArgs, issuer.mint('acs_read', readArgs, { approvalId: 'appr-x' })), 'JC_CAPABILITY_APPROVAL_FORBIDDEN');
});
test('TTL > 30s, expired, and future-dated capabilities are rejected', () => {
  const now = Date.now();
  rejects(() => verifier().verify('acs_read', readArgs, issuer.mint('acs_read', readArgs, { expiresAt: new Date(now + 31_000).toISOString() }, { now })), 'JC_CAPABILITY_TIME_INVALID');
  rejects(() => verifier().verify('acs_read', readArgs, issuer.mint('acs_read', readArgs, {}, { now: now - 60_000 })), 'JC_CAPABILITY_TIME_INVALID');
  rejects(() => verifier().verify('acs_read', readArgs, issuer.mint('acs_read', readArgs, {}, { now: now + 60_000 })), 'JC_CAPABILITY_TIME_INVALID');
});
test('malformed nonce', () => rejects(() => verifier().verify('acs_read', readArgs, issuer.mint('acs_read', readArgs, { nonce: 'short' })), 'JC_CAPABILITY_NONCE_INVALID'));
test('nonce store unavailable fails closed', () => {
  const blocker = path.join(tmp, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  rejects(() => verifier({ nonceStore: new FileNonceStore(path.join(blocker, 'n')) }).verify('acs_read', readArgs, issuer.mint('acs_read', readArgs)), 'JC_CAPABILITY_NONCE_REPLAY');
});
test('no key configured fails closed', () => {
  rejects(() => verifier({ keyId: undefined }).verify('acs_read', readArgs, issuer.mint('acs_read', readArgs)), 'JC_CAPABILITY_KEY_UNKNOWN');
  rejects(() => verifier({ publicKey: undefined }).verify('acs_read', readArgs, issuer.mint('acs_read', readArgs)), 'JC_CAPABILITY_KEY_UNKNOWN');
});
test('every registered tool has a policy and exactly the mutating tools require approval', () => {
  assertToolPolicyCoverage();
  assert.equal(JC_TOOLS.length, Object.keys(JC_TOOL_POLICIES).length);
  const approvalTools = Object.entries(JC_TOOL_POLICIES).filter(([, p]) => p.requiresApproval).map(([n]) => n).sort();
  // Changing this list is a policy change: update migration 031's CHECK too.
  assert.deepEqual(approvalTools, [
    'create_directory', 'edit_block', 'git_add', 'git_commit', 'git_fetch', 'git_push',
    'kill_process', 'move_file', 'privileged_exec', 'start_process', 'write_file',
  ]);
  const privilegedTools = Object.entries(JC_TOOL_POLICIES).filter(([, p]) => p.scopes.includes('process.privileged')).map(([n]) => n);
  assert.deepEqual(privilegedTools, ['privileged_exec']);
});

console.log(`\njace-commander contract: ${passed} passed`);
