import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ACS_CAPABILITY_VERSION,
  FIXED_ACS_SCOPES,
  ManagedAcsAuthorizationError,
  ManagedAcsGuard,
  computeDesktopCommanderInvocationHash,
  strictCanonicalJsonV1,
} from '../dist/managed-acs.js';
import { hasDuplicateJsonObjectKeys } from '../dist/custom-stdio.js';

const rawPublicKey = Buffer.from('11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo', 'base64url');
const publicKeyDer = Buffer.concat([
  Buffer.from('302a300506032b6570032100', 'hex'),
  rawPublicKey,
]);
const privateKeyDer = Buffer.concat([
  Buffer.from('302e020100300506032b657004220420', 'hex'),
  Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'),
]);
const privateKey = crypto.createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' });

const vectorPayload = {
  actionHash: 'b'.repeat(64),
  approvalId: 'approval_01',
  attemptId: 'attempt_01',
  audience: 'desktop-commander',
  expiresAt: '2026-01-01T00:00:30.000Z',
  invocationHash: '6af81e88c93e386faa99e6632a2ae5ffddc020bce94fe328457333cb2b5d065c',
  issuedAt: '2026-01-01T00:00:00.000Z',
  issuer: 'acs',
  leaseEpoch: 7,
  leaseId: 'lease_01',
  nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  normalizedArguments: { path: '/safe/example.txt' },
  planHash: 'd'.repeat(64),
  requestHash: 'e'.repeat(64),
  runtimeId: 'runtime_01',
  scopes: ['fs.read'],
  toolName: 'read_file',
  version: 'acs.dc.v1',
  workItemId: 'work_01',
};
const vectorCanonical = '{"actionHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","approvalId":"approval_01","attemptId":"attempt_01","audience":"desktop-commander","expiresAt":"2026-01-01T00:00:30.000Z","invocationHash":"6af81e88c93e386faa99e6632a2ae5ffddc020bce94fe328457333cb2b5d065c","issuedAt":"2026-01-01T00:00:00.000Z","issuer":"acs","leaseEpoch":7,"leaseId":"lease_01","nonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","normalizedArguments":{"path":"/safe/example.txt"},"planHash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","requestHash":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","runtimeId":"runtime_01","scopes":["fs.read"],"toolName":"read_file","version":"acs.dc.v1","workItemId":"work_01"}';
const vectorSignature = 'AuwuJGjaMYpo6aQ9rJwGAzNZ3sYD2qfFETKavOk5kYOMVFpfFXven56q3eBdczDI-GSl7ujzqKDuxURqOwp5BA';

assert.equal(ACS_CAPABILITY_VERSION, 'acs.dc.v1');
assert.equal(hasDuplicateJsonObjectKeys('{"payload":{"nonce":"one","nonce":"two"}}'), true);
assert.equal(hasDuplicateJsonObjectKeys('{"left":{"nonce":"one"},"right":{"nonce":"two"}}'), false);
assert.equal(hasDuplicateJsonObjectKeys('{"escaped\\u004bey":1,"escapedKey":2}'), true);
assert.deepEqual(FIXED_ACS_SCOPES, [
  'fs.read',
  'fs.write',
  'network.read',
  'network.write',
  'process.exec',
  'process.spawn',
]);
assert.equal(strictCanonicalJsonV1(vectorPayload), vectorCanonical);
assert.equal(
  computeDesktopCommanderInvocationHash('read_file', { path: '/safe/example.txt' }),
  vectorPayload.invocationHash,
);
assert.equal(
  crypto.verify(
    null,
    Buffer.from(vectorCanonical),
    { key: publicKeyDer, format: 'der', type: 'spki' },
    Buffer.from(vectorSignature, 'base64url'),
  ),
  true,
  'published architecture vector must verify',
);

for (const invalid of [
  { value: { x: undefined }, message: /undefined/ },
  { value: [1, , 3], message: /sparse/ },
  { value: Number.NaN, message: /finite/ },
]) {
  assert.throws(() => strictCanonicalJsonV1(invalid.value), invalid.message);
}
const accessor = {};
Object.defineProperty(accessor, 'secret', { enumerable: true, get: () => 'nope' });
assert.throws(() => strictCanonicalJsonV1(accessor), /accessor/);

const now = Date.parse('2026-01-01T00:00:10.000Z');
const bootstrapChallenge = Buffer.alloc(32, 7).toString('base64url');
const guard = new ManagedAcsGuard({
  mode: 'managed',
  runtimeId: 'runtime_01',
  publicKey: publicKeyDer.toString('base64url'),
  keyId: 'test-key-1',
  allowedScopes: FIXED_ACS_SCOPES,
  now: () => now,
});

