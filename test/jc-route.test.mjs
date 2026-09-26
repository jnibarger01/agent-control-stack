#!/usr/bin/env node
/**
 * /jc/mcp (Jace Commander) route tests.
 *
 * Topology: test -> gateway (server.js, managed) -> bridge.js BRIDGE_VARIANT=jc
 * -> stub-jc.mjs `serve`, with a mock ACS and a mock DC bridge on /mcp.
 *
 * Proves:
 *  - OAuth: /jc/mcp is a separate protected resource (own metadata, own
 *    audience); tokens never cross between /mcp and /jc/mcp
 *  - tools/call jc_status reaches jace-commander carrying the ACS-issued
 *    acs.jc.v1 envelope at params._meta.acsCapability, requested from
 *    POST /jc/capability/issue with the JC worker token
 *  - spoofed client _meta.acs* / capability keys are stripped
 *  - ACS deny / unreachable / wrong-audience envelope -> 503, nothing forwarded
 *  - a DC capability never reaches /jc/mcp and a JC capability never reaches /mcp
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SIGNING_KEY = 'b'.repeat(32);
const EXEC_TOKEN = 'jc-test-execution-token';
const ORIGIN = 'https://gw.test';
const DC_RESOURCE = `${ORIGIN}/mcp`;
const JC_RESOURCE = `${ORIGIN}/jc/mcp`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

function tokenFor(aud, sub = 'chatgpt-user') {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ iss: ORIGIN, sub, client_id: 'c1', aud, scope: 'mcp', iat: now(), exp: now() + 600, jti: crypto.randomUUID() }));
  const sig = crypto.createHmac('sha256', SIGNING_KEY).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

function startProc(script, env, label) {
  const child = spawn(process.execPath, [script], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.label = label;
  child.buf = () => out;
  return child;
}

async function waitHealthy(url, proc, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${url}/healthz`)).ok) return; } catch { /* not up yet */ }
    if (proc.exitCode !== null) throw new Error(`${proc.label} exited early:\n${proc.buf()}`);
    await sleep(100);
  }
  throw new Error(`${proc.label} never became healthy:\n${proc.buf()}`);
}

function sseJson(text) {
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) { try { return JSON.parse(line.slice(5).trim()); } catch { /* next */ } }
  }
  try { return JSON.parse(text); } catch { return null; }
}

// --- mock ACS: records path/headers/body; behavior is switchable per test ---
const acsCalls = [];
let acsBehavior = null;
function jcEnvelope(toolName, args = {}) {
  return {
    payload: { version: 'acs.jc.v1', audience: 'jace-commander', toolName, runtimeId: 'jc-test', nonce: crypto.randomUUID(), normalizedArguments: args },
    signature: `jc-sig-${crypto.randomUUID()}`,
    keyId: 'jc-key-1',
  };
}
function dcEnvelope(toolName, args = {}) {
  return {
    payload: { version: 'acs.dc.v1', audience: 'desktop-commander', toolName, normalizedArguments: args },
    signature: `dc-sig-${crypto.randomUUID()}`,
    keyId: 'dc-key-1',
  };
}
function defaultAcs(call) {
  const envelope = call.path === '/jc/capability/issue' ? jcEnvelope(call.body.tool) : dcEnvelope(call.body.tool, { command: 'ls' });
  return { status: 200, json: { decision: 'allow', capability: envelope, claimActionHash: 'claim', inputHash: 'input', workerId: 'w' } };
}
const acs = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const call = { path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') };
    acsCalls.push(call);
    const { status, json } = (acsBehavior || defaultAcs)(call);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(json));
  });
});

// --- mock DC bridge on /mcp: records forwarded bodies ---
const dcUpstreamBodies = [];
let dcAuthority = { variant: 'dc' };
const dcUpstream = http.createServer((req, res) => {
  if (req.url === '/authority') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(dcAuthority)); return; }
  if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    dcUpstreamBodies.push(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
  });
});

const JC_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-route-state-'));
let gwPort; let jcPort; let bridge; let gateway;
let jcSession = null;

