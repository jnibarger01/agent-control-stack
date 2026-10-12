#!/usr/bin/env node
/**
 * Jace Commander auth/reliability hardening regressions:
 *  A. FileNonceStore lazy expiry (O(1) replay check, amortized sweep, cap)
 *  B. single-flight token refresh (mcp-auth + device-login)
 *  C. McpHttpClient retry safety: only idempotent methods retry on 5xx/timeout;
 *     tools/call is resent only on provable non-delivery or a confirmed stale-session 404
 *  D. OAuth discovery fetches carry an abort signal (bounded)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileNonceStore, JcAuthorizationError } from '../dist/jace-commander/contract.js';
import { McpHttpClient } from '../dist/jace-commander/mcp-http-client.js';
import { discover, mcpAccessToken, mcpTokenPath } from '../dist/jace-commander/mcp-auth.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-resilience-'));
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });

// ---------------------------------------------------------------------------
// A. FileNonceStore
// ---------------------------------------------------------------------------
await test('nonce: O(1) replay check still rejects a re-used digest', () => {
  const store = new FileNonceStore(path.join(tmpRoot, 'replay'));
  const now = Date.now();
  store.reserve('once', now + 60_000, now);
  assert.throws(
    () => store.reserve('once', now + 60_000, now),
    (e) => e instanceof JcAuthorizationError && e.code === 'JC_CAPABILITY_NONCE_REPLAY',
  );
});

await test('nonce: lazy expiry sweeps a past-expiry entry and frees its digest', () => {
  const store = new FileNonceStore(path.join(tmpRoot, 'expiry'));
  const now = Date.now();
  store.reserve('stale', now - 1000, now); // created with a past expiry
  // Drive SWEEP_INTERVAL (64) reservations to trigger the amortized sweep.
  for (let i = 0; i < 64; i++) store.reserve(`fill-${i}`, now + 600_000, now);
  // The stale entry was swept, so its digest is reservable again (no EEXIST).
  assert.doesNotThrow(() => store.reserve('stale', now + 600_000, now));
});

await test('nonce: exceeding maxEntries fails closed', () => {
  const store = new FileNonceStore(path.join(tmpRoot, 'cap'), 4);
  const now = Date.now();
  let threw = false;
  try {
    for (let i = 0; i < 64; i++) store.reserve(`cap-${i}`, now + 600_000, now);
  } catch (e) {
    threw = e instanceof JcAuthorizationError && e.code === 'JC_CAPABILITY_NONCE_REPLAY';
  }
  assert.ok(threw, 'the entry cap must fail closed, not grow unbounded');
});

// ---------------------------------------------------------------------------
// B. single-flight refresh
// ---------------------------------------------------------------------------
await test('refresh: concurrent mcpAccessToken calls share one token request', async () => {
  const stateDir = path.join(tmpRoot, 'singleflight');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(mcpTokenPath(stateDir), JSON.stringify({ mcpUrl: 'https://edge.test/jc/mcp', clientId: 'c', accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() - 1000 }));
  let tokenCalls = 0;
  const fake = async (url) => {
    if (url.includes('oauth-protected-resource')) return json({ resource: 'https://edge.test/jc/mcp', authorization_servers: ['https://as.test'] });
    if (url.includes('oauth-authorization-server')) return json({ authorization_endpoint: 'https://as.test/auth', token_endpoint: 'https://as.test/token', registration_endpoint: 'https://as.test/reg' });
    if (url.endsWith('/token')) {
      tokenCalls += 1;
      await new Promise((r) => setTimeout(r, 40)); // keep the request in flight so both callers overlap
      return json({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 });
    }
    return new Response('', { status: 200 });
  };
  const [a, b] = await Promise.all([
    mcpAccessToken('https://edge.test/jc/mcp', stateDir, {}, fake),
    mcpAccessToken('https://edge.test/jc/mcp', stateDir, {}, fake),
  ]);
  assert.equal(tokenCalls, 1, 'concurrent refreshes must not each POST /token');
  assert.equal(a, b, 'both callers must receive the same refreshed access token');
});

// ---------------------------------------------------------------------------
// C. McpHttpClient retry + session re-init
// ---------------------------------------------------------------------------
const INIT_OK = (msg) => json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } });
const TOOL_OK = (msg) => json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } });
const connError = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`connect ${code}`), { code }) });
/** Fake edge: counts sends per method; `onToolCall(n, msg)` decides each tools/call answer. */
function fakeEdge({ onToolCall, onList, onInit } = {}) {
  const sends = { initialize: 0, 'notifications/initialized': 0, 'tools/list': 0, 'tools/call': 0 };
  const fetchImpl = async (_url, init) => {
    const msg = JSON.parse(init.body);
    sends[msg.method] = (sends[msg.method] ?? 0) + 1;
    if (msg.method === 'initialize') return onInit ? onInit(sends.initialize, msg) : INIT_OK(msg);
    if (msg.method === 'notifications/initialized') return new Response('', { status: 202 });
    if (msg.method === 'tools/list') return onList ? onList(sends['tools/list'], msg) : json({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } });
    if (msg.method === 'tools/call') return onToolCall(sends['tools/call'], msg);
    return new Response('', { status: 200 });
  };
  return { sends, client: new McpHttpClient({ url: 'http://edge.test/jc/mcp', token: async () => 't', fetchImpl }) };
}

