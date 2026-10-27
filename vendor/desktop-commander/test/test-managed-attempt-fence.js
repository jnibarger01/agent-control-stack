#!/usr/bin/env node
/**
 * Execution-time attempt fence (ACS review P0): a capability that is valid by signature and expiry must still be refused
 * once its attempt is cancelled, its lease has expired, or its epoch is superseded. Every denial is checked for ZERO side
 * effects: the simulated handler is never reached.
 *
 * Harness and signing vectors: the same deterministic keys as test-managed-authorization-contract.js.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  FIXED_ACS_SCOPES,
  ManagedAcsAuthorizationError,
  ManagedAcsGuard,
  computeDesktopCommanderInvocationHash,
  listManagedAcsToolPolicies,
  strictCanonicalJsonV1,
} from '../dist/managed-acs.js';

const rawPublicKey = Buffer.from('11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo', 'base64url');
const publicKeyDer = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawPublicKey]);
const privateKeyDer = Buffer.concat([
  Buffer.from('302e020100300506032b657004220420', 'hex'),
  Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'),
]);
const privateKey = crypto.createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' });

function makeGuard(attemptFence) {
  const guard = new ManagedAcsGuard({
    mode: 'managed',
    runtimeId: 'runtime_01',
    publicKey: publicKeyDer.toString('base64url'),
    keyId: 'test-key-1',
    allowedScopes: FIXED_ACS_SCOPES,
    ...(attemptFence ? { attemptFence } : {}),
  });
  guard.initialize({
    acsRuntimeBootstrap: {
      schemaVersion: 1,
      runtimeId: 'runtime_01',
      challenge: Buffer.alloc(32, 7).toString('base64url'),
      scopes: FIXED_ACS_SCOPES,
    },
  });
  return guard;
}

function capabilityPayload(toolName, normalizedArguments) {
  const policy = listManagedAcsToolPolicies()[toolName];
  const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  return {
    version: 'acs.dc.v1',
    issuer: 'acs',
    audience: 'desktop-commander',
    runtimeId: 'runtime_01',
    workItemId: 'work_01',
    attemptId: 'attempt_01',
    leaseId: 'lease_01',
    leaseEpoch: 3,
    toolName,
    normalizedArguments,
    invocationHash: computeDesktopCommanderInvocationHash(toolName, normalizedArguments),
    actionHash: 'b'.repeat(64),
    requestHash: 'e'.repeat(64),
    planHash: 'd'.repeat(64),
    scopes: [...policy.scopes],
    ...(policy.requiresApproval ? { approvalId: 'approval_01' } : {}),
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 29_000).toISOString(),
    nonce: crypto.randomBytes(32).toString('base64url'),
  };
}
const sign = (payload) => ({
  payload,
  keyId: 'test-key-1',
  signature: crypto.sign(null, Buffer.from(strictCanonicalJsonV1(payload)), privateKey).toString('base64url'),
});

const TOOL = 'read_file';
const ARGS = { path: '/fixture-root/a.txt' };

/** Run the boundary check and, only if it admits the call, the simulated side effect. */
async function executeAtBoundary(guard, envelope) {
  let sideEffects = 0;
  const outcome = await guard.authorizeAtBoundary(TOOL, ARGS, { acsCapability: envelope }).then(
    (authorization) => { sideEffects += 1; return { admitted: true, authorization }; },
    (error) => ({ admitted: false, error }),
  );
  return { ...outcome, sideEffects };
}

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}
let passed = 0;

await test('a live attempt is admitted, and the handler runs once', async () => {
  const seen = [];
  const guard = makeGuard(async (claims) => { seen.push(claims); return 'live'; });
  const envelope = sign(capabilityPayload(TOOL, ARGS));
  const outcome = await executeAtBoundary(guard, envelope);
  assert.equal(outcome.admitted, true, outcome.error?.message);
  assert.equal(outcome.sideEffects, 1);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { runtimeId: 'runtime_01', workItemId: 'work_01', attemptId: 'attempt_01', leaseId: 'lease_01', leaseEpoch: 3 });
});

for (const [verdict, code] of [['cancelled', 'ACS_ATTEMPT_CANCELLED'], ['expired', 'ACS_LEASE_EXPIRED'], ['superseded', 'ACS_LEASE_SUPERSEDED']]) {
  await test(`a ${verdict} attempt is refused with ${code}, and nothing runs`, async () => {
    const guard = makeGuard(async () => verdict);
    const outcome = await executeAtBoundary(guard, sign(capabilityPayload(TOOL, ARGS)));
    assert.equal(outcome.admitted, false);
    assert.ok(outcome.error instanceof ManagedAcsAuthorizationError);
    assert.equal(outcome.error.code, code);
    assert.equal(outcome.sideEffects, 0, 'a refused attempt must produce no side effect');
  });
}

