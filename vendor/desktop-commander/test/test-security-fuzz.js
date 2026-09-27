/**
 * P3.1 — property-based / fuzz regression coverage for the two surfaces
 * that take the least trustworthy input in this codebase: file paths
 * (validatePath) and ACS capability envelopes (ManagedAcsGuard.authorize).
 *
 * Unlike the existing fixed-vector tests (test-symlink-security.js,
 * test-managed-acs.js's per-field rejection cases), this generates a large
 * number of randomized malformed/adversarial inputs and asserts the same
 * invariant holds for every one of them:
 *
 *   - validatePath: never returns a path outside allowedDirectories, never
 *     throws anything other than a plain Error, never hangs.
 *   - ManagedAcsGuard.authorize: a mutated capability never authorizes
 *     (only the exact original, untouched envelope may), never throws
 *     anything other than ManagedAcsAuthorizationError, never hangs.
 *
 * Deterministic: seeded PRNG, seed logged on any failure so a failing case
 * can be reproduced exactly by re-running with SEED=<n>.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { configManager } from '../dist/config-manager.js';
import { validatePath } from '../dist/tools/filesystem.js';
import {
  ManagedAcsGuard,
  ManagedAcsAuthorizationError,
  computeDesktopCommanderInvocationHash,
  strictCanonicalJsonV1,
} from '../dist/managed-acs.js';

const ITERATIONS = Number(process.env.FUZZ_ITERATIONS) || 500;
const SEED = process.env.SEED ? Number(process.env.SEED) : Date.now();

// Small deterministic PRNG (mulberry32) — no dependency needed, and unlike
// Math.random() it's seedable, so a failure is reproducible via SEED=<n>.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function withTimeoutMs(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not complete within ${ms}ms — possible hang`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Fuzz corpus generators
// ---------------------------------------------------------------------------

const TRAVERSAL_FRAGMENTS = ['..', '../', '..\\', '....//', '%2e%2e%2f', '..;/', '.'];
const WEIRD_CHARS = ['\0', '\n', '\r', '\t', '‮', '﻿', '💥', '𝕏', '\0', ' ', '~'];
const SEPARATORS = ['/', '\\', '//', '\\\\', '/./'];

function randomChoice(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

function randomPathFuzz(rand, baseDir) {
  const strategies = [
    // Absolute escape attempts
    () => '/' + Array.from({ length: 1 + Math.floor(rand() * 5) }, () => randomChoice(rand, TRAVERSAL_FRAGMENTS)).join('/'),
    // Traversal mixed into an otherwise-valid-looking path under baseDir
    () => path.join(baseDir, Array.from({ length: 1 + Math.floor(rand() * 4) }, () => randomChoice(rand, TRAVERSAL_FRAGMENTS)).join(randomChoice(rand, SEPARATORS))),
    // Weird characters injected into a plausible filename
    () => path.join(baseDir, Array.from({ length: 1 + Math.floor(rand() * 8) }, () => randomChoice(rand, WEIRD_CHARS)).join('')),
    // Extremely long path segment
    () => path.join(baseDir, 'a'.repeat(50 + Math.floor(rand() * 4000))),
    // Deeply nested traversal
    () => baseDir + '/'.repeat(1 + Math.floor(rand() * 10)) + '..'.repeat(1 + Math.floor(rand() * 20)),
    // Windows-drive-looking absolute path (even on POSIX, must not be treated as relative-safe)
    () => `${String.fromCharCode(65 + Math.floor(rand() * 26))}:\\${randomChoice(rand, TRAVERSAL_FRAGMENTS)}\\secret.txt`,
    // Null-byte truncation attempt
    () => baseDir + '\0/../../etc/passwd',
    // Empty / pathological
    () => '',
    () => '   ',
    () => '.',
    () => '..',
  ];
  return randomChoice(rand, strategies)();
}

async function testValidatePathFuzzNeverEscapesAllowedDirectories() {
  console.log(`\n--- Fuzz: validatePath never escapes allowedDirectories (${ITERATIONS} cases, seed=${SEED}) ---`);
  const rand = mulberry32(SEED);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-fuzz-path-'));
  const allowedDir = path.join(root, 'allowed');
  await fs.mkdir(allowedDir, { recursive: true });
  await fs.writeFile(path.join(allowedDir, 'inside.txt'), 'safe');

  const originalConfig = await configManager.getConfig();
  await configManager.setValue('allowedDirectories', [allowedDir]);

  let checked = 0;
  let allowedCount = 0;
  let rejectedCount = 0;

  try {
    for (let i = 0; i < ITERATIONS; i++) {
      const candidate = randomPathFuzz(rand, allowedDir);
      checked++;

      let result;
      try {
        result = await withTimeoutMs(validatePath(candidate), 2000, 'validatePath');
      } catch (error) {
        assert.ok(
          error instanceof Error,
          `validatePath must only ever throw a plain Error, got ${error?.constructor?.name} for input ${JSON.stringify(candidate)} (seed=${SEED}, iteration=${i})`
        );
        rejectedCount++;
        continue;
      }

      allowedCount++;
      // The only invariant that actually matters: whatever path came back
      // must be inside allowedDir. Being lenient about what validatePath
      // *accepts* is fine (path.join with '.' or repeated separators can
      // legitimately normalize back to something inside allowedDir) — the
      // one thing that must never happen is escaping the sandbox.
      const normalizedResult = path.normalize(result);
      const normalizedAllowed = path.normalize(allowedDir);
      assert.ok(
        normalizedResult === normalizedAllowed || normalizedResult.startsWith(normalizedAllowed + path.sep),
        `validatePath returned a path outside allowedDirectories: input=${JSON.stringify(candidate)} -> ${result} (seed=${SEED}, iteration=${i})`
      );
    }
  } finally {
    await configManager.updateConfig(originalConfig);
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log(`ok: ${checked} fuzzed paths checked (${allowedCount} resolved inside the sandbox, ${rejectedCount} rejected), zero escapes, zero hangs, zero unexpected error types`);
}

// ---------------------------------------------------------------------------
// ACS capability envelope fuzzing
// ---------------------------------------------------------------------------

function mutateValue(rand, value) {
  const mutators = [
    () => undefined,
    () => null,
    () => '',
    () => 0,
    () => -1,
    () => 'a'.repeat(1 + Math.floor(rand() * 5000)),
    () => (typeof value === 'string' ? value.slice(0, Math.max(0, value.length - 1)) : value),
    () => (typeof value === 'string' ? value + randomChoice(rand, WEIRD_CHARS) : value),
    () => (typeof value === 'number' ? value + (rand() > 0.5 ? 1 : -1) : value),
    () => [value],
    () => ({ nested: value }),
    () => (typeof value === 'string' ? value.toUpperCase() : value),
  ];
  return randomChoice(rand, mutators)();
}

/**
 * Fields inside a capability *payload* that are actually load-bearing for
 * the "does this authorize (toolName, args)" question a single authorize()
 * call answers: what's being authorized (toolName/normalizedArguments/
 * invocationHash), under what policy (scopes), for which protocol/runtime
 * (version/issuer/audience/runtimeId), and when (issuedAt/expiresAt).
 *
 * Deliberately EXCLUDED: workItemId/attemptId/leaseId/leaseEpoch/
 * actionHash/requestHash/planHash/nonce/approvalId. Those are opaque
 * tracking identifiers with no externally-checkable ground truth inside a
 * single authorize() call — a differently-valued-but-validly-signed
 * capability with a different workItemId is a legitimately different
 * capability, not a bypass. Fuzzing them would only prove the schema
 * accepts flexible values there, not exercise a real security boundary.
 */