await test('client: tools/call is NOT retried on a 503 (may already have executed)', async () => {
  const { sends, client } = fakeEdge({ onToolCall: (n, msg) => (n < 3 ? json({ error: 'server' }, 503) : TOOL_OK(msg)) });
  const result = await client.callTool('start_process', { command: 'x' });
  assert.equal(sends['tools/call'], 1, 'a 5xx tools/call must be sent exactly once');
  assert.equal(result.kind, 'managed_authorization_unavailable');
  assert.equal(result.retryable, true, 'the caller gets a retryable outcome instead');
});

await test('client: tools/call is NOT retried on a 502/504', async () => {
  for (const status of [502, 504]) {
    const { sends, client } = fakeEdge({ onToolCall: () => json({ error: 'gw' }, status) });
    const result = await client.callTool('write_file', { path: '/x', content: 'y' });
    assert.equal(sends['tools/call'], 1, `HTTP ${status} tools/call must be sent exactly once`);
    assert.equal(result.code, `edge_http_${status}`);
  }
});

await test('client: tools/call is NOT retried on a timeout', async () => {
  const { sends, client } = fakeEdge({ onToolCall: () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); } });
  const result = await client.callTool('start_process', { command: 'x' });
  assert.equal(sends['tools/call'], 1, 'a timed-out tools/call must be sent exactly once');
  assert.equal(result.code, 'edge_unreachable');
  assert.equal(result.retryable, true);
});

await test('client: tools/call is NOT retried on a reset after send / ambiguous network error', async () => {
  for (const err of [connError('ECONNRESET'), connError('UND_ERR_SOCKET'), connError('UND_ERR_CONNECT_TIMEOUT'), new TypeError('fetch failed'), new Error('other side closed')]) {
    const { sends, client } = fakeEdge({ onToolCall: () => { throw err; } });
    const result = await client.callTool('privileged_exec', { command: 'x' });
    assert.equal(sends['tools/call'], 1, `ambiguous failure (${err.cause?.code ?? err.message}) must be sent exactly once`);
    assert.equal(result.code, 'edge_unreachable');
  }
});

await test('client: tools/call IS retried on provable non-delivery (connection refused / DNS)', async () => {
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
    const { sends, client } = fakeEdge({ onToolCall: (n, msg) => { if (n < 3) throw connError(code); return TOOL_OK(msg); } });
    const result = await client.callTool('read_file', { path: '/x' });
    assert.equal(result.kind, 'ok', `${code} before send is safe to resend`);
    assert.equal(sends['tools/call'], 3, `${code}: bounded to 3 sends`);
  }
  const { sends, client } = fakeEdge({ onToolCall: () => { throw connError('ECONNREFUSED'); } });
  const result = await client.callTool('read_file', { path: '/x' });
  assert.equal(sends['tools/call'], 3, 'persistent ECONNREFUSED is bounded to 3 sends');
  assert.equal(result.code, 'edge_unreachable');
});

