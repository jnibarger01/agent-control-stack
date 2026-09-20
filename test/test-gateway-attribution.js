#!/usr/bin/env node
/**
 * Trusted gateway transport attribution tests.
 *
 * Trust chain under test: the OAuth gateway holds GATEWAY_EXECUTION_TOKEN;
 * its bridge verifies the caller and re-signs/forwards
 *   _meta.gateway = { sig: base64url(hmacSHA256(SECRET, `${sub}.${client_id}.${jti}.${iat}`)),
 *                     sub, client_id, jti, iat }
 * DC verifies the sig with the SAME shared secret (DC_GATEWAY_ATTESTATION_KEY),
 * requires iat within 10 minutes and a non-empty jti. A client-set
 * verified:true boolean alone is NEVER trusted.
 *
 * Cases:
 *   A — env unset: old behavior (spoofed _meta.agent accepted for
 *       attribution; fake verified:true causes NO rejection).
 *   B — env set + valid HMAC: trusted; verified transport string; gateway
 *       sub/client_id recorded as gatewayActor in the audit event.
 *   C — env set + fake verified:true (no sig): rejected GATEWAY_ATTESTATION_INVALID.
 *   D — env set + valid-looking sig but wrong secret: rejected.
 *   E — env set + stale iat (>10 min): rejected.
 *   F — env set + no gateway meta: allowed, unchanged local behavior.
 *   G — audit chain with a gatewayActor event still verifies end-to-end.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Redirect the audit chain BEFORE importing dist modules (audit-chain reads
// DC_AUDIT_DIR at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-gateway-attr-'));
process.env.DC_AUDIT_DIR = path.join(tmp, 'audit');
process.env.DC_ENFORCEMENT = 'off'; // keep other gates out of scope here

const { preExecuteEnforcement, isTrustedGatewayMeta, gatewayActorFromMeta, GATEWAY_TRANSPORT_VERIFIED, attestRequest } = await import('../dist/enforcement/pipeline.js');
const { AuditChain, verifyChain } = await import('../dist/audit/audit-chain.js');

const SECRET = 'test-gateway-execution-token';
const now = Date.now();

function bridgeSig(secret, gw) {
  return crypto.createHmac('sha256', secret)
    .update(`${gw.sub}.${gw.client_id}.${gw.jti}.${gw.iat}`)
    .digest('base64url');
}

function gatewayMeta(overrides = {}) {
  const gw = {
    sub: 'user-abc',
    client_id: 'client-123',
    jti: 'jti-1',
    iat: now,
    verified: true,
    ...overrides,
  };
  if (gw.sig === undefined && !('sig' in overrides && gw.sig === null)) {
    gw.sig = bridgeSig(SECRET, gw);
  }
  return { agent: 'spoofed-agent', remote: true, gateway: gw };
}

const REQ = { tool: 'read_file', args: { path: '/tmp/x.txt' } };

async function testEnvUnsetOldBehavior() {
  delete process.env.DC_GATEWAY_ATTESTATION_KEY;
  // Spoofed self-reported agent still accepted for attribution...
  assert.equal(isTrustedGatewayMeta({ agent: 'spoofed-agent', gateway: { verified: true, sub: 'x', client_id: 'y', jti: 'z', iat: now, sig: 'garbage' } }), false,
    'env unset: nothing is trusted-gateway');
  // ...and a fake verified:true gateway meta causes NO rejection (backwards compat).
  const gate = await preExecuteEnforcement({ ...REQ, meta: gatewayMeta(), now });
  assert.equal(gate.allowed, true, 'env unset: fake verified:true must not be rejected');
  assert.equal(gate.gatewayTrusted, undefined);
  // Self-report remains the display attribution path (agentFromMeta unchanged).
  const { agentFromMeta } = await import('../dist/enforcement/pipeline.js');
  assert.equal(agentFromMeta({ agent: 'spoofed-agent' }), 'spoofed-agent');
}

async function testEnvSetTrusted() {
  process.env.DC_GATEWAY_ATTESTATION_KEY = SECRET;
  const meta = gatewayMeta();
  assert.equal(isTrustedGatewayMeta(meta, now), true, 'valid bridge HMAC must be trusted');
  const gate = await preExecuteEnforcement({ ...REQ, meta, now });
  assert.equal(gate.allowed, true);
  assert.equal(gate.gatewayTrusted, true);
  assert.deepEqual(gate.gatewayActor, { sub: 'user-abc', client_id: 'client-123' });

  // Audit event: verified transport + gatewayActor side-channel (validated
  // end-to-end against the chain in testAuditChainVerifiesWithGatewayActor).
  const origAudit = await import('../dist/enforcement/pipeline.js');
  const ok = origAudit.attestRequest({
    requestHash: 'hash-b', tool: 'read_file', agent: 'spoofed-agent',
    transport: GATEWAY_TRANSPORT_VERIFIED,
    gatewayActor: { sub: 'user-abc', client_id: 'client-123' },
    args: { path: '/tmp/x.txt' },
  });
  assert.equal(ok, true);
  assert.equal(GATEWAY_TRANSPORT_VERIFIED, 'oauth-gateway->mcp (verified)');
  assert.equal(isTrustedGatewayMeta(meta, now + 5 * 60 * 1000), true, 'within 10 min window: trusted');
  assert.equal(isTrustedGatewayMeta(meta, now + 11 * 60 * 1000), false, 'beyond 10 min window: untrusted');
}

async function testEnvSetFakeVerifiedRejected() {
  process.env.DC_GATEWAY_ATTESTATION_KEY = SECRET;
  // Client claims verified:true directly — no/invalid sig. Fail closed.
  const fake = gatewayMeta({ sig: null });
  delete fake.gateway.sig;
  assert.equal(isTrustedGatewayMeta(fake, now), false, 'verified:true without sig is NOT trusted');
  const gate = await preExecuteEnforcement({ ...REQ, meta: fake, now });
  assert.equal(gate.allowed, false, 'fake verified:true must be rejected when env key set');
  assert.equal(gate.allowed === false && gate.code, 'GATEWAY_ATTESTATION_INVALID');

  // Tampered sub (sig computed over different sub).
  const tampered = gatewayMeta({ sub: 'user-abc' });
  tampered.gateway.sub = 'admin';
  assert.equal(isTrustedGatewayMeta(tampered, now), false);
  const gate2 = await preExecuteEnforcement({ ...REQ, meta: tampered, now });
  assert.equal(gate2.allowed === false && gate2.code, 'GATEWAY_ATTESTATION_INVALID');

  // Missing jti.
  const noJti = gatewayMeta({ jti: '' });
  assert.equal(isTrustedGatewayMeta(noJti, now), false, 'empty jti must be untrusted');
  const gate3 = await preExecuteEnforcement({ ...REQ, meta: noJti, now });
  assert.equal(gate3.allowed === false && gate3.code, 'GATEWAY_ATTESTATION_INVALID');
}

async function testEnvSetWrongSecretRejected() {
  process.env.DC_GATEWAY_ATTESTATION_KEY = SECRET;
  const gw = { sub: 'u', client_id: 'c', jti: 'j', iat: now, verified: true };
  const wrongSecret = { ...gw, sig: bridgeSig('some-other-token', gw) };
  assert.equal(isTrustedGatewayMeta({ gateway: wrongSecret }, now), false, 'sig under a different secret must be untrusted');
  const gate = await preExecuteEnforcement({ ...REQ, meta: { gateway: wrongSecret }, now });
  assert.equal(gate.allowed === false && gate.code, 'GATEWAY_ATTESTATION_INVALID');
}

async function testEnvSetStaleIatRejected() {
  process.env.DC_GATEWAY_ATTESTATION_KEY = SECRET;
  const gw = { sub: 'u', client_id: 'c', jti: 'j', iat: now - 11 * 60 * 1000, verified: true };
  const stale = { ...gw, sig: bridgeSig(SECRET, gw) };
  assert.equal(isTrustedGatewayMeta({ gateway: stale }, now), false, 'stale iat must be untrusted');
  const gate = await preExecuteEnforcement({ ...REQ, meta: { gateway: stale }, now });
  assert.equal(gate.allowed === false && gate.code, 'GATEWAY_ATTESTATION_INVALID');
}

async function testEnvSetNoGatewayMetaUnchanged() {
  process.env.DC_GATEWAY_ATTESTATION_KEY = SECRET;
  // Direct/local request without gateway meta: allowed, no trusted attribution.
  const gate = await preExecuteEnforcement({ ...REQ, meta: { agent: 'local' }, now });
  assert.equal(gate.allowed, true, 'no gateway meta + env set: local behavior unchanged');
  assert.equal(gate.gatewayTrusted, undefined);
  assert.equal(gatewayActorFromMeta({ agent: 'local' }), undefined);
}

async function testAuditChainVerifiesWithGatewayActor() {
  const chainPath = path.join(tmp, 'audit', 'chain-g.jsonl');
  const chain = new AuditChain(chainPath);
  chain.append({ kind: 'request', tool: 'read_file', agent: 'old-style' }); // pre-gateway event
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
  assert.equal(events.transport, 'oauth-gateway->mcp (verified)');
}

await testEnvUnsetOldBehavior();
await testEnvSetTrusted();
await testEnvSetFakeVerifiedRejected();
await testEnvSetWrongSecretRejected();
await testEnvSetStaleIatRejected();
await testEnvSetNoGatewayMetaUnchanged();
await testAuditChainVerifiesWithGatewayActor();
console.log('Gateway attribution tests passed.');
