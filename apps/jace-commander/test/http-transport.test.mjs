#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadJcConfig } from '../dist/config.js';
import { ReplayCache, isAllowedHost, isAllowedOrigin, startJcHttpServer, stampGatewayIdentity, stripUntrustedGatewayMeta, verifyGatewayAttestation } from '../dist/http-transport.js';
import { JC_MANIFEST } from '../dist/manifest.generated.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-http-'));
const config = loadJcConfig({
  HOME: root,
  JC_STATE_DIR: path.join(root, '.jc'),
  JC_FS_ROOTS: root,
  JC_RUNTIME_ID: 'jc-http-test',
});

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`  ✓ ${name}`); }

function mintAttestation(token, sub = 'operator', jti = 'j1') {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub, client_id: 'client', jti, iat: now, exp: now + 30 };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', token).update(body).digest('base64url');
  return `${body}.${sig}`;
}

await test('verifyGatewayAttestation accepts valid token and rejects tampered/expired/mismatched', async () => {
  const token = 'secret-token';
  const att = mintAttestation(token, 'alice');
  const ok = verifyGatewayAttestation(att, 'alice', token);
  assert.ok(ok);
  assert.equal(ok.sub, 'alice');
  assert.equal(verifyGatewayAttestation(att, 'bob', token), null, 'agent mismatch must fail');
  assert.equal(verifyGatewayAttestation(att + 'x', 'alice', token), null, 'tampered must fail');
  assert.equal(verifyGatewayAttestation(att, 'alice', 'wrong'), null, 'wrong key must fail');
  const expiredPayload = { sub: 'alice', client_id: 'c', jti: 'j', iat: Math.floor(Date.now()/1000)-120, exp: Math.floor(Date.now()/1000)-60 };
  const b = Buffer.from(JSON.stringify(expiredPayload)).toString('base64url');
  const s = crypto.createHmac('sha256', token).update(b).digest('base64url');
  assert.equal(verifyGatewayAttestation(`${b}.${s}`, 'alice', token), null, 'expired must fail');
});

await test('ReplayCache rejects reused jti and allows fresh/missing-jti attestations', async () => {
  const cache = new ReplayCache(() => 1000);
  assert.equal(cache.accept('j1', 1030), true);
  assert.equal(cache.accept('j1', 1030), false, 'replay must be rejected');
  assert.equal(cache.accept('j2', 1030), true);
  assert.equal(cache.accept('', 1030), true, 'missing jti falls back to TTL-only acceptance');
});

await test('Host/Origin validation allows loopback/missing origin and rejects disallowed origins', async () => {
  assert.equal(isAllowedHost('127.0.0.1:8011'), true);
  assert.equal(isAllowedHost('localhost'), true);
  assert.equal(isAllowedHost('evil.example'), false);
  assert.equal(isAllowedOrigin(undefined, '127.0.0.1:8011'), true);
  assert.equal(isAllowedOrigin('http://localhost:3000', '127.0.0.1:8011'), true);
  assert.equal(isAllowedOrigin('https://evil.example', '127.0.0.1:8011'), false);
  assert.equal(isAllowedOrigin('https://app.example.com', 'app.example.com:443', ['https://app.example.com']), true);
});

await test('stampGatewayIdentity strips spoofed authority meta and injects verified gateway', async () => {
  const token = 'secret-token';
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file', arguments: {}, _meta: { gateway: { verified: false, sub: 'evil' }, acsCapability: { fake: true }, capability: 1, acsRuntimeBootstrap: { x: 1 }, keep: 'x' } } };
  const stamped = stampGatewayIdentity(body, { sub: 'alice', client_id: 'c1', jti: 'j1', iat: 1, exp: 2 }, token);
  const meta = stamped.params._meta;
  assert.equal(meta.gateway.verified, true);
  assert.equal(meta.gateway.sub, 'alice');
  assert.equal(meta.gateway.client_id, 'c1');
  assert.equal(meta.acsCapability, undefined);
  assert.equal(meta.capability, undefined);
  assert.equal(meta.acsRuntimeBootstrap, undefined);
  assert.equal(meta.keep, 'x');
});

await test('stripUntrustedGatewayMeta removes spoofed gateway/authority fields', async () => {
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { gateway: { verified: true, sub: 'evil' }, acsCapability: {}, acsRuntimeIdentity: {}, ok: 1 } } };
  const cleaned = stripUntrustedGatewayMeta(body);
  assert.equal(cleaned.params._meta.gateway, undefined);
  assert.equal(cleaned.params._meta.acsCapability, undefined);
  assert.equal(cleaned.params._meta.acsRuntimeIdentity, undefined);
  assert.equal(cleaned.params._meta.ok, 1);
});

await test('HTTP server exposes /health and /tools registry and enforces batch tools/call + content-type + origin checks', async () => {
  const srv = await startJcHttpServer({ config, mode: 'standalone', host: '127.0.0.1', port: 0 });
  try {
    const health = await fetch(srv.url.replace('/mcp', '/health')).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.equal(health.transport, 'http');

    const tools = await fetch(srv.url.replace('/mcp', '/tools')).then((r) => r.json());
    assert.equal(tools.manifestHash, JC_MANIFEST.manifestHash);
    assert.equal(tools.tools.length, JC_MANIFEST.tools.length);
    assert.equal(tools.tools[0].inputSchema.type, 'object');

    const batch = await fetch(srv.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file', arguments: {} } },
      ]),
    });
    assert.equal(batch.status, 400);
    assert.match(JSON.stringify(await batch.json()), /batched_tools_call_rejected/);

    const badCt = await fetch(srv.url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(badCt.status, 415);

    const badOrigin = await fetch(srv.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(badOrigin.status, 403);
  } finally {
    await srv.close();
  }
});

await test('native HTTP managed mode requires valid attestation and rejects replay', async () => {
  const token = 'attest-token';
  const srv = await startJcHttpServer({ config, mode: 'managed', host: '127.0.0.1', port: 0, attestationToken: token, requireAttestation: true });
  try {
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
    const noAuth = await fetch(srv.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(init) });
    assert.equal(noAuth.status, 401);
    assert.match(JSON.stringify(await noAuth.json()), /gateway attestation required/);

    const att = mintAttestation(token, 'operator', 'replay-jti');
    const bad = await fetch(srv.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dc-agent': 'operator', 'x-dc-attestation': att },
      body: JSON.stringify(init),
    });
    // First request has valid attestation but initialize may fail later due to managed config in test env; it must NOT be rejected as attestation required/invalid/replayed.
    assert.notEqual(bad.status, 401);
    assert.notEqual(bad.status, 403);
    const badBody = JSON.stringify(await bad.json().catch(() => ({})));
    assert.doesNotMatch(badBody, /gateway attestation required|gateway attestation invalid|gateway attestation replayed/);

    const replayed = await fetch(srv.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dc-agent': 'operator', 'x-dc-attestation': att },
      body: JSON.stringify(init),
    });
    assert.equal(replayed.status, 401);
    assert.match(JSON.stringify(await replayed.json()), /gateway attestation replayed/);
  } finally {
    await srv.close();
  }
});

console.log(`ok ${passed}`);
