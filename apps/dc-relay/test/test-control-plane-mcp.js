#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createControlPlaneServer, mcpClientAllowed } from '../dist/server.js';
import { InMemoryPairingStore } from '../dist/pairing-store.js';
import { ControlPlaneError, ControlPlaneService, InMemoryControlPlaneStore } from '../dist/service.js';

const USER = '22222222-2222-4222-8222-222222222222';
const GENERATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const config = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key',
  SUPABASE_SECRET_KEY: 'test-secret-key',
  DEVICE_OAUTH_CLIENT_ID: 'device-client',
  PAIRING_STATE_KEY: crypto.randomBytes(32).toString('base64'),
  PAIRING_CODE_KEY: crypto.randomBytes(32).toString('base64'),
  CONTROL_PLANE_URL: 'https://relay.example.test:8443',
};
const store = new InMemoryControlPlaneStore();
const service = new ControlPlaneService(store, { dispatchTimeoutMs: 5_000 });
let clientId = 'claude-dcr-client';
const server = createControlPlaneServer(config, {
  pairingStore: new InMemoryPairingStore(),
  authenticate: async (req) => {
    if (req.headers.authorization !== 'Bearer good') throw new ControlPlaneError('not_found', 'not found');
    return { userId: USER, token: 'good', sessionId: 'claude-session', clientId };
  },
  serviceFor: () => service,
  mcp: { pollIntervalMs: 10, maxWaitMs: 300 },
});

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); }
  catch (error) { failures++; console.error(`FAIL  ${name}\n  ${error.stack || error.message}`); }
}
let nextId = 1;
async function rpc(method, params, auth = 'Bearer good') {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  return { status: response.status, headers: response.headers, body: response.status === 202 ? null : await response.json() };
}
async function callTool(name, args) {
  const { body } = await rpc('tools/call', { name, arguments: args });
  return body.result;
}

server.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const device = await service.registerDevice(USER, { device_name: 'jacen-ubuntu', capabilities: { transport_broadcast_v1: true, tool_names: ['list_directory'] } });
await service.bindDeviceSession(USER, device.id, 'device-session');
await service.setPresence(USER, device.id, { present: true, transport: 'broadcast_v1', localMcpReady: true, connectionGeneration: GENERATION });

