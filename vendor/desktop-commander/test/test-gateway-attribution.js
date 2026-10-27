#!/usr/bin/env node
/**
 * Trusted gateway transport attribution tests (Ed25519).
 *
 * Trust chain under test: the bridge verifies the OAuth caller, then signs
 *   _meta.gateway = { sig: base64url(Ed25519.sign(BRIDGE_PRIVATE, `${sub}.${client_id}.${jti}.${iat}`)),
 *                     sub, client_id, jti, iat, verified: true }
 * DC verifies sig with the bridge's PUBLIC key only (DC_GATEWAY_ATTESTATION_PUBLIC_KEY),
 * requires iat within 10 minutes and a non-empty jti. DC holds no signing key and no shared
 * secret, so a process that can read DC's environment cannot mint gateway identity.
 * A client-set verified:true boolean alone is NEVER trusted.
 *
 * Cases:
 *   A — env unset: old behavior (spoofed _meta.agent accepted for attribution; fake verified:true causes NO rejection).
 *   B — env set + valid Ed25519 signature: trusted; gateway sub/client_id recorded as gatewayActor.
 *   C — env set + fake verified:true (no sig): rejected GATEWAY_ATTESTATION_INVALID.
 *   D — env set + tampered sub: rejected.
 *   E — env set + signature by a DIFFERENT key: rejected.
 *   F — env set + stale iat (>10 min): rejected.
 *   G — env set + no gateway meta: allowed, unchanged local behavior.
 *   H — the RETIRED shared HMAC secret, in any form, is never trusted (an HMAC sig made with it, or with the public PEM).
 *   I — a configured but unparseable public key fails closed for gateway-bearing requests.
 *   J — the audit chain with a gatewayActor event still verifies end-to-end.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Redirect the audit chain BEFORE importing dist modules (audit-chain reads DC_AUDIT_DIR at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-gateway-attr-'));
process.env.DC_AUDIT_DIR = path.join(tmp, 'audit');
process.env.DC_ENFORCEMENT = 'off'; // keep other gates out of scope here

const { preExecuteEnforcement, isTrustedGatewayMeta, gatewayActorFromMeta, GATEWAY_TRANSPORT_VERIFIED, attestRequest } = await import('../dist/enforcement/pipeline.js');
const { AuditChain, verifyChain } = await import('../dist/audit/audit-chain.js');

const bridge = crypto.generateKeyPairSync('ed25519');
const other = crypto.generateKeyPairSync('ed25519');
const PUBLIC_PEM = bridge.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const RETIRED_SECRET = 'retired-shared-secret-must-never-be-trusted';
const now = Date.now();

function material(gw) {
  return Buffer.from(`${gw.sub}.${gw.client_id}.${gw.jti}.${gw.iat}`, 'utf8');
}
function signedBy(privateKey, gw) {
  return crypto.sign(null, material(gw), privateKey).toString('base64url');
}
function gatewayMeta(overrides = {}) {
  const gw = { sub: 'user-abc', client_id: 'client-123', jti: 'jti-1', iat: now, verified: true, ...overrides };
  if (gw.sig === undefined) gw.sig = signedBy(bridge.privateKey, gw);
  return { agent: 'spoofed-agent', remote: true, gateway: gw };
}

const REQ = { tool: 'read_file', args: { path: '/tmp/x.txt' } };

function setPublicKey(pem) {
  if (pem === undefined) delete process.env.DC_GATEWAY_ATTESTATION_PUBLIC_KEY;
  else process.env.DC_GATEWAY_ATTESTATION_PUBLIC_KEY = pem;
}

async function testEnvUnsetOldBehavior() {
  setPublicKey(undefined);
  delete process.env.DC_GATEWAY_ATTESTATION_KEY;
  assert.equal(isTrustedGatewayMeta({ agent: 'x', gateway: { verified: true, sub: 'x', client_id: 'y', jti: 'z', iat: now, sig: 'garbage' } }), false,
    'env unset: nothing is trusted-gateway');
  const gate = await preExecuteEnforcement({ ...REQ, meta: gatewayMeta(), now });
  assert.equal(gate.allowed, true, 'env unset: fake verified:true must not be rejected');
  assert.equal(gate.gatewayTrusted, undefined);
}

async function testEnvSetTrusted() {
  setPublicKey(PUBLIC_PEM);
  const meta = gatewayMeta();
  assert.equal(isTrustedGatewayMeta(meta, now), true, 'valid bridge Ed25519 signature must be trusted');
  const gate = await preExecuteEnforcement({ ...REQ, meta, now });
  assert.equal(gate.allowed, true);
  assert.equal(gate.gatewayTrusted, true);
  assert.deepEqual(gate.gatewayActor, { sub: 'user-abc', client_id: 'client-123' });
  assert.equal(GATEWAY_TRANSPORT_VERIFIED, 'oauth-gateway->mcp (verified)');
  assert.equal(isTrustedGatewayMeta(meta, now + 5 * 60 * 1000), true, 'within 10 min window: trusted');
  assert.equal(isTrustedGatewayMeta(meta, now + 11 * 60 * 1000), false, 'beyond 10 min window: untrusted');
  assert.equal(gatewayActorFromMeta(meta).sub, 'user-abc');
  const audit = attestRequest({ requestHash: 'hash-b', tool: 'read_file', agent: 'spoofed-agent', transport: GATEWAY_TRANSPORT_VERIFIED, gatewayActor: { sub: 'user-abc', client_id: 'client-123' }, args: { path: '/tmp/x.txt' } });
  assert.equal(audit, true);
}

async function testFakeVerifiedRejected() {
  setPublicKey(PUBLIC_PEM);
  const fake = gatewayMeta();
  delete fake.gateway.sig;
  assert.equal(isTrustedGatewayMeta(fake, now), false, 'verified:true without sig is NOT trusted');
  const gate = await preExecuteEnforcement({ ...REQ, meta: fake, now });
  assert.equal(gate.allowed, false);
  assert.equal(gate.code, 'GATEWAY_ATTESTATION_INVALID');
  const tampered = gatewayMeta({ sub: 'user-abc' });
  tampered.gateway.sub = 'admin';
  const gate2 = await preExecuteEnforcement({ ...REQ, meta: tampered, now });
  assert.equal(gate2.code, 'GATEWAY_ATTESTATION_INVALID', 'tampered sub must fail');
  const noJti = gatewayMeta({ jti: '' });
  const gate3 = await preExecuteEnforcement({ ...REQ, meta: noJti, now });
  assert.equal(gate3.code, 'GATEWAY_ATTESTATION_INVALID', 'empty jti must fail');
}

async function testWrongSignerRejected() {
  setPublicKey(PUBLIC_PEM);
  const gw = { sub: 'u', client_id: 'c', jti: 'j', iat: now, verified: true };
  const forged = { ...gw, sig: signedBy(other.privateKey, gw) };
  assert.equal(isTrustedGatewayMeta({ gateway: forged }, now), false, 'signature by a different key must be untrusted');
  const gate = await preExecuteEnforcement({ ...REQ, meta: { gateway: forged }, now });
  assert.equal(gate.code, 'GATEWAY_ATTESTATION_INVALID');
}

async function testStaleIatRejected() {
  setPublicKey(PUBLIC_PEM);
  const gw = { sub: 'u', client_id: 'c', jti: 'j', iat: now - 11 * 60 * 1000, verified: true };
  const stale = { ...gw, sig: signedBy(bridge.privateKey, gw) };
  assert.equal(isTrustedGatewayMeta({ gateway: stale }, now), false, 'stale iat must be untrusted');
  const gate = await preExecuteEnforcement({ ...REQ, meta: { gateway: stale }, now });
  assert.equal(gate.code, 'GATEWAY_ATTESTATION_INVALID');
}

async function testNoGatewayMetaUnchanged() {
  setPublicKey(PUBLIC_PEM);
  const gate = await preExecuteEnforcement({ ...REQ, meta: { agent: 'local' }, now });
  assert.equal(gate.allowed, true, 'no gateway meta + key set: local behavior unchanged');
  assert.equal(gate.gatewayTrusted, undefined);
  assert.equal(gatewayActorFromMeta({ agent: 'local' }), undefined);
}

async function testRetiredSecretNeverTrusted() {
  // Any HMAC construction over the retired secret, or over the public PEM, must be untrusted, even with the
  // retired variable set and no public key configured. The executor must not be able to mint trust from a secret.
  setPublicKey(undefined);
  process.env.DC_GATEWAY_ATTESTATION_KEY = RETIRED_SECRET;
  const gw = { sub: 'user-abc', client_id: 'client-123', jti: 'jti-1', iat: now, verified: true };
  const material2 = `${gw.sub}.${gw.client_id}.${gw.jti}.${gw.iat}`;
  for (const keyMaterial of [RETIRED_SECRET, PUBLIC_PEM]) {
    const hmacSig = crypto.createHmac('sha256', keyMaterial).update(material2).digest('base64url');
    assert.equal(isTrustedGatewayMeta({ gateway: { ...gw, sig: hmacSig } }, now), false, 'HMAC sig must never be trusted');
  }
  setPublicKey(PUBLIC_PEM);
  const hmacWithPublic = crypto.createHmac('sha256', PUBLIC_PEM).update(material2).digest('base64url');
  assert.equal(isTrustedGatewayMeta({ gateway: { ...gw, sig: hmacWithPublic } }, now), false, 'HMAC keyed with the public PEM is not a signature');
  delete process.env.DC_GATEWAY_ATTESTATION_KEY;
}

async function testUnparseablePublicKeyFailsClosed() {
  setPublicKey('not a pem');
  const gate = await preExecuteEnforcement({ ...REQ, meta: gatewayMeta(), now });
  assert.equal(gate.allowed, false, 'a configured but unusable public key must reject gateway-bearing requests');
  assert.equal(gate.code, 'GATEWAY_ATTESTATION_INVALID');
  setPublicKey(undefined);
}

async function testAuditChainVerifiesWithGatewayActor() {
  const chainPath = path.join(tmp, 'audit', 'chain-g.jsonl');
  const chain = new AuditChain(chainPath);
  chain.append({ kind: 'request', tool: 'read_file', agent: 'old-style' });
  chain.append({
    kind: 'request', tool: 'read_file', agent: 'unknown',
    transport: GATEWAY_TRANSPORT_VERIFIED,
    gatewayActor: { sub: 'user-abc', client_id: 'client-123' },
    argsPreview: '{"path":"/tmp/x.txt"}',
  });
  const result = verifyChain(chainPath);
  assert.equal(result.valid, true, `chain with gatewayActor event must verify: ${result.error}`);
  const events = JSON.parse(fs.readFileSync(chainPath, 'utf8').trim().split('\n').pop());
  assert.deepEqual(events.gatewayActor, { sub: 'user-abc', client_id: 'client-123' });
}

await testEnvUnsetOldBehavior();
await testEnvSetTrusted();
await testFakeVerifiedRejected();
await testWrongSignerRejected();
await testStaleIatRejected();
await testNoGatewayMetaUnchanged();
await testRetiredSecretNeverTrusted();
await testUnparseablePublicKeyFailsClosed();
await testAuditChainVerifiesWithGatewayActor();
console.log('Gateway attribution tests passed.');
