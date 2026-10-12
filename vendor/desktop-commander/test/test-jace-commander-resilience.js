#!/usr/bin/env node
/**
 * Jace Commander auth/reliability hardening regressions:
 *  A. FileNonceStore lazy expiry (O(1) replay check, amortized sweep, cap)
 *  B. single-flight token refresh (mcp-auth + device-login)
 *  C. McpHttpClient bounded retry on transient 5xx + session re-init on 404
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
await test('client: a transient 5xx is retried and the call still succeeds', async () => {
  let calls = 0;
  const fake = async (_url, init) => {
    const msg = JSON.parse(init.body);
    if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } });
    if (msg.method === 'notifications/initialized') return new Response('', { status: 202 });
    if (msg.method === 'tools/call') {
      calls += 1;
      if (calls < 3) return json({ error: 'server' }, 503);
      return json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } });
    }
    return new Response('', { status: 200 });
  };
  const client = new McpHttpClient({ url: 'http://edge.test/jc/mcp', token: async () => 't', fetchImpl: fake });
  const result = await client.callTool('read_file', { path: '/x' });
  assert.equal(result.kind, 'ok');
  assert.equal(calls, 3, 'transient 5xx must be retried up to the attempt bound');
});

await test('client: a stale 404 triggers exactly one session re-init then succeeds', async () => {
  let inits = 0;
  let calls = 0;
  const fake = async (_url, init) => {
    const msg = JSON.parse(init.body);
    if (msg.method === 'initialize') { inits += 1; return json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } }); }
    if (msg.method === 'notifications/initialized') return new Response('', { status: 202 });
    if (msg.method === 'tools/call') {
      calls += 1;
      if (calls === 1) return json({ error: 'not found' }, 404);
      return json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } });
    }
    return new Response('', { status: 200 });
  };
  const client = new McpHttpClient({ url: 'http://edge.test/jc/mcp', token: async () => 't', fetchImpl: fake });
  const result = await client.callTool('read_file', { path: '/x' });
  assert.equal(result.kind, 'ok');
  assert.equal(inits, 2, 'a stale session must be re-initialized exactly once');
  assert.equal(calls, 2, 'the tool call must be retried once after re-init');
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
