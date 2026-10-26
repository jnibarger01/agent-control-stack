import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import net from 'node:net';

const root = new URL('../', import.meta.url).pathname;
const secret = 'managed-jc-test-execution-token';
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };
function attestation(overrides = {}, key = secret) {
  const iat = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ sub: 'operator', client_id: 'client', jti: 'request', iat, exp: iat + 60, ...overrides })).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}
const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, BRIDGE_PROFILE: 'jace-commander', ACS_MANAGED_MODE: '1', DC_CMD: process.execPath, DC_ARGS: `${root}test/stub-jc.mjs serve`, JC_DC_DIR: root, JC_ACS_PUBLIC_KEY: 'test-key', JC_ACS_KEY_ID: 'test-key-id', JC_RUNTIME_ID: 'test-runtime' };
async function fixture(t, overrides = {}) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-attestation-'));
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const child = spawn(process.execPath, [`${root}bridge.js`], { env: { ...baseEnv, BRIDGE_PORT: String(port), JC_STATE_DIR: state, DC_GATEWAY_EXECUTION_TOKEN: secret, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  t.after(async () => { if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } fs.rmSync(state, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* starting */ }
    assert.equal(child.exitCode, null, output);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-dc-agent': 'operator', 'x-dc-attestation': attestation() };
  const post = (body, extra = {}) => fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  return { base, post, headers, state };
}

test('managed JC refuses startup without an execution token', () => {
  const run = spawnSync(process.execPath, [`${root}bridge.js`], { env: baseEnv, encoding: 'utf8', timeout: 3000 });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /DC_GATEWAY_EXECUTION_TOKEN/);
});

const invalid = {
  missing: () => '', forged: () => attestation({}, 'wrong-key'), malformed: () => 'not.an.attestation',
  expired: () => attestation({ iat: 1, exp: 2 }), mismatched: () => attestation({ sub: 'intruder' }),
  trailing: () => `${attestation()}.extra`, missingSubject: () => attestation({ sub: undefined }),
  missingIssuedAt: () => attestation({ iat: undefined }), future: () => attestation({ iat: Math.floor(Date.now() / 1000) + 60, exp: Math.floor(Date.now() / 1000) + 90 }),
};
for (const [name, mint] of Object.entries(invalid)) {
  test(`managed JC rejects ${name} attestation before session creation or forwarding`, async (t) => {
    const f = await fixture(t);
    const r = await f.post(init, { 'x-dc-attestation': mint() });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('mcp-session-id'), null);
    const authority = await (await fetch(`${f.base}/authority`)).json();
    assert.equal(authority.bridge.sessionCount, 0);
    assert.equal(authority.bridge.initialized, false);
    const log = path.join(f.state, 'received.jsonl');
    assert.equal(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', '');
  });
}

test('attested initialization and discovery work; every subsequent method requires attestation and tools require ACS capability', async (t) => {
  const f = await fixture(t);
  const r = await f.post(init);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /serverInfo/);
  const sid = r.headers.get('mcp-session-id');
  assert.ok(sid);
  const sessionHeaders = { 'mcp-session-id': sid };
  for (const method of ['GET', 'DELETE']) {
    const denied = await fetch(`${f.base}/mcp`, { method, headers: sessionHeaders });
    assert.equal(denied.status, 401);
  }
  for (const body of [{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'acs_read', arguments: { view: 'health' } } }]) {
    assert.equal((await f.post(body, { ...sessionHeaders, 'x-dc-attestation': '' })).status, 401);
  }
  assert.equal((await f.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionHeaders)).status, 202);
  const discovered = await f.post({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, sessionHeaders);
  assert.equal(discovered.status, 200);
  assert.match(await discovered.text(), /result/);
  const denied = await f.post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'acs_read', arguments: { view: 'health' } } }, sessionHeaders);
  // The bridge refuses a capability-less tools/call itself: the executor (stub) must never receive it.
  assert.equal(denied.status, 403);
  assert.match(await denied.text(), /ACS capability required/);
  assert.doesNotMatch(fs.readFileSync(path.join(f.state, 'received.jsonl'), 'utf8'), /"tools\/call"/);
  const closed = await fetch(`${f.base}/mcp`, { method: 'DELETE', headers: { ...f.headers, ...sessionHeaders } });
  assert.ok([200, 202, 204].includes(closed.status));
});

test('real managed JC child refuses execution without an ACS capability', async (t) => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const f = await fixture(t, {
    DC_ARGS: `${path.resolve(root, '../../vendor/desktop-commander/dist/jace-commander/cli.js')} serve`,
    JC_ACS_PUBLIC_KEY: publicKey.export({ format: 'pem', type: 'spki' }),
  });
  const response = await f.post(init);
  assert.equal(response.status, 200);
  await response.text();
  const headers = { 'mcp-session-id': response.headers.get('mcp-session-id') };
  const result = await f.post({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'write_file', arguments: { path: path.join(f.state, 'must-not-exist'), content: 'unauthorized' } } }, headers);
  // Refused by the bridge before forwarding: the executor never runs the call, so nothing is written.
  const resultBody = await result.text();
  assert.equal(result.status, 403, resultBody);
  assert.match(resultBody, /ACS capability required/);
  assert.equal(fs.existsSync(path.join(f.state, 'must-not-exist')), false);
});

test('real managed JC child independently rejects a forged ACS capability envelope', async (t) => {
  // The bridge accepts a capability envelope's presence; only the executor can verify its signature. A forged envelope
  // must be forwarded and rejected there, with nothing written.
  const { publicKey } = generateKeyPairSync('ed25519');
  const f = await fixture(t, {
    DC_ARGS: `${path.resolve(root, '../../vendor/desktop-commander/dist/jace-commander/cli.js')} serve`,
    JC_ACS_PUBLIC_KEY: publicKey.export({ format: 'pem', type: 'spki' }),
  });
  const response = await f.post(init);
  assert.equal(response.status, 200);
  await response.text();
  const headers = { 'mcp-session-id': response.headers.get('mcp-session-id') };
  const target = path.join(f.state, 'forged-must-not-exist');
  const forged = { version: 'acs.jc.v1', capabilityId: 'forged', signature: 'AAAA', tool: 'write_file' };
  const result = await f.post({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'write_file', arguments: { path: target, content: 'forged' }, _meta: { acsCapability: forged } } }, headers);
  const text = await result.text();
  assert.equal(result.status, 200);
  assert.match(text, /JC_CAPABILITY_[A-Z_]+/);
  assert.match(text, /"isError":true/);
  assert.equal(fs.existsSync(target), false);
});

for (const overrides of [
  { JC_PRESET: 'local', JC_ALLOW_SAME_UID_CHILD: '1' },
  { JC_PRESET: 'standalone' },
  { DC_ARGS: `${root}test/stub-jc.mjs serve --preset local` },
  { DC_ARGS: `${root}test/stub-jc.mjs serve --preset standalone` },
]) {
  test(`managed JC refuses conflicting child preset: ${JSON.stringify(overrides)}`, () => {
    const run = spawnSync(process.execPath, [`${root}bridge.js`], { env: { ...baseEnv, BRIDGE_PORT: '0', DC_GATEWAY_EXECUTION_TOKEN: secret, ...overrides }, encoding: 'utf8', timeout: 1000 });
    assert.match(run.stderr, /managed jace-commander refuses/);
    assert.equal(run.status, 1);
  });
}
