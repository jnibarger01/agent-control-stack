#!/usr/bin/env node
/**
 * Jace Commander lane (/jc/mcp) at the gateway boundary.
 *
 * Proves:
 *  - JC lane refuses to start without its own ACS bridge credential, or when
 *    that credential equals the Desktop Commander one
 *  - disabled lane is not routable (404)
 *  - RFC 8707 audience separation: a /mcp token cannot call /jc/mcp and a
 *    /jc/mcp token cannot call /mcp; the OAuth flow mints jc-audience tokens
 *  - tools/call goes to ACS POST /jc/capability/issue with the jc bridge
 *    credential, spoofed client _meta is stripped, and the ACS envelope is
 *    forwarded to the jc upstream only (never to the DC upstream)
 *  - require_approval (privileged_exec) fails closed with the approval
 *    challenge surfaced, nothing forwarded
 *  - capability version/audience binding: a dc (acs.dc.v1) envelope on the jc
 *    route is rejected (acs_capability_wrong_audience), nothing forwarded
 *  - a JSON-RPC batch containing tools/call is rejected fail-closed
 *    (batched_tools_call_rejected): the gateway cannot attribute ACS issuance
 *    or strip spoofed authority fields per batch element
 *
 * Run: node --test test/jc-route.test.mjs
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

function token(aud) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ iss: ORIGIN, sub: 'jacen', client_id: 'c1', aud, scope: 'mcp', iat: now(), exp: now() + 600, jti: crypto.randomUUID() }));
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

const allowCapability = (req) => ({
  status: 200,
  body: {
    decision: 'allow',
    capability: { payload: { version: 'acs.jc.v1', audience: 'jace-commander', toolName: req.body.tool, normalizedArguments: JSON.parse(req.body.argsSummary) }, signature: 'acs-sig', keyId: 'acs-jc-1' },
    claimActionHash: 'claim', inputHash: 'input', workerId: 'acs-jc-bridge',
  },
});

let nextPort = 18300;
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

async function lane({ acsHandler = allowCapability, jcVariant = 'jc' } = {}) {
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

test('jc lane refuses to start without its own ACS bridge credential', async () => {
  const missing = await startGateway({ JC_ENABLED: '1', ACS_GATEWAY_URL: 'http://127.0.0.1:1' });
  assert.equal(missing.exitCode, 1);
  const shared = await startGateway({ JC_ENABLED: '1', ACS_GATEWAY_URL: 'http://127.0.0.1:1', ACS_GATEWAY_TOKEN: 'same', ACS_JC_GATEWAY_TOKEN: 'same' });
  assert.equal(shared.exitCode, 1);
});

test('jc lane disabled: /jc/mcp and its metadata are not routable', async () => {
  const gw = await startGateway({});
  try {
    const r = await call(gw.port, '/jc/mcp', token(`${ORIGIN}/jc/mcp`), { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(r.status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${gw.port}/.well-known/oauth-protected-resource/jc/mcp`)).status, 404);
  } finally { gw.child.kill('SIGKILL'); }
});

test('RFC 8707 audience separation between /mcp and /jc/mcp', async () => {
  const { gw, dcUp, jcUp, close } = await lane();
  try {
    const dcToken = token(`${ORIGIN}/mcp`);
    const jcToken = token(`${ORIGIN}/jc/mcp`);
    const listTools = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

    const crossToJc = await call(gw.port, '/jc/mcp', dcToken, listTools);
    assert.equal(crossToJc.status, 401);
    assert.match(crossToJc.headers.get('www-authenticate'), /oauth-protected-resource\/jc\/mcp/);
    const crossToDc = await call(gw.port, '/mcp', jcToken, listTools);
    assert.equal(crossToDc.status, 401);

    const ok = await call(gw.port, '/jc/mcp', jcToken, listTools);
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).result, { lane: 'jc' });
    assert.equal(mcpRequests(jcUp).length, 1);
    assert.equal(mcpRequests(jcUp)[0].path, '/mcp');
    assert.equal(dcUp.requests.length, 0);

    const meta = await (await fetch(`http://127.0.0.1:${gw.port}/.well-known/oauth-protected-resource/jc/mcp`)).json();
    assert.equal(meta.resource, `${ORIGIN}/jc/mcp`);
  } finally { close(); }
});

test('OAuth flow mints a jc-audience token only when resource=/jc/mcp is requested', async () => {
  const { gw, close } = await lane();
  try {
    const base = `http://127.0.0.1:${gw.port}`;
    const reg = await (await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:9/cb'] }) })).json();
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const params = { client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:9/cb', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp', state: 's' };

    const bad = await fetch(`${base}/authorize?${new URLSearchParams({ ...params, resource: `${ORIGIN}/other` })}`, { redirect: 'manual' });
    assert.equal(bad.status, 302);
    assert.match(bad.headers.get('location'), /error=invalid_target/);

    const page = await fetch(`${base}/authorize?${new URLSearchParams({ ...params, resource: `${ORIGIN}/jc/mcp` })}`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Jace Commander access/);
    assert.match(html, /ROOT commands/);

    const consent = await fetch(`${base}/authorize/consent`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, resource: `${ORIGIN}/jc/mcp`, passphrase: 'pass-phrase' }).toString(),
    });
    const code = new URL(consent.headers.get('location')).searchParams.get('code');
    const tokens = await (await fetch(`${base}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: params.redirect_uri, client_id: reg.client_id }).toString(),
    })).json();
    const claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString('utf8'));
    assert.equal(claims.aud, `${ORIGIN}/jc/mcp`);
    assert.equal((await call(gw.port, '/jc/mcp', tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 200);
    assert.equal((await call(gw.port, '/mcp', tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
  } finally { close(); }
});

test('tools/call: jc issue route + jc credential, spoofed meta stripped, forwarded to jc upstream only', async () => {
  const { gw, acs, dcUp, jcUp, close } = await lane();
  try {
    const body = {
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: {
        name: 'acs_read', arguments: { view: 'health' },
        _meta: { acsCapability: { payload: { forged: true }, signature: 'forged', keyId: 'x' }, capability: { forged: true }, progressToken: 'p1' },
      },
    };
    const r = await call(gw.port, '/jc/mcp', token(`${ORIGIN}/jc/mcp`), body);
    assert.equal(r.status, 200);
    assert.equal(acs.requests.length, 1);
    assert.equal(acs.requests[0].path, '/jc/capability/issue');
    assert.equal(acs.requests[0].auth, 'Bearer jc-bridge-token');
    assert.equal(acs.requests[0].jcActor, 'chatgpt:jacen', 'jc route attributes via x-jc-actor');
    assert.equal(acs.requests[0].actor, undefined, 'jc route never sends x-dc-actor');
    assert.equal(acs.requests[0].body.tool, 'acs_read');
    assert.equal(acs.requests[0].body.argsSummary, JSON.stringify({ view: 'health' }));

    assert.equal(dcUp.requests.length, 0);
    assert.equal(mcpRequests(jcUp).length, 1);
    const forwarded = mcpRequests(jcUp)[0].body;
    assert.equal(forwarded.params._meta.acsCapability.signature, 'acs-sig');
    assert.equal(forwarded.params._meta.acsCapability.payload.forged, undefined);
    assert.equal(forwarded.params._meta.progressToken, 'p1');
    assert.deepEqual(forwarded.params.arguments, { view: 'health' });
  } finally { close(); }
});

test('privileged_exec awaiting human approval fails closed and surfaces the ACS approval challenge', async () => {
  const { gw, jcUp, close } = await lane({
    acsHandler: () => ({
      status: 409,
      body: {
        decision: 'require_approval', workItemId: 'wrk_1', actionHash: 'a'.repeat(64),
        approvalSummary: { runAs: 'root', argv: ['/usr/bin/apt-get', 'update'] },
        approvalInstructions: 'A human must POST /work-items/wrk_1/approve ...',
      },
    }),
  });
  try {
    const r = await call(gw.port, '/jc/mcp', token(`${ORIGIN}/jc/mcp`), {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'privileged_exec', arguments: { argv: ['/usr/bin/apt-get', 'update'] } },
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 1);
    assert.equal(body.error.code, -32002);
    assert.equal(body.error.data.kind, 'managed_authorization_required');
    assert.equal(body.error.data.workItemId, 'wrk_1');
    assert.deepEqual(body.error.data.approvalSummary.argv, ['/usr/bin/apt-get', 'update']);
    assert.equal(mcpRequests(jcUp).length, 0);
  } finally { close(); }
});

test('ACS unreachable fails closed on the jc lane', async () => {
  const jcUp = recorder(() => ({ status: 200, body: {} }));
  const jcPort = await jcUp.listen();
  const gw = await startGateway({ JC_ENABLED: '1', JC_UPSTREAM: `http://127.0.0.1:${jcPort}`, ACS_GATEWAY_URL: 'http://127.0.0.1:1', ACS_JC_GATEWAY_TOKEN: 'jc-bridge-token' });
  try {
    const r = await call(gw.port, '/jc/mcp', token(`${ORIGIN}/jc/mcp`), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'jc_status', arguments: {} } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.error.code, -32003);
    assert.equal(mcpRequests(jcUp).length, 0);
  } finally { gw.child.kill('SIGKILL'); jcUp.server.close(); }
});

test('wrong-audience envelope on the jc route fails closed (acs_capability_wrong_audience)', async () => {
  const { gw, acs, jcUp, close } = await lane({
    acsHandler: (req) => ({
      status: 200,
      body: {
        decision: 'allow',
        capability: { payload: { version: 'acs.dc.v1', audience: 'desktop-commander', toolName: req.body.tool, normalizedArguments: JSON.parse(req.body.argsSummary) }, signature: 'acs-sig', keyId: 'acs-dc-1' },
      },
    }),
  });
  try {
    const r = await call(gw.port, '/jc/mcp', token(`${ORIGIN}/jc/mcp`), {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'acs_read', arguments: { view: 'health' } },
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.error.code, -32003);
    assert.equal(body.error.data.acsCode, 'acs_capability_wrong_audience');
    assert.equal(acs.requests.length, 1);
    assert.equal(mcpRequests(jcUp).length, 0);
  } finally { close(); }
});

test('JSON-RPC batch containing tools/call is rejected fail-closed on /jc/mcp', async () => {
  const { gw, acs, jcUp, close } = await lane();
  try {
    const batch = [
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'acs_read', arguments: { view: 'health' } } },
    ];
    const r = await call(gw.port, '/jc/mcp', token(`${ORIGIN}/jc/mcp`), batch);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).code, 'batched_tools_call_rejected');
    assert.equal(acs.requests.length, 0, 'no ACS issuance for a rejected batch');
    assert.equal(mcpRequests(jcUp).length, 0, 'nothing forwarded upstream');
  } finally { close(); }
});

test('JSON-RPC batch without tools/call still proxies on /jc/mcp', async () => {
  const { gw, acs, close } = await lane();
  try {
    const batch = [
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'ping', params: {} },
    ];
    const r = await call(gw.port, '/jc/mcp', token(`${ORIGIN}/jc/mcp`), batch);
    assert.equal(r.status, 200);
    assert.equal(acs.requests.length, 0);
  } finally { close(); }
});

test('/authority reads the jc bridge from JC_UPSTREAM, not the DC upstream', async () => {
  const authorityFor = (variant) => (req) => (req.path === '/authority'
    ? { status: 200, body: { variant, bridge: { hasUpstreamPair: true } } }
    : { status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } });
  const dcUp = recorder(authorityFor('dc'));
  const jcUp = recorder(authorityFor('jc'));
  const [dcPort, jcPort] = [await dcUp.listen(), await jcUp.listen()];
  const gw = await startGateway({
    UPSTREAM: `http://127.0.0.1:${dcPort}`, JC_ENABLED: '1', JC_UPSTREAM: `http://127.0.0.1:${jcPort}`,
    ACS_GATEWAY_URL: 'http://127.0.0.1:1', ACS_JC_GATEWAY_TOKEN: 'jc-bridge-token',
  });
  try {
    const authority = await (await fetch(`http://127.0.0.1:${gw.port}/authority`)).json();
    assert.equal(authority.bridge.variant, 'dc');
    assert.equal(authority.jcBridge.variant, 'jc');
    const ready = await (await fetch(`http://127.0.0.1:${gw.port}/ready`)).json();
    assert.equal(ready.jcBridgeReady, undefined, '/ready is scoped to the primary lane');
    assert.ok(jcUp.requests.some((r) => r.path === '/authority'), 'jc upstream was queried');
  } finally {
    gw.child.kill('SIGKILL'); dcUp.server.close(); jcUp.server.close();
  }
});

for (const [label, relative] of [['absolute path with spaces', false], ['relative path', true]]) {
  test(`jace-commander bridge runs <JC_DC_DIR>/dist/jace-commander/cli.js serve (${label})`, async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const repo = new URL('..', import.meta.url).pathname;
    // The relative case nests the checkout under the bridge's cwd so a doubled
    // path (cwd + relative script path) cannot resolve by accident.
    const root = fs.mkdtempSync(path.join(relative ? repo : os.tmpdir(), relative ? '.jc-dcdir-test-' : 'jc dcdir '));
    const state = path.join(root, 'state');
    fs.mkdirSync(path.join(root, 'dist/jace-commander'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
    fs.copyFileSync(new URL('./stub-jc.mjs', import.meta.url), path.join(root, 'dist/jace-commander/cli.js'));
    const port = nextPort++;
    const bridge = spawn(process.execPath, ['bridge.js'], {
      cwd: repo,
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, BRIDGE_PROFILE: 'jace-commander', BRIDGE_PORT: String(port),
        ACS_MANAGED_MODE: '1', DC_CMD: process.execPath, JC_DC_DIR: relative ? path.relative(repo, root) : root,
        JC_ACS_PUBLIC_KEY: 'k', JC_ACS_KEY_ID: 'i', JC_RUNTIME_ID: 'jc-test', JC_STATE_DIR: state,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    bridge.stderr.on('data', (d) => { stderr += d; });
    try {
      const argvFile = path.join(state, 'argv.json');
      for (let i = 0; i < 50 && !fs.existsSync(argvFile); i += 1) await new Promise((r) => setTimeout(r, 100));
      assert.ok(fs.existsSync(argvFile), `child from JC_DC_DIR never started: ${stderr}`);
      assert.deepEqual(JSON.parse(fs.readFileSync(argvFile, 'utf8')).argv, ['serve']);
    } finally {
      bridge.kill('SIGKILL');
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('/jc/mcp refuses to issue or forward when JC_UPSTREAM is not the jc bridge', async () => {
  const { gw, acs, dcUp, jcUp, close } = await lane({ jcVariant: 'dc' });
  try {
    const r = await call(gw.port, '/jc/mcp', token(`${ORIGIN}/jc/mcp`), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'jc_status', arguments: {} } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.error.data.acsCode, 'jc_bridge_mismatch');
    assert.equal(acs.requests.length, 0, 'no capability issued');
    assert.equal(mcpRequests(jcUp).length, 0, 'nothing forwarded');
    assert.equal(dcUp.requests.length, 0);
  } finally {
    close();
  }
});

test('jc lane refuses to start when JC_RESOURCE equals RESOURCE', async () => {
  const gw = await startGateway({ JC_ENABLED: '1', ACS_GATEWAY_URL: 'http://127.0.0.1:1', ACS_JC_GATEWAY_TOKEN: 'jc-bridge-token', JC_RESOURCE: `${ORIGIN}/mcp` });
  if (gw.exitCode === undefined) gw.child.kill('SIGKILL');
  assert.notEqual(gw.exitCode, undefined, 'gateway must not start');
  assert.match(typeof gw.stderr === 'function' ? gw.stderr() : gw.stderr, /JC_RESOURCE must differ from RESOURCE/);
});

test('with the jc lane on, /mcp refuses a UPSTREAM that is the jc bridge (swapped upstreams)', async () => {
  const acs = recorder(() => ({ status: 200, body: { decision: 'allow' } }));
  const swapped = recorder((req) => (req.path === '/authority'
    ? { status: 200, body: { variant: 'jc', bridge: { hasUpstreamPair: true } } }
    : { status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }));
  const [acsPort, upPort] = [await acs.listen(), await swapped.listen()];
  const gw = await startGateway({
    ACS_MANAGED_MODE: '1', ACS_GATEWAY_URL: `http://127.0.0.1:${acsPort}`, ACS_GATEWAY_TOKEN: 'dc-bridge-token',
    JC_ENABLED: '1', ACS_JC_GATEWAY_TOKEN: 'jc-bridge-token',
    UPSTREAM: `http://127.0.0.1:${upPort}`, JC_UPSTREAM: `http://127.0.0.1:${upPort}`,
  });
  try {
    assert.equal(gw.exitCode, undefined, 'gateway failed to start');
    const r = await call(gw.port, '/mcp', token(`${ORIGIN}/mcp`), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'start_process', arguments: { command: 'ls' } } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.error.data.acsCode, 'dc_bridge_mismatch');
    assert.equal(acs.requests.filter((q) => q.path === '/dc/capability/issue').length, 0, 'no DC capability issued');
    assert.equal(mcpRequests(swapped).length, 0, 'nothing forwarded');
    const ready = await (await fetch(`http://127.0.0.1:${gw.port}/ready`)).json();
    assert.equal(ready.bridgeReady, false);
  } finally {
    gw.child.kill('SIGKILL'); acs.server.close(); swapped.server.close();
  }
});

test('/ready is not delayed by an unresponsive jc bridge', async () => {
  const dcUp = recorder((req) => (req.path === '/authority'
    ? { status: 200, body: { variant: 'dc', bridge: { hasUpstreamPair: true } } }
    : { status: 200, body: {} }));
  // Accepts connections but never answers.
  const hung = http.createServer(() => {});
  const [dcPort, hungPort] = [await dcUp.listen(), await new Promise((r) => hung.listen(0, '127.0.0.1', () => r(hung.address().port)))];
  const gw = await startGateway({
    UPSTREAM: `http://127.0.0.1:${dcPort}`, JC_ENABLED: '1', JC_UPSTREAM: `http://127.0.0.1:${hungPort}`,
    ACS_GATEWAY_URL: 'http://127.0.0.1:1', ACS_JC_GATEWAY_TOKEN: 'jc-bridge-token',
  });
  try {
    const started = Date.now();
    const ready = await (await fetch(`http://127.0.0.1:${gw.port}/ready`)).json();
    const elapsed = Date.now() - started;
    assert.equal(ready.bridgeReady, true);
    assert.equal(ready.jcBridgeReady, undefined, 'jc bridge is not probed by /ready');
    assert.ok(elapsed < 1500, `/ready took ${elapsed}ms`);
  } finally {
    gw.child.kill('SIGKILL'); dcUp.server.close(); hung.closeAllConnections?.(); hung.close();
  }
});