await test('client: a confirmed stale-session 404 re-inits once and resends tools/call once', async () => {
  const { sends, client } = fakeEdge({ onToolCall: (n, msg) => (n === 1 ? json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } }, 404) : TOOL_OK(msg)) });
  const result = await client.callTool('read_file', { path: '/x' });
  assert.equal(result.kind, 'ok');
  assert.equal(sends.initialize, 2, 'a stale session must be re-initialized exactly once');
  assert.equal(sends['tools/call'], 2, 'the tool call is resent once after a confirmed pre-dispatch 404');
});

await test('client: an unconfirmed 404 is NOT resent', async () => {
  const { sends, client } = fakeEdge({ onToolCall: (n, msg) => (n === 1 ? json({ error: 'not found' }, 404) : TOOL_OK(msg)) });
  const result = await client.callTool('write_file', { path: '/x', content: 'y' });
  assert.equal(sends['tools/call'], 1, 'a 404 not confirmed as a stale session must not be resent');
  assert.equal(sends.initialize, 1);
  assert.equal(result.code, 'edge_http_404');
});

await test('client: 404-then-5xx sends tools/call at most twice (was up to 6)', async () => {
  const { sends, client } = fakeEdge({ onToolCall: (n) => (n === 1 ? json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } }, 404) : json({ error: 'server' }, 503)) });
  const result = await client.callTool('start_process', { command: 'x' });
  assert.equal(sends['tools/call'], 2, 'the post-reinit resend must not itself retry on 5xx');
  assert.equal(result.code, 'edge_http_503');
});

await test('client: idempotent initialize / tools/list still retry on 5xx and network errors', async () => {
  {
    const { sends, client } = fakeEdge({ onInit: (n, msg) => (n < 3 ? json({ error: 'server' }, 503) : INIT_OK(msg)), onList: (n, msg) => (n < 3 ? json({ error: 'server' }, 503) : json({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'a' }] } })) });
    const tools = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(sends.initialize, 3, 'initialize is retried on 5xx');
    assert.equal(sends['tools/list'], 3, 'tools/list is retried on 5xx');
  }
  {
    const { sends, client } = fakeEdge({ onInit: (n, msg) => { if (n < 2) throw new DOMException('timeout', 'TimeoutError'); return INIT_OK(msg); }, onList: (n, msg) => { if (n < 2) throw connError('ECONNRESET'); return json({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }); } });
    await client.listTools();
    assert.equal(sends.initialize, 2, 'initialize is retried on timeout');
    assert.equal(sends['tools/list'], 2, 'tools/list is retried on an ambiguous network error');
  }
});

// ---------------------------------------------------------------------------
// D. OAuth discovery timeout
// ---------------------------------------------------------------------------
await test('discover: every fetch carries an abort signal (bounded)', async () => {
  const signals = [];
  const fake = async (url, init) => {
    signals.push(init?.signal);
    if (url.includes('oauth-protected-resource')) return json({ resource: 'https://edge.test/jc/mcp', authorization_servers: ['https://as.test'] });
    return json({ authorization_endpoint: 'https://as.test/auth', token_endpoint: 'https://as.test/token', registration_endpoint: 'https://as.test/reg' });
  };
  await discover('https://edge.test/jc/mcp', fake);
  assert.equal(signals.length, 2);
  for (const s of signals) assert.ok(s instanceof AbortSignal, 'every discovery fetch must carry an abort signal');
});

console.log(`\njace-commander resilience: ${passed} passed`);
fs.rmSync(tmpRoot, { recursive: true, force: true });