const PAYLOAD_SECURITY_FIELDS = [
  'version', 'issuer', 'audience', 'runtimeId', 'toolName',
  'normalizedArguments', 'invocationHash', 'scopes', 'issuedAt', 'expiresAt',
];

/** Mutates one randomly chosen security-relevant field of a capability payload. */
function mutatePayloadSecurityField(rand, payload) {
  const clone = JSON.parse(JSON.stringify(payload));
  const field = randomChoice(rand, PAYLOAD_SECURITY_FIELDS);
  if (field === 'normalizedArguments') {
    // Mutate the nested path value specifically — mutating the whole object
    // to a non-object would just fail schema shape checks trivially.
    clone.normalizedArguments = { ...clone.normalizedArguments, path: mutateValue(rand, clone.normalizedArguments.path) };
  } else if (field === 'scopes') {
    clone.scopes = rand() < 0.5 ? [] : [randomChoice(rand, ['fs.write', 'process.exec', 'network.read'])];
  } else {
    clone[field] = mutateValue(rand, clone[field]);
  }
  return clone;
}

/** Mutates one randomly chosen top-level field of the envelope itself (keyId/signature/payload as a whole). */
function mutateEnvelopeField(rand, envelope) {
  const clone = JSON.parse(JSON.stringify(envelope));
  const field = randomChoice(rand, ['keyId', 'signature']);
  clone[field] = mutateValue(rand, clone[field]);
  return clone;
}

