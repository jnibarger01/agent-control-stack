/**
 * acs.dc.v1 authorizationArguments + managed tool-policy coverage contract.
 *
 * Invariant: the exact normalized arguments ACS binds into a capability are
 * the exact arguments Desktop Commander verifies for the delivered request.
 *
 * 1. Fixture pins (byte-identical copies of the ACS contracts in
 *    agent-control-stack/contracts/desktop-commander/).
 * 2. DC authorizationArguments over every fixture case.
 * 3. ManagedAcsGuard accepts every fixture delivery and rejects every drift.
 * 4. Coverage: every registered DC tool has an explicit managed disposition
 *    that matches ACS's.
 * 5. Cross-component chain (when ACS_REPO and GATEWAY_REPO point at checkouts
 *    with built ACS dist): ACS normalizeInvocation + ACS signing ->
 *    gateway deliveredArguments -> DC ManagedAcsGuard.authorize.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DC_TRANSPORT_METADATA_ARGUMENT_KEYS,
  FIXED_ACS_SCOPES,
  ManagedAcsAuthorizationError,
  ManagedAcsGuard,
  authorizationArguments,
  computeDesktopCommanderInvocationHash,
  listManagedAcsToolPolicies,
  listManagedToolDispositions,
  strictCanonicalJsonV1,
} from '../dist/managed-acs.js';
import { toolArgSchemas } from '../dist/tools/schemas.js';

const FIXTURE_SHA256 = {
  'acs-authorization-arguments.v1.json': '93c53ca91cb10f143d035657fed7fbf8e74794256882e189b8e48ee225fd5662',
  'acs-managed-tool-coverage.v1.json': 'da871f5b9a5da9b50b0aa25924a0f46a7dc303610c519f8e8db81cf20fefb6a8',
};
const fixtureBytes = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
for (const [name, sha] of Object.entries(FIXTURE_SHA256)) {
  assert.equal(crypto.createHash('sha256').update(fixtureBytes(name)).digest('hex'), sha,
    `${name} drifted from the pinned ACS contract; update both repositories together`);
}
const contract = JSON.parse(fixtureBytes('acs-authorization-arguments.v1.json'));
const coverage = JSON.parse(fixtureBytes('acs-managed-tool-coverage.v1.json'));

// ---- deterministic test signing key (same vector as test-managed-acs.js) ----
const rawPublicKey = Buffer.from('11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo', 'base64url');
const publicKeyDer = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawPublicKey]);
const privateKeyDer = Buffer.concat([
  Buffer.from('302e020100300506032b657004220420', 'hex'),
  Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'),
]);
const privateKey = crypto.createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' });

function makeGuard() {
  const guard = new ManagedAcsGuard({
    mode: 'managed',
    runtimeId: 'runtime_01',
    publicKey: publicKeyDer.toString('base64url'),
    keyId: 'test-key-1',
    allowedScopes: FIXED_ACS_SCOPES,
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

function capabilityPayload(toolName, normalizedArguments, invocationHash = computeDesktopCommanderInvocationHash(toolName, normalizedArguments)) {
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
    leaseEpoch: 1,
    toolName,
    normalizedArguments,
    invocationHash,
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

function sign(payload) {
  return {
    payload,
    keyId: 'test-key-1',
    signature: crypto.sign(null, Buffer.from(strictCanonicalJsonV1(payload)), privateKey).toString('base64url'),
  };
}

const isMismatch = (error) => error instanceof ManagedAcsAuthorizationError && error.code === 'ACS_CAPABILITY_ARGUMENTS_MISMATCH';

// Placeholder substitution for the DC-only checks: DC never resolves paths or
// executables, so any concrete stand-in exercises the same comparison.
function substituteWith(root, bin) {
  const sub = (value) => {
    if (typeof value === 'string') return value.replaceAll('${ROOT}', root).replace(/\$\{BIN:([a-z0-9]+)\}/g, (_, name) => bin(name));
    if (Array.isArray(value)) return value.map(sub);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sub(v)]));
    return value;
  };
  return sub;
}
const dcSub = substituteWith('/fixture-root', (name) => `/usr/bin/${name}`);

// ---- 1/2. contract semantics --------------------------------------------------
assert.deepEqual([...DC_TRANSPORT_METADATA_ARGUMENT_KEYS], contract.transportMetadataKeys);
for (const [key, values] of Object.entries(contract.transportMetadataValues)) {
  for (const value of values) assert.deepEqual(authorizationArguments({ [key]: value }), {});
}
assert.throws(() => authorizationArguments([]), /plain object/);
assert.throws(() => authorizationArguments(null), /plain object/);
assert.deepEqual(authorizationArguments({ a: 1, b: undefined }), { a: 1 }, 'undefined is absent');
assert.deepEqual(authorizationArguments({ a: null }), { a: null }, 'null is a value, not absent');

for (const testCase of contract.cases) {
  const delivered = dcSub(testCase.delivered);
  const expected = dcSub(testCase.authorizationArguments);
  assert.equal(strictCanonicalJsonV1(authorizationArguments(delivered)), strictCanonicalJsonV1(expected), testCase.name);
}

// ---- 3. guard accepts fixture deliveries, rejects drift ------------------------
{
  const guard = makeGuard();
  for (const testCase of contract.cases) {
    const bound = dcSub(testCase.authorizationArguments);
    const envelope = sign(capabilityPayload(testCase.tool, bound));
    const auth = guard.authorize(testCase.tool, dcSub(testCase.delivered), { acsCapability: envelope });
    assert.equal(auth.toolName, testCase.tool, testCase.name);
  }
  for (const drift of contract.driftRejectedByDc) {
    const envelope = sign(capabilityPayload(drift.tool, dcSub(drift.bound)));
    assert.throws(() => guard.authorize(drift.tool, dcSub(drift.delivered), { acsCapability: envelope }), isMismatch, drift.name);
  }
}

// ---- 4. managed tool-policy coverage ------------------------------------------
{
  const registered = Object.keys(toolArgSchemas).sort();
  const dispositions = listManagedToolDispositions();
  const policies = listManagedAcsToolPolicies();
  assert.deepEqual(Object.keys(dispositions).sort(), registered,
    'every registered Desktop Commander tool needs an explicit managed disposition (src/managed-acs.ts)');
  assert.deepEqual(Object.keys(coverage.tools).sort(), registered,
    'the ACS coverage contract must list exactly the registered Desktop Commander tools');
  for (const name of registered) {
    const pinned = coverage.tools[name];
    assert.deepEqual({ toolClass: dispositions[name].toolClass, managed: dispositions[name].managed },
      { toolClass: pinned.toolClass, managed: pinned.managed }, name);
    if (pinned.managed === 'capability') {
      assert.ok(policies[name], `${name} must have a managed capability policy`);
      assert.deepEqual([...policies[name].scopes], pinned.scopes, `${name} scopes`);
      assert.equal(policies[name].requiresApproval, pinned.requiresApproval, `${name} approval`);
    } else {
      assert.equal(policies[name], undefined, `${name} is unsupported in managed mode and must not have a policy`);
    }
  }
  assert.deepEqual(Object.keys(policies).sort(), registered.filter((n) => coverage.tools[n].managed === 'capability'));
}

// ---- 5. cross-component chain -------------------------------------------------
const acsRepo = process.env.ACS_REPO;
const gatewayRepo = process.env.GATEWAY_REPO;
if (!acsRepo || !gatewayRepo) {
  console.log('SKIP cross-component chain: set ACS_REPO and GATEWAY_REPO (ACS dist must be built)');
} else {
  const acsContract = fs.readFileSync(path.join(acsRepo, 'contracts/desktop-commander/authorization-arguments.v1.json'));
  assert.ok(acsContract.equals(fixtureBytes('acs-authorization-arguments.v1.json')), 'ACS contract bytes differ from DC pin');
  assert.ok(fs.readFileSync(path.join(acsRepo, 'contracts/desktop-commander/managed-tool-coverage.v1.json'))
    .equals(fixtureBytes('acs-managed-tool-coverage.v1.json')), 'ACS coverage bytes differ from DC pin');
  const gwContract = fs.readFileSync(path.join(gatewayRepo, 'test/fixtures/acs-authorization-arguments.v1.json'));
  assert.ok(gwContract.equals(acsContract), 'gateway contract bytes differ from ACS');

  const acs = await import(pathToFileURL(path.join(acsRepo, 'packages/desktop-commander-adapter/dist/index.js')).href);
  const gateway = await import(pathToFileURL(path.join(gatewayRepo, 'managed.js')).href);
  assert.deepEqual([...acs.DC_TRANSPORT_METADATA_ARGUMENT_KEYS], [...DC_TRANSPORT_METADATA_ARGUMENT_KEYS]);
  assert.deepEqual([...gateway.DC_TRANSPORT_METADATA_ARGUMENT_KEYS], [...DC_TRANSPORT_METADATA_ARGUMENT_KEYS]);

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-acs-chain-')));
  try {
    for (const dir of contract.fixtureFilesystem.directories) fs.mkdirSync(path.join(root, dir), { recursive: true });
    for (const [link, target] of Object.entries(contract.fixtureFilesystem.symlinks)) fs.symlinkSync(path.join(root, target), path.join(root, link));
    const containment = { allowedRoots: [root], deniedRoots: [] };
    const realSub = substituteWith(root, () => { throw new Error('raw inputs never contain ${BIN}'); });
    const guard = makeGuard();
    const acsSigning = { keyId: 'test-key-1', privateKey: privateKeyDer.toString('base64url') };

    for (const testCase of contract.cases) {
      const raw = realSub(testCase.raw);
      // (1) ACS normalization / capability issuance representation.
      const invocation = acs.normalizeInvocation(testCase.tool, raw, containment);
      const bound = invocation.validatedArguments;
      const acsInvocationHash = acs.desktopCommanderInvocationFingerprint(invocation);
      assert.equal(computeDesktopCommanderInvocationHash(testCase.tool, bound), acsInvocationHash, `${testCase.name}: invocation hash construction`);
      assert.deepEqual(acs.desktopCommanderRequiredScopes(testCase.tool), [...listManagedAcsToolPolicies()[testCase.tool].scopes]);
      const payload = capabilityPayload(testCase.tool, bound, acsInvocationHash);
      const envelope = acs.signPreparedDesktopCommanderCapability(payload, acsSigning);
      // (2) gateway delivery of the issued capability.
      const delivered = gateway.deliveredArguments(envelope.payload.normalizedArguments, raw);
      // (3) DC managed guard normalization: deep structural equality with the binding.
      assert.equal(strictCanonicalJsonV1(authorizationArguments(delivered)), strictCanonicalJsonV1(bound), testCase.name);
      const auth = guard.authorize(testCase.tool, delivered, { acsCapability: envelope });
      assert.equal(auth.toolName, testCase.tool);
      // Pre-fix behaviour (raw client arguments delivered) must still fail closed
      // whenever ACS's semantic normalization changed anything.
      if (strictCanonicalJsonV1(authorizationArguments(raw)) !== strictCanonicalJsonV1(bound)) {
        const again = acs.signPreparedDesktopCommanderCapability(capabilityPayload(testCase.tool, bound, acsInvocationHash), acsSigning);
        assert.throws(() => guard.authorize(testCase.tool, raw, { acsCapability: again }), isMismatch, `${testCase.name}: raw delivery must mismatch`);
      }
    }
    // The observed P0-3 failure, reproduced and fixed end to end.
    const spRaw = { command: 'git status', cwd: path.join(root, 'real'), timeout_ms: 5000, origin: 'llm' };
    const spBound = acs.normalizeInvocation('start_process', spRaw, containment).validatedArguments;
    assert.notEqual(spBound.command, 'git status', 'ACS binds the fixed-dir executable');
    assert.equal(spBound.command.endsWith('/git status'), true);
    console.log('PASS cross-component chain (ACS normalize+sign -> gateway deliver -> DC guard)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log('PASS managed authorization contract');
