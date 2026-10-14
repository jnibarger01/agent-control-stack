#!/usr/bin/env node
/**
 * ADR 0026 slice 3: the OAuth edge skips ACS capability ISSUANCE only for tools
 * whose effective authorizer is `local`, and fails toward ACS in every doubtful
 * case. Authentication, anti-spoofing and the bridge-identity check are unchanged.
 *
 * Run: node --test test/jc-local-routing.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const KEY = 'k'.repeat(32);
const ORIGIN = 'https://gw.test';
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

function token(aud, iss = ORIGIN) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ iss, sub: 'jacen', client_id: 'c1', aud, scope: 'mcp', iat: now(), exp: now() + 600, jti: crypto.randomUUID() }));
  return `${h}.${p}.${crypto.createHmac('sha256', KEY).update(`${h}.${p}`).digest('base64url')}`;
}

function recorder(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      requests.push({ path: req.url, auth: req.headers.authorization, actor: req.headers['x-dc-actor'], jcActor: req.headers['x-jc-actor'], body: text ? JSON.parse(text) : null });
      const { status, body } = handler(requests.at(-1));
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return { server, requests, listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))) };
}

const allowCapability = (req) => (req.path === '/mcp-clients/observe' ? { status: 202, body: { recorded: true } } : {
  status: 200,
  body: {
    decision: 'allow',
    capability: { payload: { version: 'acs.jc.v1', audience: 'jace-commander', toolName: req.body.tool, normalizedArguments: JSON.parse(req.body.argsSummary) }, signature: 'acs-sig', keyId: 'acs-jc-1' },
    claimActionHash: 'claim', inputHash: 'input', workerId: 'acs-jc-bridge',
  },
});

let nextPort = 19300;
async function startGateway(env) {
  const port = nextPort++;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { PATH: process.env.PATH, GATEWAY_PORT: String(port), PUBLIC_ORIGIN: ORIGIN, CONSENT_PASSPHRASE: 'pass-phrase', SIGNING_KEY: KEY, DATA_DIR: `/tmp/jc-gw-${port}-${process.pid}`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  for (let i = 0; i < 50; i += 1) {
    if (child.exitCode !== null) return { port, child, exitCode: child.exitCode, stderr };
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return { port, child, exited, stderr: () => stderr };
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 500))]);
  return { port, child, exitCode: code, stderr };
}

async function lane({ acsHandler = allowCapability, jcVariant = 'jc', env: extraEnv = {} } = {}) {
  const acs = recorder(acsHandler);
  const dcUp = recorder(() => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: { lane: 'dc' } } }));
  const jcUp = recorder((req) => (req.path === '/authority'
    ? { status: 200, body: { variant: jcVariant } }
    : { status: 200, body: { jsonrpc: '2.0', id: 1, result: { lane: 'jc' } } }));
  const [acsPort, dcPort, jcPort] = [await acs.listen(), await dcUp.listen(), await jcUp.listen()];
  const gw = await startGateway({
    UPSTREAM: `http://127.0.0.1:${dcPort}`,
    JC_ENABLED: '1',
    JC_UPSTREAM: `http://127.0.0.1:${jcPort}`,
    ACS_GATEWAY_URL: `http://127.0.0.1:${acsPort}`,
    ACS_JC_GATEWAY_TOKEN: 'jc-bridge-token',
    ...extraEnv,
  });
  assert.equal(gw.exitCode, undefined, `gateway failed to start: ${typeof gw.stderr === 'function' ? gw.stderr() : gw.stderr}`);
  const close = () => { gw.child.kill('SIGKILL'); acs.server.close(); dcUp.server.close(); jcUp.server.close(); };
  return { gw, acs, dcUp, jcUp, close };
}

const mcpRequests = (rec) => rec.requests.filter((r) => r.path !== '/authority');

const call = (port, path, bearer, body) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: 'POST',
  headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify(body),
});


import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JC_TOOL_PROVIDERS, localRoutingFromEnv, resolveAuthorizer, stripAuthorityMeta } from '../jc-routing.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-edge-'));
const writePolicy = (name, doc) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify({ version: 'jc.policy.v1', ...doc }));
  return file;
};
const issues = (acs) => acs.requests.filter((r) => r.path === '/jc/capability/issue');
const toolCall = (name, args = {}, meta) => ({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } });
const jcToken = () => token(`${ORIGIN}/jc/mcp`, `${ORIGIN}/jc`);

test('routing: preset other than local, or an unusable policy, never skips issuance', () => {
  assert.equal(localRoutingFromEnv({}).isLocal('read_file'), false);
  assert.equal(localRoutingFromEnv({ JC_PRESET: 'managed' }).isLocal('read_file'), false);
  assert.equal(localRoutingFromEnv({ JC_PRESET: 'standalone' }).isLocal('read_file'), false);
  const missing = localRoutingFromEnv({ JC_PRESET: 'local', JC_POLICY_PATH: path.join(tmp, 'nope.json') });
  assert.equal(missing.enabled, true);
  assert.equal(missing.isLocal('read_file'), false);
  assert.match(missing.error, /issuing through ACS/);
  for (const [label, doc] of Object.entries({
    garbage: '{nope',
    'global admin-delegated': { authorizers: { default: 'admin-delegated' } },
    'unknown provider': { authorizers: { default: 'local', providers: { 'jc.nope': 'local' } } },
    'unknown tool': { authorizers: { default: 'local', tools: { nope: 'local' } } },
  })) {
    const routing = localRoutingFromEnv({ JC_PRESET: 'local', JC_POLICY_PATH: writePolicy(`bad-${label}.json`, doc) });
    assert.equal(routing.isLocal('read_file'), false, label);
    assert.ok(routing.error, label);
  }
});

test('routing: implicit missing policy is uniform local; precedence is tool > provider > default', () => {
  const uniform = localRoutingFromEnv({ JC_PRESET: 'local' });
  assert.equal(uniform.isLocal('write_file'), true);
  assert.equal(uniform.isLocal('no_such_tool'), false);
  const file = writePolicy('mixed.json', { authorizers: { default: 'local', providers: { 'jc.git': 'acs-capability' }, tools: { git_status: 'local', ping: 'admin-delegated' } } });
  const routing = localRoutingFromEnv({ JC_PRESET: 'local', JC_POLICY_PATH: file });
  assert.equal(routing.isLocal('git_status'), true);
  assert.equal(routing.isLocal('git_push'), false);
  assert.equal(routing.isLocal('ping'), false);
  assert.equal(routing.isLocal('read_file'), true);
  const table = { default: 'local', providers: {}, tools: {} };
  assert.equal(resolveAuthorizer(table, 'read_file'), 'local');
  assert.equal(resolveAuthorizer(table, 'nope'), undefined);
  assert.equal(Object.keys(JC_TOOL_PROVIDERS).length, 36);
});

test('stripAuthorityMeta removes capability and acs* metadata and keeps the rest', () => {
  const out = stripAuthorityMeta(toolCall('read_file', { path: '/x' }, { capability: 'c', acsCapability: 'c', acsLeaseBinding: {}, progressToken: 't' }));
  assert.deepEqual(out.params._meta, { progressToken: 't' });
  assert.equal('_meta' in stripAuthorityMeta(toolCall('ping', {}, { acsCapability: 'c' })).params, false);
  assert.equal(stripAuthorityMeta(null), null);
});

test('edge: with JC_PRESET=local a local tool is forwarded with NO ACS issuance and spoofed authority stripped', async () => {
  const { gw, acs, jcUp, close } = await lane({ env: { JC_PRESET: 'local' } });
  try {
    const r = await call(gw.port, '/jc/mcp', jcToken(), toolCall('read_file', { path: '/x' }, { acsCapability: { forged: true }, capability: 'x', acsOperationPermitId: 'p1', progressToken: 'keep' }));
    assert.equal(r.status, 200);
    assert.equal(issues(acs).length, 0, 'ACS must not be asked for a capability');
    const forwarded = mcpRequests(jcUp).at(-1).body;
    assert.deepEqual(forwarded.params._meta, { progressToken: 'keep' });
    assert.deepEqual(forwarded.params.arguments, { path: '/x' });
  } finally { close(); }
});

test('edge: authentication is unchanged for local tools (wrong audience is still 401)', async () => {
  const { gw, acs, jcUp, close } = await lane({ env: { JC_PRESET: 'local' } });
  try {
    const r = await call(gw.port, '/jc/mcp', token(`${ORIGIN}/mcp`), toolCall('read_file', { path: '/x' }));
    assert.equal(r.status, 401);
    assert.equal(mcpRequests(jcUp).length, 0);
    assert.equal(issues(acs).length, 0);
  } finally { close(); }
});

test('edge: a tool the policy routes to acs-capability is still issued by ACS, a local one is not', async () => {
  const file = writePolicy('edge-mixed.json', { authorizers: { default: 'local', providers: { 'jc.git': 'acs-capability' } } });
  const { gw, acs, jcUp, close } = await lane({ env: { JC_PRESET: 'local', JC_POLICY_PATH: file } });
  try {
    await call(gw.port, '/jc/mcp', jcToken(), toolCall('git_status', { repo: '/r' }));
    assert.equal(issues(acs).length, 1);
    assert.equal(issues(acs)[0].body.tool, 'git_status');
    assert.ok(mcpRequests(jcUp).at(-1).body.params._meta.acsCapability, 'ACS envelope forwarded');
    await call(gw.port, '/jc/mcp', jcToken(), toolCall('read_file', { path: '/x' }));
    assert.equal(issues(acs).length, 1, 'read_file is local: no second issuance');
  } finally { close(); }
});

test('edge: an invalid explicit policy fails toward ACS (issuance happens); no preset is today\'s behavior', async () => {
  const bad = writePolicy('edge-bad.json', '{garbage');
  const a = await lane({ env: { JC_PRESET: 'local', JC_POLICY_PATH: bad } });
  try {
    await call(a.gw.port, '/jc/mcp', jcToken(), toolCall('read_file', { path: '/x' }));
    assert.equal(issues(a.acs).length, 1);
  } finally { a.close(); }
  const b = await lane();
  try {
    await call(b.gw.port, '/jc/mcp', jcToken(), toolCall('read_file', { path: '/x' }));
    assert.equal(issues(b.acs).length, 1);
  } finally { b.close(); }
});

test('edge: a local tool with ACS down still reaches the JC upstream; an ACS tool fails closed', async () => {
  const file = writePolicy('edge-down.json', { authorizers: { default: 'local', providers: { 'jc.git': 'acs-capability' } } });
  const { gw, acs, jcUp, close } = await lane({ env: { JC_PRESET: 'local', JC_POLICY_PATH: file }, acsHandler: () => ({ status: 503, body: { error: 'down' } }) });
  try {
    const local = await call(gw.port, '/jc/mcp', jcToken(), toolCall('read_file', { path: '/x' }));
    assert.equal(local.status, 200);
    assert.deepEqual((await local.json()).result, { lane: 'jc' });
    const before = mcpRequests(jcUp).length;
    const gated = await call(gw.port, '/jc/mcp', jcToken(), toolCall('git_status', { repo: '/r' }));
    assert.equal(gated.status, 200);
    assert.equal(mcpRequests(jcUp).length, before, 'nothing forwarded for the ACS-authorized tool');
    assert.equal(issues(acs).length, 1);
  } finally { close(); }
});

// ---- ADR 0026 slice 6: ACS optional at the edge ----------------------------------------

async function bareLane(env) {
  const dcUp = recorder(() => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: { lane: 'dc' } } }));
  const jcUp = recorder((req) => (req.path === '/authority'
    ? { status: 200, body: { variant: 'jc' } }
    : { status: 200, body: { jsonrpc: '2.0', id: 7, result: { lane: 'jc' } } }));
  const [dcPort, jcPort] = [await dcUp.listen(), await jcUp.listen()];
  const gw = await startGateway({ UPSTREAM: `http://127.0.0.1:${dcPort}`, JC_ENABLED: '1', JC_UPSTREAM: `http://127.0.0.1:${jcPort}`, ...env });
  const close = () => { gw.child?.kill('SIGKILL'); dcUp.server.close(); jcUp.server.close(); };
  return { gw, jcUp, close };
}

test('edge: JC_ACS_OPTIONAL=1 is only valid with JC_PRESET=local, otherwise the gateway refuses to start', async () => {
  const noPreset = await startGateway({ JC_ENABLED: '1', JC_ACS_OPTIONAL: '1' });
  assert.equal(noPreset.exitCode, 1);
  const managedPreset = await startGateway({ JC_ENABLED: '1', JC_ACS_OPTIONAL: '1', JC_PRESET: 'managed' });
  assert.equal(managedPreset.exitCode, 1);
  const shared = await startGateway({ JC_ENABLED: '1', JC_ACS_OPTIONAL: '1', JC_PRESET: 'local', ACS_GATEWAY_URL: 'http://127.0.0.1:1', ACS_GATEWAY_TOKEN: 'same', ACS_JC_GATEWAY_TOKEN: 'same' });
  assert.equal(shared.exitCode, 1);
});

test('edge: with no ACS configured at all, local tools work and ACS-routed tools fail with ACS_UNAVAILABLE without any request', async () => {
  const file = writePolicy('optional-mixed.json', { authorizers: { default: 'local', providers: { 'jc.git': 'acs-capability' } } });
  const { gw, jcUp, close } = await bareLane({ JC_ACS_OPTIONAL: '1', JC_PRESET: 'local', JC_POLICY_PATH: file });
  try {
    assert.equal(gw.exitCode, undefined, `gateway should start: ${typeof gw.stderr === 'function' ? gw.stderr() : gw.stderr}`);
    const local = await call(gw.port, '/jc/mcp', jcToken(), toolCall('read_file', { path: '/x' }));
    assert.deepEqual((await local.json()).result, { lane: 'jc' });
    const before = mcpRequests(jcUp).length;
    const gated = await call(gw.port, '/jc/mcp', jcToken(), toolCall('git_status', { repo: '/r' }));
    const text = JSON.stringify(await gated.json());
    assert.match(text, /ACS_UNAVAILABLE/);
    assert.equal(mcpRequests(jcUp).length, before, 'nothing forwarded for the ACS-authorized tool');
  } finally { close(); }
});

test('edge: an unreachable ACS is ACS_UNAVAILABLE in the local preset and acs_http_unreachable in managed (unchanged)', async () => {
  const file = writePolicy('unreachable.json', { authorizers: { default: 'local', providers: { 'jc.git': 'acs-capability' } } });
  const base = { ACS_GATEWAY_URL: 'http://127.0.0.1:1', ACS_JC_GATEWAY_TOKEN: 'jc-bridge-token' };
  const local = await bareLane({ ...base, JC_PRESET: 'local', JC_POLICY_PATH: file });
  try {
    const text = JSON.stringify(await (await call(local.gw.port, '/jc/mcp', jcToken(), toolCall('git_status', { repo: '/r' }))).json());
    assert.match(text, /ACS_UNAVAILABLE/);
    assert.doesNotMatch(text, /acs_http_unreachable/);
  } finally { local.close(); }
  const managed = await bareLane(base);
  try {
    const text = JSON.stringify(await (await call(managed.gw.port, '/jc/mcp', jcToken(), toolCall('git_status', { repo: '/r' }))).json());
    assert.match(text, /acs_http_unreachable/);
    assert.doesNotMatch(text, /ACS_UNAVAILABLE/);
  } finally { managed.close(); }
});