function jcReceived() {
  try {
    return fs.readFileSync(path.join(JC_STATE, 'received.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
const jcToolCalls = () => jcReceived().filter((m) => m.method === 'tools/call');

async function gw(pathname, { token, body, session, method = 'POST' } = {}) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (session) headers['mcp-session-id'] = session;
  const r = await fetch(`http://127.0.0.1:${gwPort}${pathname}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, headers: r.headers, text: await r.text() };
}

async function jcInitialize() {
  const token = tokenFor(JC_RESOURCE);
  const init = await gw('/jc/mcp', { token, body: { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } } });
  assert.equal(init.status, 200, init.text);
  const session = init.headers.get('mcp-session-id');
  assert.ok(session, 'bridge assigned a session');
  assert.equal(sseJson(init.text).result.serverInfo.name, 'jace-commander');
  const note = await gw('/jc/mcp', { token, session, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  assert.ok(note.status === 202 || note.status === 200, note.text);
  return { token, session };
}

before(async () => {
  const acsPort = await listen(acs);
  const dcPort = await listen(dcUpstream);
  jcPort = await freePort();
  gwPort = await freePort();
  bridge = startProc('bridge.js', {
    BRIDGE_VARIANT: 'jc', BRIDGE_PORT: String(jcPort), ACS_MANAGED_MODE: '1',
    JC_CMD: process.execPath, JC_ENTRY: path.join(ROOT, 'test/stub-jc.mjs'), JC_DC_DIR: ROOT,
    JC_ACS_PUBLIC_KEY: 'test-public-key', JC_ACS_KEY_ID: 'jc-key-1', JC_RUNTIME_ID: 'jc-test', JC_STATE_DIR: JC_STATE,
    DC_GATEWAY_EXECUTION_TOKEN: EXEC_TOKEN,
    // Must never reach the jc child.
    ACS_DC_PUBLIC_KEY: 'dc-public-key', ACS_DC_KEY_ID: 'dc-key-1', DC_GATEWAY_ATTESTATION_KEY: 'dc-hmac',
  }, 'jc-bridge');
  await waitHealthy(`http://127.0.0.1:${jcPort}`, bridge);
  gateway = startProc('server.js', {
    GATEWAY_PORT: String(gwPort), PUBLIC_ORIGIN: ORIGIN, CONSENT_PASSPHRASE: 'pass', SIGNING_KEY,
    GATEWAY_EXECUTION_TOKEN: EXEC_TOKEN,
    ACS_MANAGED_MODE: '1', ACS_GATEWAY_URL: `http://127.0.0.1:${acsPort}`, ACS_GATEWAY_TOKEN: 'dc-svc-token',
    ACS_JC_GATEWAY_TOKEN: 'jc-svc-token',
    UPSTREAM: `http://127.0.0.1:${dcPort}`, JC_UPSTREAM: `http://127.0.0.1:${jcPort}`,
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'jc-route-data-')),
  }, 'gateway');
  await waitHealthy(`http://127.0.0.1:${gwPort}`, gateway);
  jcSession = await jcInitialize();
});

after(() => {
  bridge?.kill('SIGKILL'); gateway?.kill('SIGKILL');
  acs.close(); dcUpstream.close();
  fs.rmSync(JC_STATE, { recursive: true, force: true });
});

const reset = () => { acsCalls.length = 0; dcUpstreamBodies.length = 0; acsBehavior = null; };
const jcCall = (id, meta) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'jc_status', arguments: {}, ...(meta ? { _meta: meta } : {}) } });

test('jc bridge spawns `cli.js serve` (never --standalone) with only JC_* child env', () => {
  const { argv, env, runtimeId } = JSON.parse(fs.readFileSync(path.join(JC_STATE, 'argv.json'), 'utf8'));
  assert.deepEqual(argv, ['serve']);
  assert.equal(runtimeId, 'jc-test');
  assert.deepEqual(env, ['JC_ACS_KEY_ID', 'JC_ACS_PUBLIC_KEY', 'JC_RUNTIME_ID', 'JC_STATE_DIR']);
});

test('protected-resource metadata advertises /jc/mcp separately', async () => {
  const dc = JSON.parse((await gw('/.well-known/oauth-protected-resource', { method: 'GET' })).text);
  const jc = JSON.parse((await gw('/.well-known/oauth-protected-resource/jc/mcp', { method: 'GET' })).text);
  assert.equal(dc.resource, DC_RESOURCE);
  assert.equal(jc.resource, JC_RESOURCE);
  assert.deepEqual(jc.authorization_servers, [ORIGIN]);
  const as = await gw('/.well-known/oauth-authorization-server/jc/mcp', { method: 'GET' });
  assert.equal(JSON.parse(as.text).issuer, ORIGIN);
});

