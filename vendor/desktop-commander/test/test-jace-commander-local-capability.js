#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mintJcLocalCapability, verifyJcLocalCapability, FileNonceStore } from '../dist/jace-commander/local-capability.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-local-capability-'));
try {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const otherKey = crypto.generateKeyPairSync('ed25519').publicKey;
  const args = { path: '/tmp/test', content: 'hi' };
  const invocation = { runtimeId: 'runtime-1', tool: 'write_file', arguments: args };
  const now = Date.now();
  const token = mintJcLocalCapability(privateKey, { ...invocation, approverId: 'operator-1' }, now);
  const nonceDir = path.join(dir, 'nonces');
  const verifier = (t, expected = invocation, key = publicKey, currentTime = now) =>
    verifyJcLocalCapability(t, key, expected, new FileNonceStore(nonceDir), currentTime);

  assert.equal(verifier(token).approverId, 'operator-1');
  assert.throws(() => verifier(token), /JC_CAPABILITY_NONCE_REPLAY/);
  const token2 = mintJcLocalCapability(privateKey, { ...invocation, approverId: 'operator-1' }, now);
  assert.throws(() => verifier(token2, { ...invocation, arguments: { ...args, content: 'altered' } }), /JC_LOCAL_INVOCATION_MISMATCH/);
  assert.throws(() => verifier(token2, { ...invocation, tool: 'edit_block' }), /JC_LOCAL_INVOCATION_MISMATCH/);
  assert.throws(() => verifier(token2, { ...invocation, runtimeId: 'runtime-2' }), /JC_LOCAL_INVOCATION_MISMATCH/);
  assert.throws(() => verifier(token2, invocation, otherKey), /JC_LOCAL_SIGNATURE_INVALID/);
  assert.throws(() => verifier(token2, invocation, publicKey, now + 31_000), /JC_LOCAL_EXPIRED/);
  assert.throws(() => verifier({ ...token2, payload: { ...token2.payload, approverId: 'forged' } }), /JC_LOCAL_SIGNATURE_INVALID/);
  assert.throws(() => verifier({ ...token2, payload: { ...token2.payload, extra: true } }), /JC_LOCAL_MALFORMED/);
  assert.equal(verifier(token2).tool, 'write_file');
  console.log('jc.local.v1 signature, exact binding, expiry and replay: passed');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