/** Simulated device: claim + complete through the same store transitions the RPCs enforce. */
async function answer(idempotencyKey, result) {
  for (let i = 0; i < 100; i++) {
    const call = await store.getCallByIdempotency(USER, device.id, idempotencyKey);
    if (call) {
      const now = new Date().toISOString();
      assert.equal(await store.claimCall(USER, device.id, call.id, 'device-session', GENERATION, now), true);
      await store.completeCall(USER, device.id, call.id, 'device-session', GENERATION, 'completed', result, null, now);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('call never dispatched');
}

try {
  await test('GET /mcp is 405', async () => {
    const response = await fetch(`${base}/mcp`, { headers: { authorization: 'Bearer good' } });
    assert.equal(response.status, 405);
  });

  await test('unauthenticated /mcp is 401 with resource_metadata challenge', async () => {
    const missing = await rpc('initialize', {}, null);
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get('www-authenticate'), 'Bearer resource_metadata="https://relay.example.test:8443/.well-known/oauth-protected-resource"');
    const bad = await rpc('initialize', {}, 'Bearer nope');
    assert.equal(bad.status, 401);
    assert.match(bad.headers.get('www-authenticate'), /error="invalid_token"/);
  });

  await test('protected resource metadata points at Supabase Auth', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const body = await (await fetch(`${base}${path}`)).json();
      assert.equal(body.resource, 'https://relay.example.test:8443/mcp');
      assert.deepEqual(body.authorization_servers, ['https://example.supabase.co/auth/v1']);
    }
  });

  await test('initialize and notifications', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.status, 200);
    assert.equal(init.body.result.protocolVersion, '2025-06-18');
    assert.deepEqual(init.body.result.capabilities, { tools: { listChanged: false } });
    const note = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer good', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    assert.equal(note.status, 202);
  });

  await test('tools/list exposes only list_devices, get_device, call_device_tool', async () => {
    const { body } = await rpc('tools/list', {});
    assert.deepEqual(body.result.tools.map((tool) => tool.name), ['list_devices', 'get_device', 'call_device_tool']);
  });

  await test('/mcp accepts a non-device OAuth client (no device client_id needed)', async () => {
    clientId = 'some-other-client';
    const result = await callTool('list_devices', {});
    assert.equal(result.isError, false);
    const listed = JSON.parse(result.content[0].text).devices;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].state, 'online');
    assert.equal(listed[0].execution_ready, true);
    assert.deepEqual(listed[0].tool_names, ['list_directory']);
    clientId = 'claude-dcr-client';
  });

  await test('/mcp rejects plain session tokens (no client_id claim) with 403', async () => {
    clientId = null;
    const response = await rpc('tools/list', {});
    clientId = 'claude-dcr-client';
    assert.equal(response.status, 403);
    assert.deepEqual(response.body, { error: 'client_not_permitted' });
    assert.match(response.headers.get('www-authenticate'), /resource_metadata="https:\/\/relay\.example\.test:8443\/\.well-known\/oauth-protected-resource"/);
  });

  await test('/mcp rejects the device pairing client even with a valid token', async () => {
    clientId = config.DEVICE_OAUTH_CLIENT_ID;
    const response = await rpc('tools/call', { name: 'list_devices', arguments: {} });
    clientId = 'claude-dcr-client';
    assert.equal(response.status, 403);
    assert.deepEqual(response.body, { error: 'client_not_permitted' });
  });

  await test('MCP_ALLOWED_CLIENT_IDS: unset allows any non-device client; set restricts to the list', async () => {
    const base = { DEVICE_OAUTH_CLIENT_ID: 'device-client' };
    assert.equal(mcpClientAllowed(base, 'anything'), true);
    assert.equal(mcpClientAllowed({ ...base, MCP_ALLOWED_CLIENT_IDS: '' }, 'anything'), true);
    assert.equal(mcpClientAllowed(base, null), false);
    assert.equal(mcpClientAllowed(base, 'device-client'), false);
    const listed = { ...base, MCP_ALLOWED_CLIENT_IDS: ' claude-a , claude-b ' };
    assert.equal(mcpClientAllowed(listed, 'claude-a'), true);
    assert.equal(mcpClientAllowed(listed, 'claude-b'), true);
    assert.equal(mcpClientAllowed(listed, 'claude-c'), false);
    assert.equal(mcpClientAllowed({ ...listed, MCP_ALLOWED_CLIENT_IDS: 'device-client' }, 'device-client'), false, 'allowlist must not re-admit the device client');
  });

  await test('MCP_ALLOWED_CLIENT_IDS is enforced over HTTP', async () => {
    const restricted = createControlPlaneServer({ ...config, MCP_ALLOWED_CLIENT_IDS: 'claude-a' }, {
      pairingStore: new InMemoryPairingStore(),
      authenticate: async (req) => ({ userId: USER, token: 'good', sessionId: 's', clientId: req.headers['x-test-client'] }),
      serviceFor: () => service,
    });
    restricted.listen(0, '127.0.0.1');
    await new Promise((resolve) => restricted.once('listening', resolve));
    const url = `http://127.0.0.1:${restricted.address().port}/mcp`;
    const call = (client) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer good', 'x-test-client': client }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    try {
      assert.equal((await call('claude-a')).status, 200);
      assert.equal((await call('claude-b')).status, 403);
    } finally {
      await new Promise((resolve) => restricted.close(resolve));
    }
  });

  await test('device registration still requires the device OAuth client_id', async () => {
    const response = await fetch(`${base}/api/devices/register`, { method: 'POST', headers: { authorization: 'Bearer good', 'content-type': 'application/json' }, body: JSON.stringify({ device_name: 'x', capabilities: {} }) });
    assert.equal(response.status, 404);
  });

  await test('POST /api/devices/register is idempotent per auth session', async () => {
    const regUser = '33333333-3333-4333-8333-333333333333';
    const regServer = createControlPlaneServer(config, {
      pairingStore: new InMemoryPairingStore(),
      authenticate: async () => ({ userId: regUser, token: 't', sessionId: 'device-session-1', clientId: config.DEVICE_OAUTH_CLIENT_ID }),
      serviceFor: () => service,
    });
    regServer.listen(0, '127.0.0.1');
    await new Promise((resolve) => regServer.once('listening', resolve));
    const url = `http://127.0.0.1:${regServer.address().port}/api/devices/register`;
    const register = async (body) => {
      const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify({ device_name: 'box', capabilities: { transport_broadcast_v1: true }, ...body }) });
      return { status: response.status, body: await response.json() };
    };
    try {
      const first = await register({});
      assert.equal(first.status, 200);
      // Retry without the id (the device never learned it), and with a stale unknown id: same device, no second row.
      const retry = await register({});
      const stale = await register({ device_id: '44444444-4444-4444-8444-444444444444' });
      assert.equal(retry.status, 200);
      assert.equal(stale.status, 200);
      assert.equal(retry.body.id, first.body.id);
      assert.equal(stale.body.id, first.body.id);
      assert.equal((await service.listDevices(regUser)).length, 1, 'retry created another device row');
    } finally {
      await new Promise((resolve) => regServer.close(resolve));
    }
  });

  await test('get_device returns one device and validates input', async () => {
    const result = await callTool('get_device', { device_id: device.id });
    assert.equal(JSON.parse(result.content[0].text).id, device.id);
    const invalid = await rpc('tools/call', { name: 'get_device', arguments: { device_id: 'nope' } });
    assert.equal(invalid.body.error.code, -32602);
  });

  await test('call_device_tool happy path round-trips the device result', async () => {
    const deviceResult = { content: [{ type: 'text', text: '[DIR] projects' }] };
    const [result] = await Promise.all([
      callTool('call_device_tool', { device_id: device.id, tool_name: 'list_directory', arguments: { path: '~/projects' }, idempotency_key: 'happy-1' }),
      answer('happy-1', deviceResult),
    ]);
    assert.deepEqual(result, { content: deviceResult.content, isError: false });
    const call = await store.getCallByIdempotency(USER, device.id, 'happy-1');
    assert.equal(call.tool_name, 'list_directory');
    assert.deepEqual(call.tool_args, { path: '~/projects' });
  });

  await test('call_device_tool timeout is bounded and reports the idempotency key', async () => {
    const started = Date.now();
    const result = await callTool('call_device_tool', { device_id: device.id, tool_name: 'list_directory', arguments: {}, idempotency_key: 'slow-1' });
    assert(Date.now() - started < 2_000, 'poll was not bounded');
    assert.equal(result.isError, true);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.status, 'pending');
    assert.equal(body.idempotency_key, 'slow-1');
  });

  await test('call_device_tool against an unavailable device is a tool error, not a dispatch', async () => {
    const offline = await service.registerDevice(USER, { device_name: 'offline', capabilities: { transport_broadcast_v1: true } });
    const result = await callTool('call_device_tool', { device_id: offline.id, tool_name: 'list_directory' });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, 'device_unavailable');
  });
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
process.exitCode = failures ? 1 : 0;