test('tokens are audience-bound: /mcp token rejected on /jc/mcp and vice versa', async () => {
  reset();
  const noAuth = await gw('/jc/mcp', { body: jcCall(1) });
  assert.equal(noAuth.status, 401);
  assert.match(noAuth.headers.get('www-authenticate'), /oauth-protected-resource\/jc\/mcp"/);
  const dcTokenOnJc = await gw('/jc/mcp', { token: tokenFor(DC_RESOURCE), session: jcSession.session, body: jcCall(2) });
  assert.equal(dcTokenOnJc.status, 401);
  const jcTokenOnDc = await gw('/mcp', { token: tokenFor(JC_RESOURCE), body: jcCall(3) });
  assert.equal(jcTokenOnDc.status, 401);
  assert.equal(acsCalls.length, 0);
  assert.equal(dcUpstreamBodies.length, 0);
});

test('OAuth consent flow issues a /jc/mcp-bound token; unknown resources are refused', async () => {
  const reg = await fetch(`http://127.0.0.1:${gwPort}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://client.test/cb'], client_name: 'jc-test' }),
  });
  const { client_id } = await reg.json();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
  const q = (resource) => new URLSearchParams({ client_id, redirect_uri: 'https://client.test/cb', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp', state: 's', resource }).toString();
  const bad = await fetch(`http://127.0.0.1:${gwPort}/authorize?${q('https://evil.test/mcp')}`, { redirect: 'manual' });
  assert.equal(bad.status, 302);
  assert.match(bad.headers.get('location'), /error=invalid_target/);
  const page = await fetch(`http://127.0.0.1:${gwPort}/authorize?${q(JC_RESOURCE)}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Jace Commander access/);
  const consent = await fetch(`http://127.0.0.1:${gwPort}/authorize/consent`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id, redirect_uri: 'https://client.test/cb', scope: 'mcp', state: 's', code_challenge: challenge, resource: JC_RESOURCE, passphrase: 'pass' }).toString(),
  });
  assert.equal(consent.status, 302);
  const code = new URL(consent.headers.get('location')).searchParams.get('code');
  const tok = await fetch(`http://127.0.0.1:${gwPort}/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: 'https://client.test/cb', client_id }).toString(),
  });
  const { access_token } = await tok.json();
  const payload = JSON.parse(Buffer.from(access_token.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(payload.aud, JC_RESOURCE);
  const forged = await fetch(`http://127.0.0.1:${gwPort}/authorize/consent`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id, redirect_uri: 'https://client.test/cb', code_challenge: challenge, resource: 'https://evil.test/mcp', passphrase: 'pass' }).toString(),
  });
  assert.equal(forged.status, 400);
});

test('tools/call jc_status reaches jace-commander with the injected acs.jc.v1 capability; spoofed meta stripped', async () => {
  reset();
  const before = jcToolCalls().length;
  const spoofedDc = dcEnvelope('jc_status');
  const r = await gw('/jc/mcp', {
    token: jcSession.token, session: jcSession.session,
    body: jcCall(10, {
      capability: spoofedDc,
      acsCapability: { payload: { version: 'acs.jc.v1', audience: 'jace-commander', forged: true }, signature: 'forged', keyId: 'forged' },
      acsLeaseBinding: { forged: true },
      acsWhatever: 1,
      progressToken: 'keep-me',
    }),
  });
  assert.equal(r.status, 200, r.text);
  const reply = sseJson(r.text);
  assert.equal(reply.result.isError, undefined, r.text);
  assert.equal(reply.result._meta.acsAuthorization.decision, 'granted');

  // ACS: exactly one issuance, on the JC route, with the JC worker identity.
  assert.equal(acsCalls.length, 1);
  assert.equal(acsCalls[0].path, '/jc/capability/issue');
  assert.equal(acsCalls[0].headers.authorization, 'Bearer jc-svc-token');
  assert.equal(acsCalls[0].headers['x-jc-actor'], 'chatgpt:chatgpt-user');
  assert.equal(acsCalls[0].body.tool, 'jc_status');
  assert.equal(acsCalls[0].body.client_id, 'c1');
  assert.equal(acsCalls[0].body.argsSummary, '{}');

  const calls = jcToolCalls().slice(before);
  assert.equal(calls.length, 1);
  const meta = calls[0].params._meta;
  assert.equal(meta.acsCapability.payload.version, 'acs.jc.v1');
  assert.equal(meta.acsCapability.payload.audience, 'jace-commander');
  assert.match(meta.acsCapability.signature, /^jc-sig-/);
  assert.equal(meta.acsCapability.payload.forged, undefined);
  assert.equal(meta.capability, undefined, 'DC pipeline key never set on /jc/mcp');
  assert.equal(meta.acsWhatever, undefined);
  assert.equal(meta.acsLeaseBinding.forged, undefined);
  assert.equal(meta.acsLeaseBinding.claimActionHash, 'claim');
  assert.equal(meta.progressToken, 'keep-me');
  // Same identity attestation as /mcp: the bridge verified the gateway HMAC.
  assert.equal(meta.gateway.verified, true);
  assert.equal(meta.gateway.sub, 'chatgpt-user');
  assert.equal(meta.transport, 'oauth-gateway');
  assert.equal(dcUpstreamBodies.length, 0, 'nothing reached the DC bridge');
});