async function testAcsCapabilityFuzzNeverAuthorizesAMutatedEnvelope() {
  console.log(`\n--- Fuzz: mutated ACS capabilities never authorize (${ITERATIONS} cases, seed=${SEED}) ---`);
  const rand = mulberry32(SEED);

  const rawPublicKey = Buffer.from('11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo', 'base64url');
  const publicKeyDer = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawPublicKey]);
  const privateKeyDer = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'),
  ]);
  const privateKey = crypto.createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' });
  const now = Date.parse('2026-01-01T00:00:10.000Z');

  const args = { path: '/safe/example.txt' };
  const validPayload = {
    version: 'acs.dc.v1',
    issuer: 'acs',
    audience: 'desktop-commander',
    runtimeId: 'runtime_01',
    workItemId: 'work_01',
    attemptId: 'attempt_01',
    leaseId: 'lease_01',
    leaseEpoch: 1,
    toolName: 'read_file',
    normalizedArguments: args,
    invocationHash: computeDesktopCommanderInvocationHash('read_file', args),
    actionHash: 'b'.repeat(64),
    requestHash: 'e'.repeat(64),
    planHash: 'd'.repeat(64),
    scopes: ['fs.read'],
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:00:30.000Z',
    nonce: crypto.randomBytes(32).toString('base64url'),
  };

  function sign(payload) {
    return crypto.sign(null, Buffer.from(strictCanonicalJsonV1(payload)), privateKey).toString('base64url');
  }

  const validEnvelope = { payload: validPayload, keyId: 'test-key-1', signature: sign(validPayload) };

  let checked = 0;
  let rejectedCount = 0;
  let acceptedCount = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    // Fresh guard + fresh nonce per iteration: nonce replay protection would
    // otherwise reject the *valid* control case after its first use, and a
    // guard shared across iterations would let one iteration's state (nonce
    // cache, identity) leak into the next, muddying what's actually tested.
    const guard = new ManagedAcsGuard({
      mode: 'managed',
      runtimeId: 'runtime_01',
      publicKey: publicKeyDer.toString('base64url'),
      keyId: 'test-key-1',
      allowedScopes: ['fs.read', 'fs.write', 'process.exec', 'process.spawn'],
      now: () => now,
    });
    guard.initialize({
      acsRuntimeBootstrap: {
        schemaVersion: 1,
        runtimeId: 'runtime_01',
        challenge: Buffer.alloc(32, 7).toString('base64url'),
        scopes: ['fs.read', 'fs.write', 'process.exec', 'process.spawn'],
      },
    });

    checked++;
    const freshPayload = { ...validPayload, nonce: crypto.randomBytes(32).toString('base64url') };

    // Control: every ~10th iteration, verify the exact unmutated envelope
    // still authorizes (proves the fuzz harness itself isn't just broken).
    if (i % 10 === 0) {
      const envelope = { payload: freshPayload, keyId: 'test-key-1', signature: sign(freshPayload) };
      const result = await withTimeoutMs(
        Promise.resolve().then(() => guard.authorize('read_file', args, { acsCapability: envelope })),
        2000,
        'guard.authorize (control case)',
      );
      assert.ok(result, `the unmutated control envelope must authorize (seed=${SEED}, iteration=${i})`);
      acceptedCount++;
      continue;
    }

    const mutationTarget = rand() < 0.5 ? 'payload' : 'envelope';
    let envelope;
    if (mutationTarget === 'payload') {
      // Mutate a security-relevant field inside the payload, then re-sign
      // so the signature itself is always valid — isolates "does the
      // field-level validation catch this" from "does signature
      // verification catch this". Since every mutation target here is
      // load-bearing for what's being authorized, a re-signed mutation
      // must never authorize the (fixed) 'read_file'/args this loop calls
      // with — unlike the non-security "opaque identifier" fields
      // (workItemId etc.), which a validly re-signed mutation legitimately
      // authorizes and are therefore not fuzzed here at all.
      const mutatedPayload = mutatePayloadSecurityField(rand, freshPayload);
      let signature;
      try {
        signature = sign(mutatedPayload);
      } catch {
        // strictCanonicalJsonV1 legitimately rejects some mutated shapes
        // (undefined values, etc.) before signing is even possible —
        // that is itself a safe outcome, just not one authorize() sees.
        continue;
      }
      envelope = { payload: mutatedPayload, keyId: 'test-key-1', signature };
    } else {
      // Mutate the envelope's own fields (keyId/signature) without re-signing
      // — this is the "attacker doesn't have the private key" case.
      envelope = mutateEnvelopeField(rand, { payload: freshPayload, keyId: 'test-key-1', signature: sign(freshPayload) });
    }

    try {
      const result = await withTimeoutMs(
        Promise.resolve().then(() => guard.authorize('read_file', args, { acsCapability: envelope })),
        2000,
        'guard.authorize',
      );
      // A mutation that happens to reconstruct something structurally
      // identical to a valid envelope (extremely unlikely, but the harness
      // must not assume it can't happen) is fine — anything else succeeding
      // would not be.
      assert.deepEqual(
        JSON.parse(JSON.stringify(envelope)),
        JSON.parse(JSON.stringify({ payload: freshPayload, keyId: 'test-key-1', signature: sign(freshPayload) })),
        `a mutated capability must never authorize unless it reconstructs an exactly valid envelope (seed=${SEED}, iteration=${i}): ${JSON.stringify(envelope)}`
      );
      acceptedCount++;
    } catch (error) {
      assert.ok(
        error instanceof ManagedAcsAuthorizationError,
        `authorize() must only ever throw ManagedAcsAuthorizationError for invalid input, got ${error?.constructor?.name}: ${error?.message} (seed=${SEED}, iteration=${i}, envelope=${JSON.stringify(envelope)})`
      );
      rejectedCount++;
    }
  }

  console.log(`ok: ${checked} fuzzed capability envelopes checked (${acceptedCount} valid/control, ${rejectedCount} correctly rejected), zero bypasses, zero unexpected error types, zero hangs`);
}

export default async function runTests() {
  try {
    await testValidatePathFuzzNeverEscapesAllowedDirectories();
    await testAcsCapabilityFuzzNeverAuthorizesAMutatedEnvelope();

    console.log('\nSecurity fuzz tests passed.');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Security fuzz test failed (reproduce with SEED=${SEED}):`, message);
    if (error instanceof Error && error.stack) console.error(error.stack);
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then((success) => process.exit(success ? 0 : 1));
}