const duplicateGuard = new ManagedAcsGuard({
  mode: 'managed',
  runtimeId: 'runtime_01',
  publicKey: publicKeyDer.toString('base64url'),
  keyId: 'test-key-1',
  allowedScopes: FIXED_ACS_SCOPES,
  now: () => now,
});
assert.throws(
  () => duplicateGuard.initialize({
    __acsDuplicateJsonKeys: true,
    acsRuntimeBootstrap: {
      schemaVersion: 1,
      runtimeId: 'runtime_01',
      challenge: bootstrapChallenge,
      scopes: FIXED_ACS_SCOPES,
    },
  }),
  (error) => error.code === 'ACS_RUNTIME_IDENTITY_DRIFT',
);

const unconfiguredGuard = new ManagedAcsGuard({ mode: 'managed', runtimeId: 'runtime_01' });
assert.throws(
  () => unconfiguredGuard.initialize({
    acsRuntimeBootstrap: {
      schemaVersion: 1,
      runtimeId: 'runtime_01',
      challenge: bootstrapChallenge,
      scopes: FIXED_ACS_SCOPES,
    },
  }),
  (error) => error.code === 'ACS_CAPABILITY_KEY_UNKNOWN',
);

assert.throws(
  () => guard.authorize('read_file', { path: '/safe/example.txt' }, undefined),
  (error) => error instanceof ManagedAcsAuthorizationError && error.code === 'ACS_RUNTIME_IDENTITY_MISSING',
);
const handshake = guard.initialize({
  acsRuntimeBootstrap: {
    schemaVersion: 1,
    runtimeId: 'runtime_01',
    challenge: bootstrapChallenge,
    scopes: FIXED_ACS_SCOPES,
  },
});
assert.deepEqual(handshake, {
  schemaVersion: 1,
  runtimeId: 'runtime_01',
  challenge: bootstrapChallenge,
  scopes: FIXED_ACS_SCOPES,
});

function sign(payload) {
  return {
    payload,
    keyId: 'test-key-1',
    signature: crypto.sign(null, Buffer.from(strictCanonicalJsonV1(payload)), privateKey).toString('base64url'),
  };
}

function payload(overrides = {}) {
  const normalizedArguments = overrides.normalizedArguments ?? { path: '/safe/example.txt' };
  const toolName = overrides.toolName ?? 'read_file';
  return {
    version: ACS_CAPABILITY_VERSION,
    issuer: 'acs',
    audience: 'desktop-commander',
    runtimeId: 'runtime_01',
    workItemId: 'work_01',
    attemptId: 'attempt_01',
    leaseId: 'lease_01',
    leaseEpoch: 7,
    toolName,
    normalizedArguments,
    invocationHash: computeDesktopCommanderInvocationHash(toolName, normalizedArguments),
    actionHash: 'b'.repeat(64),
    requestHash: 'e'.repeat(64),
    planHash: 'd'.repeat(64),
    scopes: ['fs.read'],
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:00:30.000Z',
    nonce: crypto.randomBytes(32).toString('base64url'),
    ...overrides,
  };
}

const successEnvelope = sign(payload());
const authorization = guard.authorize(
  'read_file',
  { path: '/safe/example.txt' },
  { acsCapability: successEnvelope },
);
assert.deepEqual(authorization, {
  version: 'acs.dc.v1',
  keyId: 'test-key-1',
  runtimeId: 'runtime_01',
  workItemId: 'work_01',
  attemptId: 'attempt_01',
  leaseId: 'lease_01',
  leaseEpoch: 7,
  toolName: 'read_file',
  scopes: ['fs.read'],
  actionHash: 'b'.repeat(64),
  requestHash: 'e'.repeat(64),
  planHash: 'd'.repeat(64),
  authorizedAt: '2026-01-01T00:00:10.000Z',
});
assert.throws(
  () => guard.authorize('read_file', { path: '/safe/example.txt' }, { acsCapability: successEnvelope }),
  (error) => error.code === 'ACS_CAPABILITY_NONCE_REPLAY',
);

const sharedReplayDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-acs-replay-'));
try {
  const replayOptions = {
    mode: 'managed',
    runtimeId: 'runtime_01',
    publicKey: publicKeyDer.toString('base64url'),
    keyId: 'test-key-1',
    allowedScopes: FIXED_ACS_SCOPES,
    now: () => now,
    replayDirectory: sharedReplayDirectory,
  };
  const firstProcess = new ManagedAcsGuard(replayOptions);
  const secondProcess = new ManagedAcsGuard(replayOptions);
  for (const processGuard of [firstProcess, secondProcess]) {
    processGuard.initialize({
      acsRuntimeBootstrap: {
        schemaVersion: 1,
        runtimeId: 'runtime_01',
        challenge: bootstrapChallenge,
        scopes: FIXED_ACS_SCOPES,
      },
    });
  }
  const crossProcessEnvelope = sign(payload());
  firstProcess.authorize('read_file', { path: '/safe/example.txt' }, { acsCapability: crossProcessEnvelope });
  assert.throws(
    () => secondProcess.authorize('read_file', { path: '/safe/example.txt' }, { acsCapability: crossProcessEnvelope }),
    (error) => error.code === 'ACS_CAPABILITY_NONCE_REPLAY',
    'persisted runtime identity must share nonce consumption across processes and restarts',
  );

  fs.writeFileSync(path.join(sharedReplayDirectory, '.reserve.lock'), JSON.stringify({ pid: 2_147_483_647 }));
  const recoveredProcess = new ManagedAcsGuard(replayOptions);
  recoveredProcess.initialize({
    acsRuntimeBootstrap: {
      schemaVersion: 1,
      runtimeId: 'runtime_01',
      challenge: bootstrapChallenge,
      scopes: FIXED_ACS_SCOPES,
    },
  });
  assert.equal(
    recoveredProcess.authorize('read_file', { path: '/safe/example.txt' }, { acsCapability: sign(payload()) }).toolName,
    'read_file',
    'an orphaned reservation lock must recover without disabling the runtime',
  );
} finally {
  fs.rmSync(sharedReplayDirectory, { recursive: true, force: true });
}

const liveLockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-acs-live-lock-'));
try {
  fs.writeFileSync(
    path.join(liveLockDirectory, '.reserve.lock'),
    JSON.stringify({ pid: process.pid, createdAt: Date.now() - 60_000 }),
  );
  const liveLockGuard = new ManagedAcsGuard({
    mode: 'managed',
    runtimeId: 'runtime_01',
    publicKey: publicKeyDer.toString('base64url'),
    keyId: 'test-key-1',
    allowedScopes: FIXED_ACS_SCOPES,
    now: () => now,
    replayDirectory: liveLockDirectory,
  });
  liveLockGuard.initialize({
    acsRuntimeBootstrap: {
      schemaVersion: 1,
      runtimeId: 'runtime_01',
      challenge: bootstrapChallenge,
      scopes: FIXED_ACS_SCOPES,
    },
  });
  assert.throws(
    () => liveLockGuard.authorize('read_file', { path: '/safe/example.txt' }, { acsCapability: sign(payload()) }),
    (error) => error.code === 'ACS_CAPABILITY_NONCE_REPLAY',
    'a slow but live lock owner must never be evicted',
  );
} finally {
  fs.rmSync(liveLockDirectory, { recursive: true, force: true });
}