for (const [name, behavior, code] of [
  ['ACS deny', () => ({ status: 403, json: { decision: 'deny', reason: 'unknown_tool' } }), 'unknown_tool'],
  ['ACS require_approval', () => ({ status: 409, json: { decision: 'require_approval', workItemId: 'wrk_1', actionHash: 'h' } }), 'require_approval'],
  ['ACS HTTP 500', () => ({ status: 500, json: null }), 'acs_http_500'],
  ['malformed envelope', () => ({ status: 200, json: { decision: 'allow', capability: { payload: {}, signature: '', keyId: 'k' } } }), 'acs_malformed_capability'],
  ['DC capability returned on the JC route', (c) => ({ status: 200, json: { decision: 'allow', capability: dcEnvelope(c.body.tool) } }), 'acs_capability_wrong_audience'],
]) {
  test(`/jc/mcp fails closed (503, nothing forwarded) on: ${name}`, async () => {
    reset();
    acsBehavior = behavior;
    const before = jcToolCalls().length;
    const r = await gw('/jc/mcp', { token: jcSession.token, session: jcSession.session, body: jcCall(20) });
    assert.equal(r.status, 503, r.text);
    assert.equal(JSON.parse(r.text).code, code);
    assert.equal(acsCalls.length, 1);
    assert.equal(acsCalls[0].path, '/jc/capability/issue');
    assert.equal(jcToolCalls().length, before, 'jace-commander received nothing');
    assert.equal(dcUpstreamBodies.length, 0);
  });
}

test('/mcp never forwards a JC capability, and only asks the DC issuer with the DC token', async () => {
  reset();
  acsBehavior = (c) => ({ status: 200, json: { decision: 'allow', capability: jcEnvelope(c.body.tool, { command: 'ls' }) } });
  const denied = await gw('/mcp', { token: tokenFor(DC_RESOURCE), body: { jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'start_process', arguments: { command: 'ls', cwd: '/tmp' } } } });
  assert.equal(denied.status, 503, denied.text);
  assert.equal(JSON.parse(denied.text).code, 'acs_capability_wrong_audience');
  assert.equal(dcUpstreamBodies.length, 0);

  reset();
  const before = jcToolCalls().length;
  const ok = await gw('/mcp', { token: tokenFor(DC_RESOURCE), body: { jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'start_process', arguments: { command: 'ls', cwd: '/tmp' } } } });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(acsCalls.map((c) => c.path), ['/dc/capability/issue']);
  assert.equal(acsCalls[0].headers.authorization, 'Bearer dc-svc-token');
  assert.equal(acsCalls[0].headers['x-dc-actor'], 'chatgpt:chatgpt-user');
  assert.equal(dcUpstreamBodies.length, 1);
  assert.equal(JSON.parse(dcUpstreamBodies[0]).params._meta.acsCapability.payload.audience, 'desktop-commander');
  assert.equal(jcToolCalls().length, before, 'jace-commander received nothing from /mcp');
});

test('/mcp refuses an upstream that identifies as the jc bridge', async () => {
  reset();
  dcAuthority = { variant: 'jc' };
  try {
    const r = await gw('/mcp', { token: tokenFor(DC_RESOURCE), body: { jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'start_process', arguments: { command: 'ls' } } } });
    assert.equal(r.status, 503);
    assert.equal(JSON.parse(r.text).code, 'dc_bridge_mismatch');
    assert.equal(acsCalls.length, 0);
    assert.equal(dcUpstreamBodies.length, 0);
  } finally {
    dcAuthority = { variant: 'dc' };
  }
});

test('/authority and /ready report the jc bridge', async () => {
  const authority = JSON.parse((await gw('/authority', { method: 'GET' })).text);
  assert.equal(authority.jcBridge.variant, 'jc');
  assert.equal(authority.jcBridge.childMode, 'managed');
  assert.equal(authority.jcBridge.bridge.initialized, true);
  const ready = JSON.parse((await gw('/ready', { method: 'GET' })).text);
  assert.equal(ready.jcBridgeReady, true);
});

