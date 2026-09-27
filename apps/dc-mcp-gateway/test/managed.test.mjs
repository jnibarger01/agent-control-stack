#!/usr/bin/env node
/**
 * Managed-mode authority tests for desktop-commander-mcp-gateway.
 *
 * Proves at the gateway boundary:
 *  - spoofed client _meta.acsCapability is stripped and never reaches upstream
 *  - missing/forged/expired/wrong-scope/approval-mismatch/lease-mismatch ACS
 *    responses fail closed as HTTP 200 JSON-RPC errors (nothing forwarded)
 *  - ACS unreachable fails closed
 *  - every tools/call fetches a fresh capability from ACS (no gateway-side
 *    replay/cache path exists)
 *  - managed mode refuses to start unconfigured (no silent standalone fallback)
 *  - lease-safe recycle decisions (defer while in flight, refuse on expiry)
 *
 * Run: node test/managed.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { recycleDecision } from '../recycle-policy.js';
import { isToolsCall } from '../managed.js';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

function harness({ acsBehavior } = {}) {
  // --- mock ACS issuer: the ONLY authority in this test ---
  const acsRequests = [];
  const acs = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      acsRequests.push(body);
      const decision = acsBehavior ? acsBehavior(body, acsRequests.length) : {
        decision: 'allow',
        capability: {
          payload: {
            toolName: body.tool,
            normalizedArguments: { command: '/usr/bin/ls', cwd: '/tmp', timeout_ms: 8000 },
          },
          signature: 'sig',
          keyId: 'k1',
        },
        claimActionHash: 'claim-hash',
        inputHash: 'input-hash',
        workerId: 'acs-dc-bridge',
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(decision));
    });
  });

  // --- mock upstream bridge: records forwarded bodies ---
  const upstreamRequests = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      upstreamRequests.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
    });
  });

  return { acs, acsRequests, upstream, upstreamRequests };
}

function startServer(port, env) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      GATEWAY_PORT: String(port),
      PUBLIC_ORIGIN: 'https://gw.test',
      CONSENT_PASSPHRASE: 'x',
      SIGNING_KEY: 'a'.repeat(32),
      UPSTREAM: env.UPSTREAM,
      ...(env.ACS_MANAGED_MODE === '1' ? { ACS_MANAGED_MODE: '1', ACS_GATEWAY_URL: env.ACS_GATEWAY_URL, ACS_GATEWAY_TOKEN: env.ACS_GATEWAY_TOKEN } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

function waitListening(child, port) {
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      const req = http.request({ host: '127.0.0.1', port, path: '/healthz', method: 'GET' }, (res) => {
        clearInterval(t); res.resume(); resolve();
      });
      req.on('error', () => { /* retry */ });
      req.end();
    }, 100);
    const bail = (why) => { clearInterval(t); reject(new Error(why)); };
    setTimeout(() => bail('server did not start'), 5000);
    child.on('exit', (code) => bail(`server exited early (${code})`));
    child.stderr?.on('data', (d) => { if (String(d).includes('refusing to start')) { clearInterval(t); resolve(); } });
  });
}

function tokenFor(key) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ iss: 'https://gw.test', sub: 'chatgpt-user', client_id: 'c1', aud: 'https://gw.test/mcp', scope: 'mcp', iat: now(), exp: now() + 600, jti: 'j1' }));
  const sig = crypto.createHmac('sha256', key).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

async function mcpCall(port, token, body) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

const TOOLS_CALL = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'start_process', arguments: { command: 'ls' } } };

test('managed mode: spoofed _meta stripped, ACS-issued capability injected, identity transported', async () => {
  const { acs, acsRequests, upstream, upstreamRequests } = harness();
  await new Promise((r) => { acs.listen(0, '127.0.0.1', r); });
  await new Promise((r) => { upstream.listen(0, '127.0.0.1', r); });
  const acsPort = acs.address().port;
  const upPort = upstream.address().port;
  const port = 18101;
  const child = startServer(port, { ACS_MANAGED_MODE: '1', ACS_GATEWAY_URL: `http://127.0.0.1:${acsPort}`, ACS_GATEWAY_TOKEN: 'svc-token', UPSTREAM: `http://127.0.0.1:${upPort}` });
  await waitListening(child, port);
  try {
    const spoofed = structuredClone(TOOLS_CALL);
    spoofed.params._meta = {
      capability: { payload: { forged: true }, signature: 'forged', keyId: 'forged' },
      acsCapability: { payload: { forged: true }, signature: 'forged', keyId: 'forged' },
      acsOther: 1,
    };
    const token = tokenFor('a'.repeat(32));
    const { status } = await mcpCall(port, token, spoofed);
    assert.equal(status, 200);
    // ACS received the invocation WITHOUT any client capability, with attribution
    assert.equal(acsRequests.length, 1);
    assert.equal(acsRequests[0].tool, 'start_process');
    assert.equal(acsRequests[0].client_id, 'c1');
    assert.equal(acsRequests[0].argsSummary, JSON.stringify({ command: 'ls' }));
    assert.equal(typeof acsRequests[0].correlationId, 'string');
    // Upstream received exactly one request whose capability is the ACS-issued
    // one, transported under BOTH meta keys (pipeline 'capability' + managed
    // guard 'acsCapability'), with the client's forged values stripped.
    assert.equal(upstreamRequests.length, 1);
    const forwarded = JSON.parse(upstreamRequests[0]);
    assert.deepEqual(forwarded.params.arguments, {
      command: '/usr/bin/ls',
      cwd: '/tmp',
      timeout_ms: 8000,
    });
    assert.equal(forwarded.params._meta.capability.signature, 'sig');
    assert.equal(forwarded.params._meta.capability.payload.forged, undefined);
    assert.equal(forwarded.params._meta.acsCapability.signature, 'sig');
    assert.equal(forwarded.params._meta.acsCapability.payload.forged, undefined);
    // Authoritative lease binding transported for result submission.
    assert.equal(forwarded.params._meta.acsLeaseBinding.claimActionHash, 'claim-hash');
    assert.equal(forwarded.params._meta.acsLeaseBinding.inputHash, 'input-hash');
    assert.equal(forwarded.params._meta.acsOther, undefined);
  } finally {
    child.kill('SIGKILL'); acs.close(); upstream.close();
  }
});

