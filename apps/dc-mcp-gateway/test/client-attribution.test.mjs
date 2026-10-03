#!/usr/bin/env node
/**
 * Client attribution on the managed edge lanes.
 *
 * Proves:
 *  - sanitising: self-declared claims are bounded printable ASCII
 *  - an `initialize` is reported to ACS (/mcp-clients/observe) with the VERIFIED client_id/sub and the
 *    claimed clientInfo + User-Agent, using the lane's own bridge credential
 *  - reports are throttled per client+method; tools/list is also reported; tools/call is not (ACS already
 *    records issuance)
 *  - the cached clientInfo rides along on a later tools/call to ACS issuance as x-mcp-* headers
 *  - observation can never delay, alter or fail a request: ACS returning 500 / hanging still proxies it
 *
 * Run: node --test test/client-attribution.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { identityAttribution } from '../managed.js';
import { ClientInfoCache, claimHeaders, clientIdForAcs, createClientObserver, extractClientInfo, sanitizeClaim } from '../client-attribution.js';
import { capabilityTransport } from '../managed.js';

const KEY = 'k'.repeat(32);
const ORIGIN = 'https://gw.test';
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

function token(aud, clientId = 'client-muse') {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ iss: ORIGIN, sub: 'jacen', client_id: clientId, aud, scope: 'mcp', iat: now(), exp: now() + 600, jti: crypto.randomUUID() }));
  return `${h}.${p}.${crypto.createHmac('sha256', KEY).update(`${h}.${p}`).digest('base64url')}`;
}

test('claims are bounded printable ASCII and clientInfo is read only from initialize', () => {
  assert.equal(sanitizeClaim('Mu\u0000se\u001b[1m'), 'Muse[1m');
  assert.equal(sanitizeClaim('x'.repeat(500)).length, 128);
  assert.equal(sanitizeClaim(42), undefined);
  assert.equal(sanitizeClaim('   '), undefined);
  assert.deepEqual(extractClientInfo({ method: 'initialize', params: { clientInfo: { name: 'Muse', version: '1.2', evil: 'x' } } }), { name: 'Muse', version: '1.2' });
  assert.equal(extractClientInfo({ method: 'tools/call', params: { clientInfo: { name: 'Muse' } } }), undefined);
  assert.equal(extractClientInfo([{ method: 'initialize' }]), undefined);
  assert.equal(extractClientInfo(null), undefined);
  assert.deepEqual(claimHeaders({ name: 'Muse', version: '1', userAgent: 'UA/1' }), { 'x-mcp-client-name': 'Muse', 'x-mcp-client-version': '1', 'x-mcp-user-agent': 'UA/1' });
  assert.deepEqual(claimHeaders(undefined), {});
});

test('a verified client id longer than 256 characters is digested, never truncated', () => {
  assert.equal(clientIdForAcs('client-short'), 'client-short');
  const base = 'https://clients.example/' + 'a'.repeat(240);
  const exactly256 = base.slice(0, 256);
  assert.equal(clientIdForAcs(exactly256), exactly256);
  // Two different ids that share their first 256 characters must stay different.
  const one = exactly256 + '-one';
  const two = exactly256 + '-two';
  const a = clientIdForAcs(one);
  const b = clientIdForAcs(two);
  assert.notEqual(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  assert.ok(a.length <= 256);
  assert.equal(clientIdForAcs(one), a, 'stable for the same id');
  assert.equal(clientIdForAcs(''), null);
  assert.equal(clientIdForAcs(42), null);
  assert.equal(identityAttribution({ sub: 's', client_id: one }).clientId, a);
  assert.equal(identityAttribution({ sub: 's', client_id: 'plain' }).clientId, 'plain');
});

test('the client info cache is bounded and expires', () => {
  let t = 1000;
  const cache = new ClientInfoCache({ max: 2, ttlMs: 100, now: () => t });
  cache.set('a', { name: 'A' });
  cache.set('b', { name: 'B' });
  cache.set('c', { name: 'C' });
  assert.equal(cache.get('a'), undefined);
  assert.deepEqual(cache.get('c'), { name: 'C' });
  t += 101;
  assert.equal(cache.get('c'), undefined);
});

test('the observer throttles, ignores other methods and never throws', async () => {
  let t = 0;
  const sent = [];
  const observer = createClientObserver({ post: async (path, body) => { sent.push({ path, body }); return { status: 202 }; }, throttleMs: 1000, now: () => t });
  const identity = { clientId: 'c1', subject: 's1' };
  assert.equal(await observer.observe({ lane: 'jc', identity, method: 'initialize', claims: { name: 'Muse', junk: 'x' } }), true);
  assert.equal(await observer.observe({ lane: 'jc', identity, method: 'initialize' }), false);
  assert.equal(await observer.observe({ lane: 'jc', identity, method: 'tools/call' }), false);
  assert.equal(await observer.observe({ lane: 'jc', identity: { clientId: '', subject: 's' }, method: 'initialize' }), false);
  t = 1500;
  assert.equal(await observer.observe({ lane: 'jc', identity, method: 'initialize' }), true);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], { path: '/mcp-clients/observe', body: { lane: 'jc', clientId: 'c1', subject: 's1', method: 'initialize', claims: { name: 'Muse' } } });

  const failing = createClientObserver({ post: async () => { throw new Error('boom'); }, now: () => t, onError: () => { throw new Error('onError must not escape'); } });
  assert.equal(await failing.observe({ lane: 'dc', identity, method: 'initialize' }), false);
  const rejected = createClientObserver({ post: async () => ({ status: 500 }), now: () => t });
  assert.equal(await rejected.observe({ lane: 'dc', identity, method: 'initialize' }), false);
  assert.equal(rejected.stats.failed, 1);
  const hanging = createClientObserver({ post: () => new Promise(() => {}), timeoutMs: 50, now: () => t });
  const started = Date.now();
  assert.equal(await hanging.observe({ lane: 'dc', identity, method: 'initialize' }), false);
  assert.ok(Date.now() - started < 1000);
});

function recorder(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      requests.push({ path: req.url, headers: req.headers, body: text ? JSON.parse(text) : null });
      const { status, body } = handler(requests.at(-1));
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return { server, requests, listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))) };
}

const allow = (req) => ({
  status: 200,
  body: {
    decision: 'allow',
    capability: { payload: { version: 'acs.jc.v1', audience: 'jace-commander', toolName: req.body.tool, normalizedArguments: JSON.parse(req.body.argsSummary) }, signature: 'sig', keyId: 'k1' },
    claimActionHash: 'claim', inputHash: 'input', workerId: 'acs-jc-bridge',
  },
});

test('capabilityTransport forwards claims to ACS issuance as unverified headers', async () => {
  const acs = recorder(allow);
  const port = await acs.listen();
  try {
    const managed = { enabled: true, acsGatewayUrl: `http://127.0.0.1:${port}`, acsGatewayToken: 'jc-bridge-token', issuePath: '/jc/capability/issue', timeoutMs: 2000 };
    const rewrite = capabilityTransport(managed, { identity: { subject: 'jacen', clientId: 'client-muse', claims: { name: 'Muse', version: '2', userAgent: 'Muse/2 (Linux)' } }, requestId: 'r1' });
    await rewrite({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'acs_read', arguments: { view: 'health' } } });
    const seen = acs.requests[0];
    assert.equal(seen.path, '/jc/capability/issue');
    assert.equal(seen.headers['x-jc-actor'], 'chatgpt:jacen');
    assert.equal(seen.headers['x-mcp-client-name'], 'Muse');
    assert.equal(seen.headers['x-mcp-client-version'], '2');
    assert.equal(seen.headers['x-mcp-user-agent'], 'Muse/2 (Linux)');
    assert.equal(seen.body.client_id, 'client-muse');
    // No claims: no claim headers, same behaviour as before.
    const bare = capabilityTransport(managed, { identity: { subject: 'jacen', clientId: 'client-muse' }, requestId: 'r2' });
    await bare({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'acs_read', arguments: { view: 'health' } } });
    assert.equal(acs.requests[1].headers['x-mcp-client-name'], undefined);
  } finally { acs.server.close(); }
});

let nextPort = 18700;
async function startGateway(env) {
  const port = nextPort++;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { PATH: process.env.PATH, GATEWAY_PORT: String(port), PUBLIC_ORIGIN: ORIGIN, CONSENT_PASSPHRASE: 'pass-phrase', SIGNING_KEY: KEY, DATA_DIR: `/tmp/attr-gw-${port}-${process.pid}`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  for (let i = 0; i < 50; i += 1) {
    if (child.exitCode !== null) return { port, child, exitCode: child.exitCode, stderr };
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return { port, child, stderr: () => stderr }; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { port, child, exitCode: null, stderr };
}

async function lane(acsHandler) {
  const acs = recorder(acsHandler);
  const dcUp = recorder(() => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: { lane: 'dc' } } }));
  const jcUp = recorder((req) => (req.path === '/authority' ? { status: 200, body: { variant: 'jc' } } : { status: 200, body: { jsonrpc: '2.0', id: 1, result: { lane: 'jc' } } }));
  const [acsPort, dcPort, jcPort] = [await acs.listen(), await dcUp.listen(), await jcUp.listen()];
  const gw = await startGateway({
    UPSTREAM: `http://127.0.0.1:${dcPort}`, JC_ENABLED: '1', JC_UPSTREAM: `http://127.0.0.1:${jcPort}`,
    ACS_GATEWAY_URL: `http://127.0.0.1:${acsPort}`, ACS_JC_GATEWAY_TOKEN: 'jc-bridge-token',
  });
  assert.equal(gw.exitCode, undefined, `gateway failed to start: ${typeof gw.stderr === 'function' ? gw.stderr() : gw.stderr}`);
  return { gw, acs, jcUp, close: () => { gw.child.kill('SIGKILL'); acs.server.close(); dcUp.server.close(); jcUp.server.close(); } };
}

const post = (port, bearer, body, headers = {}) => fetch(`http://127.0.0.1:${port}/jc/mcp`, {
  method: 'POST',
  headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify(body),
});
const observes = (acs) => acs.requests.filter((r) => r.path === '/mcp-clients/observe');
const settle = () => new Promise((r) => setTimeout(r, 300));

test('end to end: initialize is reported to ACS, throttled, and its clientInfo rides the next tools/call', async () => {
  const { gw, acs, jcUp, close } = await lane((req) => (req.path === '/mcp-clients/observe' ? { status: 202, body: { recorded: true } } : allow(req)));
  try {
    const bearer = token(`${ORIGIN}/jc/mcp`);
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'Muse', version: '1.4' }, capabilities: {} } };
    const first = await post(gw.port, bearer, init, { 'user-agent': 'Muse/1.4 (Linux)' });
    assert.equal(first.status, 200);
    await settle();
    assert.equal(observes(acs).length, 1);
    const seen = observes(acs)[0];
    assert.equal(seen.headers.authorization, 'Bearer jc-bridge-token');
    assert.deepEqual(seen.body, { lane: 'jc', clientId: 'client-muse', subject: 'jacen', method: 'initialize', claims: { name: 'Muse', version: '1.4', userAgent: 'Muse/1.4 (Linux)' } });

    await post(gw.port, bearer, { ...init, id: 2 });
    await settle();
    assert.equal(observes(acs).length, 1, 'a repeat inside the throttle window is not reported again');

    await post(gw.port, bearer, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
    await settle();
    assert.equal(observes(acs).length, 2);
    assert.equal(observes(acs)[1].body.method, 'tools/list');
    assert.equal(observes(acs)[1].body.claims.name, 'Muse');

    const call = await post(gw.port, bearer, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'acs_read', arguments: { view: 'health' } } }, { 'user-agent': 'Muse/1.4 (Linux)' });
    assert.equal(call.status, 200);
    const issue = acs.requests.find((r) => r.path === '/jc/capability/issue');
    assert.equal(issue.headers['x-jc-actor'], 'chatgpt:jacen');
    assert.equal(issue.headers['x-mcp-client-name'], 'Muse');
    assert.equal(issue.headers['x-mcp-client-version'], '1.4');
    assert.equal(issue.headers['x-mcp-user-agent'], 'Muse/1.4 (Linux)');
    assert.equal(issue.body.client_id, 'client-muse');
    assert.equal(observes(acs).length, 2, 'tools/call is not reported separately');
    assert.ok(jcUp.requests.some((r) => r.path === '/mcp'), 'requests are still proxied upstream');
  } finally { close(); }
});

test('an ACS that errors on observation cannot affect the proxied request', async () => {
  const { gw, acs, jcUp, close } = await lane((req) => (req.path === '/mcp-clients/observe' ? { status: 500, body: { error: 'down' } } : allow(req)));
  try {
    const res = await post(gw.port, token(`${ORIGIN}/jc/mcp`, 'client-grok'), { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'Grok' } } });
    assert.equal(res.status, 200);
    await settle();
    assert.equal(observes(acs).length, 1);
    assert.ok(jcUp.requests.some((r) => r.path === '/mcp'));
    const body = await res.json();
    assert.equal(body.result.lane, 'jc');
  } finally { close(); }
});