test('/jc/mcp fails closed when its upstream is not the jc bridge', async () => {
  const acsPort = acs.address().port;
  const port = await freePort();
  const g = startProc('server.js', {
    GATEWAY_PORT: String(port), PUBLIC_ORIGIN: ORIGIN, CONSENT_PASSPHRASE: 'pass', SIGNING_KEY,
    ACS_MANAGED_MODE: '1', ACS_GATEWAY_URL: `http://127.0.0.1:${acsPort}`, ACS_GATEWAY_TOKEN: 'dc-svc-token',
    ACS_JC_GATEWAY_TOKEN: 'jc-svc-token',
    UPSTREAM: `http://127.0.0.1:${dcUpstream.address().port}`,
    JC_UPSTREAM: `http://127.0.0.1:${dcUpstream.address().port}`, // misconfigured: points at DC
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'jc-route-data-')),
  }, 'gateway-miswired');
  try {
    await waitHealthy(`http://127.0.0.1:${port}`, g);
    reset();
    const r = await fetch(`http://127.0.0.1:${port}/jc/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor(JC_RESOURCE)}`, 'content-type': 'application/json' },
      body: JSON.stringify(jcCall(50)),
    });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).code, 'jc_bridge_mismatch');
    assert.equal(acsCalls.length, 0);
    assert.equal(dcUpstreamBodies.length, 0);
  } finally {
    g.kill('SIGKILL');
  }
});

test('/jc/mcp fails closed (503, nothing forwarded) when ACS is unreachable', async () => {
  const port = await freePort();
  const g = startProc('server.js', {
    GATEWAY_PORT: String(port), PUBLIC_ORIGIN: ORIGIN, CONSENT_PASSPHRASE: 'pass', SIGNING_KEY,
    ACS_MANAGED_MODE: '1', ACS_GATEWAY_URL: 'http://127.0.0.1:9', ACS_GATEWAY_TOKEN: 'dc-svc-token',
    ACS_JC_GATEWAY_TOKEN: 'jc-svc-token',
    UPSTREAM: `http://127.0.0.1:${dcUpstream.address().port}`, JC_UPSTREAM: `http://127.0.0.1:${jcPort}`,
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'jc-route-data-')),
  }, 'gateway-no-acs');
  try {
    await waitHealthy(`http://127.0.0.1:${port}`, g);
    const before = jcToolCalls().length;
    const r = await fetch(`http://127.0.0.1:${port}/jc/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jcSession.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': jcSession.session },
      body: JSON.stringify(jcCall(60)),
    });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, 'managed_authorization_unavailable');
    assert.equal(jcToolCalls().length, before);
  } finally {
    g.kill('SIGKILL');
  }
});

test('managed gateway with JC_UPSTREAM refuses to start without a distinct ACS_JC_GATEWAY_TOKEN', async () => {
  const { managedModeFromEnv } = await import('../managed.js');
  const base = { ACS_MANAGED_MODE: '1', ACS_GATEWAY_URL: 'http://127.0.0.1:1', ACS_GATEWAY_TOKEN: 't', JC_UPSTREAM: 'http://127.0.0.1:2' };
  assert.throws(() => managedModeFromEnv(base), /requires ACS_JC_GATEWAY_TOKEN/);
  assert.throws(() => managedModeFromEnv({ ...base, ACS_JC_GATEWAY_TOKEN: 't' }), /must differ/);
  assert.equal(managedModeFromEnv({ ...base, ACS_JC_GATEWAY_TOKEN: 'u' }).jc.acsGatewayToken, 'u');
  assert.equal(managedModeFromEnv({ ...base, JC_UPSTREAM: '' }).jc, null);
});

test('jc bridge refuses to start managed without JC keys or with DC_* executor overrides', () => {
  const run = (env) => spawnSync(process.execPath, ['bridge.js'], {
    cwd: ROOT, encoding: 'utf8', timeout: 5000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, BRIDGE_VARIANT: 'jc', BRIDGE_PORT: '1', ACS_MANAGED_MODE: '1', JC_ENTRY: path.join(ROOT, 'test/stub-jc.mjs'), ...env },
  });
  const noKeys = run({});
  assert.notEqual(noKeys.status, 0);
  assert.match(noKeys.stderr, /requires JC_ACS_PUBLIC_KEY, JC_ACS_KEY_ID and JC_RUNTIME_ID/);
  const override = run({ JC_ACS_PUBLIC_KEY: 'k', JC_ACS_KEY_ID: 'i', JC_RUNTIME_ID: 'r', DC_ARGS: '/x/cli.js serve --standalone' });
  assert.notEqual(override.status, 0);
  assert.match(override.stderr, /DC_\* executor overrides are not valid for the jc variant/);
  const unknown = run({ BRIDGE_VARIANT: 'nope' });
  assert.match(unknown.stderr, /unknown BRIDGE_VARIANT/);
});
