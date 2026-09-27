#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  decryptPairingCode,
  encryptPairingCode,
  pairingKeysFromEnv,
  pkceMatches,
  signPairingState,
  verifyPairingState,
} from '../dist/pairing-crypto.js';

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); }
  catch (error) { failures++; console.error(`FAIL  ${name}\n  ${error.message}`); }
}
const key = crypto.randomBytes(32);
const session = 'S'.repeat(43);

test('AES-256-GCM round-trips the authorization code with a fresh 96-bit IV', () => {
  const a = encryptPairingCode(key, session, 'code-123');
  const b = encryptPairingCode(key, session, 'code-123');
  assert.notEqual(a, b, 'IV reuse');
  assert.equal(Buffer.from(a.split('.')[1], 'base64url').length, 12 + 'code-123'.length + 16);
  assert.equal(decryptPairingCode(key, session, a), 'code-123');
});
test('AAD mismatch (different session_id) fails closed', () => {
  assert.equal(decryptPairingCode(key, 'T'.repeat(43), encryptPairingCode(key, session, 'code-123')), null);
});
test('tamper and wrong key fail closed', () => {
  const sealed = encryptPairingCode(key, session, 'code-123');
  const raw = Buffer.from(sealed.split('.')[1], 'base64url');
  raw[14] ^= 1;
  assert.equal(decryptPairingCode(key, session, `v1.${raw.toString('base64url')}`), null);
  assert.equal(decryptPairingCode(crypto.randomBytes(32), session, sealed), null);
  assert.equal(decryptPairingCode(key, session, 'v0.' + sealed.split('.')[1]), null);
  assert.equal(decryptPairingCode(key, session, 'garbage'), null);
});
test('state HMAC verifies and rejects forgery', () => {
  const state = signPairingState(key, session, 'N'.repeat(43));
  assert.deepEqual(verifyPairingState(key, state), { sessionId: session, nonce: 'N'.repeat(43) });
  assert.equal(verifyPairingState(crypto.randomBytes(32), state), null);
  const forged = Buffer.from(`${'U'.repeat(43)}.${'N'.repeat(43)}.${Buffer.from(state, 'base64url').toString().split('.')[2]}`).toString('base64url');
  assert.equal(verifyPairingState(key, forged), null);
  assert.equal(verifyPairingState(key, 'not base64 !'), null);
});
test('PKCE accepts S256 only', () => {
  const verifier = 'v'.repeat(64);
  assert.equal(pkceMatches(verifier, crypto.createHash('sha256').update(verifier).digest('base64url')), true);
  assert.equal(pkceMatches(verifier, verifier), false, 'plain challenge accepted');
});
test('keys must decode to the required sizes', () => {
  assert.throws(() => pairingKeysFromEnv({ PAIRING_STATE_KEY: key.toString('base64'), PAIRING_CODE_KEY: crypto.randomBytes(16).toString('base64') }));
  assert.throws(() => pairingKeysFromEnv({ PAIRING_STATE_KEY: 'short', PAIRING_CODE_KEY: key.toString('base64') }));
  assert.equal(pairingKeysFromEnv({ PAIRING_STATE_KEY: key.toString('base64'), PAIRING_CODE_KEY: key.toString('base64') }).codeKey.length, 32);
});
process.exitCode = failures ? 1 : 0;
