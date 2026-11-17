#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadJcConfig } from '../dist/config.js';
import { startJcHttpServer, verifyGatewayAttestation, stampGatewayIdentity, stripUntrustedGatewayMeta } from '../dist/http-transport.js';
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

function mintAttestation(token, sub = 'operator') {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub, client_id: 'client', jti: 'j1', iat: now, exp: now + 30 };
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

await test('stampGatewayIdentity strips spoofed authority meta and injects verified gateway', async () => {
  const token = 'secret-token';
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file', arguments: {}, _meta: { gateway: { verified: false, sub: 'evil' }, acsCapability: { fake: true }, capability: 1, keep: 'x' } } };
  const stamped = stampGatewayIdentity(body, { sub: 'alice', client_id: 'c1', jti: 'j1', iat: 1 }, token);
  const meta = stamped.params._meta;
  assert.equal(meta.gateway.verified, true);
  assert.equal(meta.gateway.sub, 'alice');
  assert.equal(meta.gateway.client_id, 'c1');
  assert.equal(meta.acsCapability, undefined);
  assert.equal(meta.capability, undefined);
  assert.equal(meta.keep, 'x');
});

await test('stripUntrustedGatewayMeta removes spoofed gateway/authority fields', async () => {
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { gateway: { verified: true, sub: 'evil' }, acsCapability: {}, ok: 1 } } };
  const cleaned = stripUntrustedGatewayMeta(body);
  assert.equal(cleaned.params._meta.gateway, undefined);
  assert.equal(cleaned.params._meta.acsCapability, undefined);
  assert.equal(cleaned.params._meta.ok, 1);
});

await test('HTTP server exposes /health and /tools registry and enforces batch tools/call refusal', async () => {
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
    const batchBody = await batch.json();
    assert.match(JSON.stringify(batchBody), /batched_tools_call_rejected/);
  } finally {
    await srv.close();
  }
});

await test('native HTTP managed mode refuses /mcp without valid attestation', async () => {
  const token = 'attest-token';
  const srv = await startJcHttpServer({ config, mode: 'managed', host: '127.0.0.1', port: 0, attestationToken: token, requireAttestation: true });
  try {
    const res = await fetch(srv.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.match(JSON.stringify(body), /gateway attestation required/);
  } finally {
    await srv.close();
  }
});

console.log(`ok ${passed}`);
