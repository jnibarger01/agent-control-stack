#!/usr/bin/env node
/**
 * acs.jc.v1 sign/verify interop: capabilities MINTED BY ACS (agent-control-stack
 * packages/desktop-commander-adapter/src/jace-commander-capability.ts) must
 * verify here unchanged. The vector is pinned byte-identically in both repos:
 *   ACS: packages/desktop-commander-adapter/src/fixtures/acs-jc-v1-interop-vector.json
 *   DC:  test/fixtures/acs-jc-v1-interop-vector.json
 * Ed25519 is deterministic, so any drift in canonicalization, field set or
 * invocation hashing on either side breaks this test.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeJcInvocationHash, FileNonceStore, JcAuthorizationError, JcCapabilityVerifier } from '../dist/jace-commander/contract.js';
import { strictCanonicalJsonV1 } from '../dist/managed-acs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'acs-jc-v1-interop-vector.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-acs-interop-'));
let counter = 0;
const verifier = () => new JcCapabilityVerifier({
  publicKey: vector.publicKey,
  keyId: vector.keyId,
  runtimeId: vector.runtimeId,
  nonceStore: new FileNonceStore(path.join(tmp, `nonces-${counter++}`)),
  now: () => vector.verifyAtMs,
});

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`  ✓ ${name}`); };

try {
  for (const entry of vector.cases) {
    test(`ACS-minted ${entry.name} verifies`, () => {
      assert.equal(computeJcInvocationHash(entry.toolName, entry.arguments), entry.invocationHash);
      const digest = crypto.createHash('sha256').update(strictCanonicalJsonV1(entry.capability.payload), 'utf8').digest('hex');
      assert.equal(digest, entry.canonicalPayloadSha256);
      const auth = verifier().verify(entry.toolName, entry.arguments, entry.capability);
      assert.equal(auth.workItemId, entry.capability.payload.workItemId);
      assert.equal(auth.approvalId, entry.capability.payload.approvalId);
    });
  }
  test('approved privileged_exec vector carries approvalId and process.privileged', () => {
    const entry = vector.cases.find((c) => c.toolName === 'privileged_exec');
    assert.ok(entry.capability.payload.approvalId);
    assert.deepEqual(entry.capability.payload.scopes, ['process.privileged']);
  });
  test('ACS-minted privileged_exec does not verify for a different argv', () => {
    const entry = vector.cases.find((c) => c.toolName === 'privileged_exec');
    const tampered = { ...entry.arguments, argv: ['/usr/bin/apt-get', 'install', '-y', 'nmap'] };
    assert.throws(() => verifier().verify('privileged_exec', tampered, entry.capability),
      (error) => error instanceof JcAuthorizationError && error.code === 'JC_CAPABILITY_ARGUMENTS_MISMATCH');
  });
  for (const entry of vector.negatives) {
    test(`rejects ${entry.name} (${entry.expectedCode})`, () => {
      assert.throws(() => verifier().verify(entry.toolName, entry.arguments, entry.capability),
        (error) => error instanceof JcAuthorizationError && error.code === entry.expectedCode);
    });
  }
  console.log(`\n${passed} acs.jc.v1 interop checks passed`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