const rejectionCases = [
  ['ACS_CAPABILITY_MISSING', undefined],
  ['ACS_CAPABILITY_EXTRA_FIELD', { ...sign(payload()), alg: 'EdDSA' }],
  ['ACS_CAPABILITY_KEY_UNKNOWN', { ...sign(payload()), keyId: 'other-key' }],
  ['ACS_CAPABILITY_SIGNATURE_INVALID', { ...sign(payload()), signature: Buffer.alloc(64).toString('base64url') }],
  ['ACS_CAPABILITY_VERSION_INVALID', sign(payload({ version: 'acs.dc.v2' }))],
  ['ACS_CAPABILITY_ISSUER_INVALID', sign(payload({ issuer: 'other' }))],
  ['ACS_CAPABILITY_AUDIENCE_INVALID', sign(payload({ audience: 'other' }))],
  ['ACS_CAPABILITY_RUNTIME_MISMATCH', sign(payload({ runtimeId: 'runtime_02' }))],
  ['ACS_CAPABILITY_WORK_ITEM_MISMATCH', sign(payload({ workItemId: 'bad id' }))],
  ['ACS_CAPABILITY_ATTEMPT_MISMATCH', sign(payload({ attemptId: '' }))],
  ['ACS_CAPABILITY_LEASE_MISMATCH', sign(payload({ leaseId: 'bad/id' }))],
  ['ACS_CAPABILITY_EPOCH_MISMATCH', sign(payload({ leaseEpoch: -1 }))],
  ['ACS_CAPABILITY_TOOL_MISMATCH', sign(payload({ toolName: 'get_file_info' }))],
  ['ACS_CAPABILITY_ARGUMENTS_MISMATCH', sign(payload({ normalizedArguments: { path: '/other' } }))],
  ['ACS_CAPABILITY_INVOCATION_HASH_MISMATCH', sign(payload({ invocationHash: 'a'.repeat(64) }))],
  ['ACS_CAPABILITY_ACTION_HASH_MISMATCH', sign(payload({ actionHash: 'not-a-hash' }))],
  ['ACS_CAPABILITY_REQUEST_HASH_MISMATCH', sign(payload({ requestHash: 'not-a-hash' }))],
  ['ACS_CAPABILITY_PLAN_HASH_MISMATCH', sign(payload({ planHash: 'not-a-hash' }))],
  ['ACS_CAPABILITY_SCOPE_MISMATCH', sign(payload({ scopes: ['fs.write'] }))],
  ['ACS_CAPABILITY_APPROVAL_FORBIDDEN', sign(payload({ approvalId: 'approval_01' }))],
  ['ACS_CAPABILITY_TIME_INVALID', sign(payload({ expiresAt: '2026-01-01T00:00:45.000Z' }))],
  ['ACS_CAPABILITY_TIME_INVALID', sign(payload({ issuedAt: '2026-01-01T00:00:20Z' }))],
  ['ACS_CAPABILITY_NONCE_INVALID', sign(payload({ nonce: 'short' }))],
];
for (const [code, envelope] of rejectionCases) {
  assert.throws(
    () => guard.authorize('read_file', { path: '/safe/example.txt' }, envelope === undefined ? undefined : { acsCapability: envelope }),
    (error) => error instanceof ManagedAcsAuthorizationError && error.code === code,
    code,
  );
}

const writeArgs = { path: '/safe/example.txt', content: 'test' };
const writeBase = payload({
  toolName: 'write_file',
  normalizedArguments: writeArgs,
  invocationHash: computeDesktopCommanderInvocationHash('write_file', writeArgs),
  scopes: ['fs.write'],
});
assert.throws(
  () => guard.authorize('write_file', writeArgs, { acsCapability: sign(writeBase) }),
  (error) => error.code === 'ACS_CAPABILITY_APPROVAL_REQUIRED',
);
const approved = { ...writeBase, nonce: crypto.randomBytes(32).toString('base64url'), approvalId: 'approval_01' };
assert.equal(guard.authorize('write_file', writeArgs, { acsCapability: sign(approved) }).toolName, 'write_file');

const urlReadArguments = { path: 'https://example.invalid/file.txt', isUrl: true };
const urlRead = payload({
  normalizedArguments: urlReadArguments,
  invocationHash: computeDesktopCommanderInvocationHash('read_file', urlReadArguments),
});
assert.throws(
  () => guard.authorize('read_file', urlReadArguments, { acsCapability: sign(urlRead) }),
  (error) => error.code === 'ACS_CAPABILITY_SCOPE_MISMATCH',
  'fs.read capabilities must not authorize network reads',
);

const usagePayload = payload({
  toolName: 'get_usage_stats',
  normalizedArguments: {},
  invocationHash: computeDesktopCommanderInvocationHash('get_usage_stats', {}),
  scopes: ['process.exec'],
});
assert.equal(
  guard.authorize('get_usage_stats', {}, { acsCapability: sign(usagePayload) }).toolName,
  'get_usage_stats',
);

guard.revoke();
assert.throws(
  () => guard.initialize({
    acsRuntimeBootstrap: {
      schemaVersion: 1,
      runtimeId: 'runtime_01',
      challenge: bootstrapChallenge,
      scopes: FIXED_ACS_SCOPES,
    },
  }),
  (error) => error.code === 'ACS_RUNTIME_IDENTITY_REVOKED',
  'revocation must be terminal for the session',
);
assert.throws(
  () => guard.authorize('read_file', { path: '/safe/example.txt' }, { acsCapability: sign(payload()) }),
  (error) => error.code === 'ACS_RUNTIME_IDENTITY_REVOKED',
);

const standalone = new ManagedAcsGuard({ mode: 'standalone', runtimeId: 'runtime_01' });
assert.equal(standalone.authorize('write_file', writeArgs, undefined), undefined);

console.log('managed ACS capability canonicalization, verification, replay, scope, approval, and identity tests passed');