for (const [name, decision] of [
  ['missing capability (ACS denies)', { ok: false, code: 'acs_not_authorized' }],
  ['forged/expired capability rejected by ACS', { ok: false, code: 'capability_expired' }],
  ['wrong-scope capability rejected by ACS', { ok: false, code: 'capability_scope_mismatch' }],
  ['approval mismatch rejected by ACS', { ok: false, code: 'approval_mismatch' }],
  ['attempt/lease/fencing mismatch rejected by ACS', { ok: false, code: 'lease_mismatch' }],
  ['competing executor / stale lease rejected by ACS', { ok: false, code: 'stale_lease' }],
  ['evidence replay rejected by ACS', { ok: false, code: 'nonce_replay' }],
]) {
  test(`managed mode fails closed on: ${name}`, async () => {
    const { acs, upstream, upstreamRequests } = harness({ acsBehavior: () => decision });
    await new Promise((r) => { acs.listen(0, '127.0.0.1', r); });
    await new Promise((r) => { upstream.listen(0, '127.0.0.1', r); });
    const acsPort = acs.address().port;
    const upPort = upstream.address().port;
    const port = 18102;
    const child = spawn(process.execPath, ['server.js'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        ...process.env,
        GATEWAY_PORT: String(port),
        PUBLIC_ORIGIN: 'https://gw.test', CONSENT_PASSPHRASE: 'x', SIGNING_KEY: 'a'.repeat(32),
        ACS_MANAGED_MODE: '1', ACS_GATEWAY_URL: `http://127.0.0.1:${acsPort}`, ACS_GATEWAY_TOKEN: 'svc-token',
        UPSTREAM: `http://127.0.0.1:${upPort}`,
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    await waitListening(child, port);
    try {
      const { status, text } = await mcpCall(port, tokenFor('a'.repeat(32)), TOOLS_CALL);
      assert.equal(status, 200, text);
      const body = JSON.parse(text);
      assert.equal(body.jsonrpc, '2.0');
      assert.equal(body.id, TOOLS_CALL.id);
      assert.equal(body.error.code, -32001);
      assert.equal(body.error.data.kind, 'managed_authorization_denied');
      assert.equal(body.error.data.acsCode, decision.code);
      assert.equal(body.error.data.retryable, false);
      // FAIL CLOSED: nothing reached Desktop Commander
      assert.equal(upstreamRequests.length, 0);
    } finally {
      child.kill('SIGKILL'); acs.close(); upstream.close();
    }
  });
}

test('managed mode preserves approval challenge metadata when ACS requires approval', async () => {
  // Mirrors the real ACS 409 body shape (apps/gateway/src/server.ts,
  // POST /dc/capability/issue, require_approval branch): decision +
  // workItemId + actionHash + approvalInstructions, no `code` field.
  const acsDecision = {
    decision: 'require_approval',
    workItemId: 'wrk_test123',
    actionHash: 'hash_abc',
    approvalInstructions: 'POST /work-items/wrk_test123/approve with actionHash hash_abc',
  };
  const { acs, upstream, upstreamRequests } = harness({ acsBehavior: () => acsDecision });
  await new Promise((r) => { acs.listen(0, '127.0.0.1', r); });
  await new Promise((r) => { upstream.listen(0, '127.0.0.1', r); });
  const acsPort = acs.address().port;
  const upPort = upstream.address().port;
  const port = 18105;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      GATEWAY_PORT: String(port),
      PUBLIC_ORIGIN: 'https://gw.test', CONSENT_PASSPHRASE: 'x', SIGNING_KEY: 'a'.repeat(32),
      ACS_MANAGED_MODE: '1', ACS_GATEWAY_URL: `http://127.0.0.1:${acsPort}`, ACS_GATEWAY_TOKEN: 'svc-token',
      UPSTREAM: `http://127.0.0.1:${upPort}`,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await waitListening(child, port);
  try {
    const writeCall = {
      jsonrpc: '2.0',
      id: 'write-1',
      method: 'tools/call',
      params: { name: 'write_file', arguments: { path: '/home/jacen/projects/.jace-commander-write-test', content: 'x' } },
    };
    const { status, text } = await mcpCall(port, tokenFor('a'.repeat(32)), writeCall);
    assert.equal(status, 200, text);
    const body = JSON.parse(text);
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 'write-1');
    assert.equal(body.error.code, -32002);
    assert.equal(body.error.data.kind, 'managed_authorization_required');
    assert.equal(body.error.data.acsCode, 'require_approval');
    assert.equal(body.error.data.retryable, true);
    assert.equal(body.error.data.workItemId, 'wrk_test123');
    assert.equal(body.error.data.actionHash, 'hash_abc');
    assert.equal(body.error.data.approvalInstructions, 'POST /work-items/wrk_test123/approve with actionHash hash_abc');
    assert.equal(body.error.data.instructions, body.error.data.approvalInstructions);
    // Still fail-closed: no capability was minted, nothing reached Desktop Commander.
    assert.equal(upstreamRequests.length, 0);
  } finally {
    child.kill('SIGKILL'); acs.close(); upstream.close();
  }
});

test('managed mode fails closed when ACS is unreachable', async () => {
  const { upstream, upstreamRequests } = harness();
  await new Promise((r) => { upstream.listen(0, '127.0.0.1', r); });
  const upPort = upstream.address().port;
  const port = 18103;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      GATEWAY_PORT: String(port),
      PUBLIC_ORIGIN: 'https://gw.test', CONSENT_PASSPHRASE: 'x', SIGNING_KEY: 'a'.repeat(32),
      ACS_MANAGED_MODE: '1', ACS_GATEWAY_URL: 'http://127.0.0.1:9', ACS_GATEWAY_TOKEN: 'svc-token',
      UPSTREAM: `http://127.0.0.1:${upPort}`,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await waitListening(child, port);
  try {
    const { status, text } = await mcpCall(port, tokenFor('a'.repeat(32)), TOOLS_CALL);
    assert.equal(status, 200, text);
    const body = JSON.parse(text);
    assert.equal(body.error.code, -32003);
    assert.equal(body.error.data.kind, 'managed_authorization_unavailable');
    assert.equal(upstreamRequests.length, 0);
  } finally {
    child.kill('SIGKILL'); upstream.close();
  }
});

test('managed mode refuses to start unconfigured (no standalone fallback)', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { managedModeFromEnv } from './managed.js';
    try { managedModeFromEnv({ ACS_MANAGED_MODE: '1' }); console.log('STARTED'); }
    catch (e) { console.log('REFUSED: ' + e.message); }
  `], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
  assert.match(r.stdout, /REFUSED: managed mode requires ACS_GATEWAY_URL and ACS_GATEWAY_TOKEN/);
});

test('managed mode injects a FRESH capability per call (no replay/cache path)', async () => {
  const { acs, acsRequests, upstream, upstreamRequests } = harness({ acsBehavior: (_b, i) => ({ decision: 'allow', capability: { payload: { n: i, normalizedArguments: { n: i } }, signature: `sig${i}`, keyId: 'k1' } }) });
  await new Promise((r) => { acs.listen(0, '127.0.0.1', r); });
  await new Promise((r) => { upstream.listen(0, '127.0.0.1', r); });
  const acsPort = acs.address().port;
  const upPort = upstream.address().port;
  const port = 18104;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      GATEWAY_PORT: String(port),
      PUBLIC_ORIGIN: 'https://gw.test', CONSENT_PASSPHRASE: 'x', SIGNING_KEY: 'a'.repeat(32),
      ACS_MANAGED_MODE: '1', ACS_GATEWAY_URL: `http://127.0.0.1:${acsPort}`, ACS_GATEWAY_TOKEN: 'svc-token',
      UPSTREAM: `http://127.0.0.1:${upPort}`,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await waitListening(child, port);
  try {
    const token = tokenFor('a'.repeat(32));
    await mcpCall(port, token, TOOLS_CALL);
    await mcpCall(port, token, TOOLS_CALL);
    assert.equal(acsRequests.length, 2); // two issuances, one per call
    assert.equal(upstreamRequests.length, 2);
    const caps = upstreamRequests.map((r) => JSON.parse(r).params._meta.capability.signature);
    assert.notDeepEqual(caps[0], caps[1]); // distinct envelopes, never cached
  } finally {
    child.kill('SIGKILL'); acs.close(); upstream.close();
  }
});

test('managed authorization applies only to tools/call, not discovery methods', () => {
  assert.equal(isToolsCall(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_config', arguments: {} } }))).isCall, true);
  assert.equal(isToolsCall(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }))).isCall, false);
});

test('lease-safe recycling: defer while a tools/call is in flight, refuse when the wait expires', () => {
  assert.deepEqual(recycleDecision(0, 15_000, 0), { action: 'recycle' });
  assert.deepEqual(recycleDecision(1, 15_000, 0), { action: 'defer' });
  assert.deepEqual(recycleDecision(1, 15_000, 15_000), { action: 'refuse' });
});
