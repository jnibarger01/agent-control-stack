#!/usr/bin/env node
/**
 * ACS-issued acs.dc.v1 capability verification (fail-closed) tests.
 *
 * Trust chain under test: ACS mints { payload, signature, keyId } where
 * signature = base64url(Ed25519.sign(null, strictCanonicalJsonV1(payload))).
 * DC verifies under DC_ACS_CAPABILITY_PUBLIC_KEY (base64url SPKI) with an
 * optional DC_ACS_CAPABILITY_KEY_ID pin. A presented _meta.capability that
 * fails ANY check is rejected regardless of DC_ENFORCEMENT; env unset keeps
 * the existing HMAC LocalCapabilityIssuer path byte-for-byte.
 *
 * Cases:
 *   A — env unset: fake ACS-shaped capability follows the EXISTING HMAC path
 *       (rejected with an HMAC code, NOT an ACS_CAPABILITY_* code).
 *   B — env set + valid envelope: accepted, acsCapability attestation present,
 *       works with DC_ENFORCEMENT=off (fail closed runs anyway).
 *   C — mutated signature -> ACS_CAPABILITY_INVALID_SIGNATURE.
 *   D — wrong key (different keypair) -> ACS_CAPABILITY_INVALID_SIGNATURE.
 *   E — pinned keyId mismatch -> ACS_CAPABILITY_INVALID_SIGNATURE.
 *   F — expired capability -> ACS_CAPABILITY_EXPIRED (also TTL > 30s).
 *   G — tool mismatch (request targets a different tool) -> TOOL_MISMATCH.
 *   H — scopes missing the tool's required scope -> TOOL_MISMATCH.
 *   I — tampered args -> ACS_CAPABILITY_ARGS_MISMATCH (structural + hash).
 *   J — malformed envelope (bad version / nonce / hashes) -> MALFORMED.
 *   K — audit: allowed request attests with capabilityId/workItemId/attemptId.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Redirect the audit chain BEFORE importing dist modules (audit-chain reads
// DC_AUDIT_DIR at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-acs-cap-'));
process.env.DC_AUDIT_DIR = path.join(tmp, 'audit');
process.env.DC_ENFORCEMENT = 'off'; // ACS verification must run anyway (fail closed)

const {
  preExecuteEnforcement, verifyAcsCapability, attestRequest, requestHash,
  extractCapability,
} = await import('../dist/enforcement/pipeline.js');
const { strictCanonicalJsonV1, computeDesktopCommanderInvocationHash } = await import('../dist/managed-acs.js');
const { AuditChain, verifyChain } = await import('../dist/audit/audit-chain.js');

// --- ACS-side signing replication (packages/desktop-commander-adapter) ------

function makeKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' });
  const publicDer = publicKey.export({ format: 'der', type: 'spki' });
  return {
    privateBase64url: Buffer.from(privateDer).toString('base64url'),
    publicBase64url: Buffer.from(publicDer).toString('base64url'),
    publicKey,
    privateKey,
  };
}

// ACS-side invocationHash: sha256(`${domain}\n${canonicalJson({toolName, arguments})}`)
// (shared hash.ts domainHash; canonicalJson recursively sorts keys and drops
// undefined — replicate that normalization exactly).
function canonicalJsonAcs(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonAcs);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonicalJsonAcs(v)]),
    );
  }
  return value;
}
function acsInvocationHash(toolName, args) {
  const canonical = JSON.stringify(canonicalJsonAcs({ toolName, arguments: args }));
  return crypto.createHash('sha256').update(`acs:desktop-commander-invocation:v1\n${canonical}`, 'utf8').digest('hex');
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function buildEnvelope(opts = {}) {
  const args = opts.args ?? { path: '/tmp/x.txt' };
  const toolName = opts.toolName ?? 'read_file';
  const issuedAt = new Date(opts.issuedAtMs ?? Date.now() - 1000);
  const expiresAt = new Date(issuedAt.getTime() + (opts.ttlMs ?? 29_000));
  const payload = {
    version: 'acs.dc.v1',
    issuer: 'acs',
    audience: 'desktop-commander',
    runtimeId: 'rt-test-1',
    workItemId: 'wi-test-1',
    attemptId: 'at-test-1',
    leaseId: 'le-test-1',
    leaseEpoch: 3,
    toolName,
    normalizedArguments: args,
    invocationHash: opts.invocationHash ?? acsInvocationHash(toolName, args),
    actionHash: sha256Hex('action'),
    requestHash: sha256Hex('request'),
    planHash: sha256Hex('plan'),
    scopes: opts.scopes ?? ['fs.read'],
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    nonce: crypto.randomBytes(32).toString('base64url'),
  };
  if (opts.payloadOverrides) Object.assign(payload, opts.payloadOverrides);
  const signature = opts.signature ?? crypto.sign(null, Buffer.from(strictCanonicalJsonV1(payload), 'utf8'), keys.privateKey);
  return {
    payload,
    signature: Buffer.from(signature).toString('base64url'),
    keyId: opts.keyId ?? 'acs-test-key',
  };
}

const keys = makeKeyPair();
const otherKeys = makeKeyPair();

const REQ = { tool: 'read_file', args: { path: '/tmp/x.txt' } };

async function gateWith(env, envelope, overrides = {}) {
  for (const k of ['DC_ACS_CAPABILITY_PUBLIC_KEY', 'DC_ACS_CAPABILITY_KEY_ID']) delete process.env[k];
  Object.assign(process.env, env);
  const meta = { agent: 'acs-agent', ...(envelope === undefined ? {} : { capability: envelope }) };
  return preExecuteEnforcement({ ...REQ, ...overrides, meta });
}

async function testEnvUnsetHmacPathUnchanged() {
  // Env unset + no capability: normal request allowed, unchanged.
  const gate = await gateWith({}, undefined);
  assert.equal(gate.allowed, true, 'env unset: local path still allows a normal request');
  assert.equal(gate.acsCapability, undefined, 'env unset: no ACS attestation');
  // verifyAcsCapability is a pure verifier — it needs the key env configured.
  assert.equal(verifyAcsCapability(buildEnvelope(), { tool: 'read_file', args: { path: '/tmp/x.txt' } }).ok, false,
    'env unset: pure verifier has no key configured, so verification fails closed');
  process.env.DC_ACS_CAPABILITY_PUBLIC_KEY = keys.publicBase64url;
  assert.equal(verifyAcsCapability(buildEnvelope(), { tool: 'read_file', args: { path: '/tmp/x.txt' } }).ok, true);
  delete process.env.DC_ACS_CAPABILITY_PUBLIC_KEY;
  // A request presenting _meta.capability in env-unset mode must follow the
  // EXISTING HMAC path: an invalid capability is judged by verifyCapability
  // (HMAC codes), never by ACS_CAPABILITY_* codes.
  process.env.DC_ENFORCEMENT = 'full';
  const hmacGate = await preExecuteEnforcement({
    tool: 'read_file', args: { path: '/tmp/x.txt' },
    meta: { capability: { ...buildEnvelope().payload, capabilityId: 'cap-x', signature: 'not-a-real-hmac' } },
  });
  assert.equal(hmacGate.allowed, false);
  assert.ok(!String(hmacGate.code).startsWith('ACS_CAPABILITY_'), `env unset: got HMAC-path code ${hmacGate.code}`);
  process.env.DC_ENFORCEMENT = 'off';
}

async function testValidAcceptedEvenWithEnforcementOff() {
  const missing = await gateWith({ DC_ACS_CAPABILITY_PUBLIC_KEY: keys.publicBase64url }, undefined);
  assert.equal(missing.allowed, false, 'ACS mode must fail closed when _meta.capability is missing');
  assert.equal(missing.allowed === false && missing.code, 'ACS_CAPABILITY_MALFORMED');

  const gate = await gateWith({ DC_ACS_CAPABILITY_PUBLIC_KEY: keys.publicBase64url }, buildEnvelope());
  assert.equal(gate.allowed, true, 'valid ACS capability accepted with DC_ENFORCEMENT=off');
  assert.ok(gate.acsCapability, 'pass carries acsCapability attestation');
  assert.equal(gate.acsCapability.workItemId, 'wi-test-1');
  assert.equal(gate.acsCapability.attemptId, 'at-test-1');
  assert.equal(gate.acsCapability.leaseId, 'le-test-1');
  assert.equal(gate.acsCapability.leaseEpoch, 3);
  assert.ok(gate.acsCapability.capabilityId.startsWith('acs.dc.v1:'));
}

async function testDirectVerifierResults() {
  const env = { DC_ACS_CAPABILITY_PUBLIC_KEY: keys.publicBase64url };
  const verify = (envelope, overrides = {}) => {
    for (const k of ['DC_ACS_CAPABILITY_PUBLIC_KEY', 'DC_ACS_CAPABILITY_KEY_ID']) delete process.env[k];
    Object.assign(process.env, env, overrides.env ?? {});
    return verifyAcsCapability(envelope, { tool: overrides.tool ?? 'read_file', args: overrides.args ?? { path: '/tmp/x.txt' }, now: overrides.now });
  };

  // C — mutated signature.
  const tamperedSig = buildEnvelope();
  const sigBuf = Buffer.from(tamperedSig.signature, 'base64url');
  sigBuf[0] ^= 0xff;
  tamperedSig.signature = sigBuf.toString('base64url');
  assert.equal(verify(tamperedSig).code, 'ACS_CAPABILITY_INVALID_SIGNATURE');

  // D — signed by a DIFFERENT key.
  const wrongKey = buildEnvelope({ signature: undefined, payloadOverrides: {} });
  wrongKey.signature = crypto.sign(null, Buffer.from(strictCanonicalJsonV1(wrongKey.payload), 'utf8'), otherKeys.privateKey).toString('base64url');
  assert.equal(verify(wrongKey).code, 'ACS_CAPABILITY_INVALID_SIGNATURE');

  // E — pinned keyId mismatch.
  assert.equal(verify(buildEnvelope(), { env: { DC_ACS_CAPABILITY_KEY_ID: 'some-other-key' } }).code, 'ACS_CAPABILITY_INVALID_SIGNATURE');
  // ...but the pinned key matching is accepted.
  assert.equal(verify(buildEnvelope(), { env: { DC_ACS_CAPABILITY_KEY_ID: 'acs-test-key' } }).ok, true);

  // F — expired.
  const expired = buildEnvelope({ issuedAtMs: Date.now() - 60_000, ttlMs: 10_000 });
  assert.equal(verify(expired).code, 'ACS_CAPABILITY_EXPIRED');
  // ...and TTL over the 30s protocol ceiling.
  const longTtl = buildEnvelope({ ttlMs: 60_000 });
  assert.equal(verify(longTtl).code, 'ACS_CAPABILITY_EXPIRED');

  // G — tool mismatch (capability for write_file, request is read_file).
  const otherTool = buildEnvelope({ toolName: 'write_file', scopes: ['fs.write'] });
  assert.equal(verify(otherTool).code, 'ACS_CAPABILITY_TOOL_MISMATCH');

  // H — scopes missing the tool's required scope.
  const badScope = buildEnvelope({ scopes: ['process.exec'] });
  assert.equal(verify(badScope).code, 'ACS_CAPABILITY_TOOL_MISMATCH');

  // I — tampered args (structural + hash must both bind).
  const tamperedArgs = buildEnvelope();
  assert.equal(verify(tamperedArgs, { args: { path: '/etc/shadow' } }).code, 'ACS_CAPABILITY_ARGS_MISMATCH');
  const staleHash = buildEnvelope({ invocationHash: sha256Hex('not-the-invocation') });
  assert.equal(verify(staleHash).code, 'ACS_CAPABILITY_ARGS_MISMATCH');

  // J — malformed: bad version, bad nonce, bad hash, wrong issuer.
  assert.equal(verify(buildEnvelope({ payloadOverrides: { version: 'acs.dc.v2' } })).code, 'ACS_CAPABILITY_MALFORMED');
  assert.equal(verify(buildEnvelope({ payloadOverrides: { issuer: 'forge' } })).code, 'ACS_CAPABILITY_MALFORMED');
  assert.equal(verify(buildEnvelope({ payloadOverrides: { nonce: 'short' } })).code, 'ACS_CAPABILITY_MALFORMED');
  assert.equal(verify(buildEnvelope({ payloadOverrides: { planHash: 'zz' } })).code, 'ACS_CAPABILITY_MALFORMED');
  assert.equal(verify('not-an-envelope').code, 'ACS_CAPABILITY_MALFORMED');
}

async function testAuditAttestation() {
  const chain = new AuditChain();
  const envelope = buildEnvelope();
  process.env.DC_ACS_CAPABILITY_PUBLIC_KEY = keys.publicBase64url;
  const check = verifyAcsCapability(envelope, { tool: 'read_file', args: { path: '/tmp/x.txt' } });
  delete process.env.DC_ACS_CAPABILITY_PUBLIC_KEY;
  assert.equal(check.ok, true);
  const reqHashVal = requestHash('read_file', { path: '/tmp/x.txt' });
  assert.equal(attestRequest({
    requestHash: reqHashVal, tool: 'read_file', agent: 'acs-agent', transport: 'mcp->local',
    capabilityId: check.attestation.capabilityId,
    workItemId: check.attestation.workItemId,
    attemptId: check.attestation.attemptId,
    args: { path: '/tmp/x.txt' },
  }), true, 'attest succeeds');
  const events = chain.read().events;
  const found = events.find((e) => e.capabilityId === check.attestation.capabilityId);
  assert.ok(found, 'audit event carries the ACS capabilityId');
  assert.equal(found.workItemId, 'wi-test-1');
  assert.equal(found.attemptId, 'at-test-1');
  // Chain (including the additive fields) still verifies end-to-end.
  assert.equal(verifyChain(chain.path).valid, true, 'chain with additive ACS fields verifies');
}

async function testEnforcementOnAlsoFailsClosed() {
  // Valid capability + enforcement ON: accepted without an approval prompt
  // (the capability is the authorization).
  process.env.DC_ENFORCEMENT = 'full';
  const gate = await gateWith({ DC_ACS_CAPABILITY_PUBLIC_KEY: keys.publicBase64url }, buildEnvelope());
  assert.equal(gate.allowed, true, 'valid ACS capability accepted with enforcement on');
  assert.ok(gate.acsCapability);
  // A write (approval-class) tool authorized by capability: no APPROVAL_REQUIRED.
  const writeEnvelope = buildEnvelope({ toolName: 'write_file', args: { path: '/tmp/y.txt', content: 'hi' }, scopes: ['fs.write'] });
  const writeGate = await gateWith(
    { DC_ACS_CAPABILITY_PUBLIC_KEY: keys.publicBase64url },
    writeEnvelope,
    { tool: 'write_file', args: { path: '/tmp/y.txt', content: 'hi' } },
  );
  assert.equal(writeGate.allowed, true, 'ACS capability authorizes an approval-class tool without prompting');
  assert.ok(writeGate.acsCapability);
  // Invalid capability + enforcement ON: rejected with the specific code.
  const bad = buildEnvelope({ ttlMs: 60_000 });
  const blocked = await gateWith({ DC_ACS_CAPABILITY_PUBLIC_KEY: keys.publicBase64url }, bad);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.code, 'ACS_CAPABILITY_EXPIRED');
  process.env.DC_ENFORCEMENT = 'off';
}

async function testGatewayAcsRequiresAttribution() {
  const previous = process.env.DC_GATEWAY_ATTESTATION_KEY;
  process.env.DC_GATEWAY_ATTESTATION_KEY = 'isolated-gateway-test-key';
  process.env.DC_ACS_CAPABILITY_PUBLIC_KEY = keys.publicBase64url;
  try {
    for (const gateway of [undefined, null, 'malformed', {}, { verified: true }]) {
      const result = await preExecuteEnforcement({ ...REQ,
        meta: { capability: buildEnvelope(), ...(gateway === undefined ? {} : { gateway }) } });
      assert.equal(result.allowed, false, 'ACS gateway execution requires authenticated attribution');
      assert.equal(result.code, 'GATEWAY_ATTESTATION_INVALID');
    }
    const gateway = { verified: true, sub: 'test-subject', client_id: 'test-client', jti: 'test-jti', iat: Date.now() };
    gateway.sig = crypto.createHmac('sha256', process.env.DC_GATEWAY_ATTESTATION_KEY)
      .update(`${gateway.sub}.${gateway.client_id}.${gateway.jti}.${gateway.iat}`).digest('base64url');
    const allowed = await preExecuteEnforcement({ ...REQ,
      meta: { capability: buildEnvelope(), gateway } });
    assert.equal(allowed.allowed, true, 'valid ACS capability plus signed gateway attribution is accepted');
    assert.equal(allowed.gatewayTrusted, true);
  } finally {
    if (previous === undefined) delete process.env.DC_GATEWAY_ATTESTATION_KEY;
    else process.env.DC_GATEWAY_ATTESTATION_KEY = previous;
  }
}

const tests = [
  testGatewayAcsRequiresAttribution,
  testEnvUnsetHmacPathUnchanged,
  testValidAcceptedEvenWithEnforcementOff,
  testDirectVerifierResults,
  testAuditAttestation,
  testEnforcementOnAlsoFailsClosed,
];
for (const test of tests) {
  await test();
  console.log(`ok - ${test.name}`);
}
console.log('All ACS capability verification tests passed.');