await test('an unanswerable fence (throws) is refused as unknown, never as live', async () => {
  const guard = makeGuard(async () => { throw new Error('ACS unreachable'); });
  const outcome = await executeAtBoundary(guard, sign(capabilityPayload(TOOL, ARGS)));
  assert.equal(outcome.error?.code, 'ACS_ATTEMPT_STATE_UNKNOWN');
  assert.equal(outcome.sideEffects, 0);
});

await test('an out-of-vocabulary verdict is refused as unknown, never as live', async () => {
  const guard = makeGuard(async () => 'probably-fine');
  const outcome = await executeAtBoundary(guard, sign(capabilityPayload(TOOL, ARGS)));
  assert.equal(outcome.error?.code, 'ACS_ATTEMPT_STATE_UNKNOWN');
  assert.equal(outcome.sideEffects, 0);
});

await test('the fence runs only after the capability verifies: a forged capability never reaches the fence', async () => {
  let fenceCalls = 0;
  const guard = makeGuard(async () => { fenceCalls += 1; return 'live'; });
  const envelope = sign(capabilityPayload(TOOL, ARGS));
  envelope.signature = 'AAAA';
  const outcome = await executeAtBoundary(guard, envelope);
  assert.equal(outcome.admitted, false);
  assert.equal(fenceCalls, 0, 'an unverified capability must not be checked against ACS state');
  assert.equal(outcome.sideEffects, 0);
});

await test('a replayed capability is still refused by the nonce check, before the fence', async () => {
  let fenceCalls = 0;
  const guard = makeGuard(async () => { fenceCalls += 1; return 'live'; });
  const envelope = sign(capabilityPayload(TOOL, ARGS));
  assert.equal((await executeAtBoundary(guard, envelope)).admitted, true);
  const replay = await executeAtBoundary(guard, envelope);
  assert.equal(replay.error?.code, 'ACS_CAPABILITY_NONCE_REPLAY');
  assert.equal(fenceCalls, 1, 'only the first, admitted use reaches the fence');
  assert.equal(replay.sideEffects, 0);
});

await test('repeated unknown attempt state trips containment; the next live call is refused with zero side effects', async () => {
  let fenceCalls = 0;
  const verdicts = ['unknown', 'unknown', 'unknown'];
  const guard = makeGuard(async () => { fenceCalls += 1; return verdicts.shift() ?? 'live'; });
  for (let i = 0; i < 3; i += 1) {
    const r = await executeAtBoundary(guard, sign(capabilityPayload(TOOL, ARGS)));
    assert.equal(r.error?.code, 'ACS_ATTEMPT_STATE_UNKNOWN');
  }
  assert.deepEqual(guard.containmentStatus(), { contained: true, reason: 'attempt-state-unknown' });
  const callsBefore = fenceCalls;
  const blocked = await executeAtBoundary(guard, sign(capabilityPayload(TOOL, ARGS)));
  assert.equal(blocked.error?.code, 'ACS_CONTAINED');
  assert.equal(blocked.sideEffects, 0);
  assert.equal(fenceCalls, callsBefore, 'a contained guard must not even ask ACS');
});

await test('a definitive verdict resets the unknown count, so scattered unknowns do not contain', async () => {
  const verdicts = ['unknown', 'unknown', 'live', 'unknown', 'unknown'];
  const guard = makeGuard(async () => verdicts.shift() ?? 'live');
  for (let i = 0; i < 5; i += 1) await executeAtBoundary(guard, sign(capabilityPayload(TOOL, ARGS)));
  assert.equal(guard.containmentStatus().contained, false);
});

await test('containment is not cleared by the permissive mode: DC_ENFORCEMENT=off leaves it in force', async () => {
  const guard = makeGuard(async () => 'live');
  guard.contain('operator-test');
  const previous = process.env.DC_ENFORCEMENT;
  process.env.DC_ENFORCEMENT = 'off';
  try {
    const r = await executeAtBoundary(guard, sign(capabilityPayload(TOOL, ARGS)));
    assert.equal(r.error?.code, 'ACS_CONTAINED');
    assert.equal(r.sideEffects, 0);
    assert.equal(guard.containmentStatus().reason, 'operator-test', 'the first reason is kept');
  } finally {
    if (previous === undefined) delete process.env.DC_ENFORCEMENT; else process.env.DC_ENFORCEMENT = previous;
  }
});

console.log(`managed attempt fence: ${passed} passed`);
