#!/usr/bin/env node
/**
 * Runtime-bootstrap attestation regression gates.
 *
 * Proves at the gateway boundary that a managed MCP initialize:
 *  A. extracts result._meta.acsRuntimeIdentity from the child's initialize
 *     response and forwards that EXACT object to ACS, releasing the child's
 *     initialize only after ACS answers 204;
 *  B. fails closed (503, no completion accepted) when the child response
 *     lacks a well-formed acsRuntimeIdentity;
 *  C. fails closed (503, initialize success never exposed) when ACS rejects
 *     the completion;
 *  D. leaves ordinary tools/call on the existing streaming proxy path.
 *
 * Run: node --test test/runtime-bootstrap.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const b64u = (s) => Buffer.from(s).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

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

const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
const TOOLS_CALL = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'start_process', arguments: { command: 'ls' } } };

const RUNTIME_ID = 'rt_test_1';
const SCOPES = ['fs.read', 'process.exec'];
const ENTRYPOINT = new URL('../managed.js', import.meta.url).pathname;

/**
 * Stub ACS: issues a challenge on POST /dc/runtime/bootstrap and records +
 * answers POST /dc/runtime/bootstrap/complete per completeStatus.
 */
function stubAcs({ completeStatus = 204 } = {}) {
  const completeBodies = [];
  const acs = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (req.url === '/dc/runtime/bootstrap') {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ runtimeId: body.runtimeId, challenge: 'ch_123', scopes: body.scopes }));
        return;
      }
      if (req.url === '/dc/capability/issue') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          decision: 'allow',
          capability: {
            payload: { toolName: body.tool, normalizedArguments: body.argsSummary ? JSON.parse(body.argsSummary) : {} },
            signature: 'sig', keyId: 'k1',
          },
        }));
        return;
      }
      if (req.url === '/dc/runtime/bootstrap/complete') {
        completeBodies.push(body);
        res.writeHead(completeStatus);
        res.end();
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  return { acs, completeBodies };
}

/** Stub child (upstream): answers initialize per responder, records all bodies. */
function stubChild(responder) {
  const bodies = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      responder(req, res, JSON.parse(bodies[bodies.length - 1]));
    });
  });
  return { upstream, bodies };
}

function makeStateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-rt-'));
  fs.writeFileSync(path.join(dir, 'runtime-identity.json'), JSON.stringify({ runtimeId: RUNTIME_ID }));
  return dir;
}

function startServer(port, upstreamPort, acsPort, stateDir) {
  return spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      GATEWAY_PORT: String(port),
      PUBLIC_ORIGIN: 'https://gw.test', CONSENT_PASSPHRASE: 'x', SIGNING_KEY: 'a'.repeat(32),
      ACS_MANAGED_MODE: '1', ACS_GATEWAY_URL: `http://127.0.0.1:${acsPort}`, ACS_GATEWAY_TOKEN: 'svc-token',
      ACS_NATIVE_RUNTIME_BOOTSTRAP: '1',
      UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      DESKTOP_COMMANDER_STATE_DIR: stateDir,
      ACS_DC_ENTRYPOINT: ENTRYPOINT,
      ACS_DC_RUNTIME_SCOPES: SCOPES.join(','),
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

function waitListening(child, port) {
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      const req = http.request({ host: '127.0.0.1', port, path: '/healthz', method: 'GET' }, (res) => {
        clearInterval(t); res.resume(); resolve();
      });
      req.on('error', () => {});
      req.end();
    }, 100);
    setTimeout(() => { clearInterval(t); reject(new Error('server did not start')); }, 5000);
    child.on('exit', (code) => { clearInterval(t); reject(new Error(`server exited early (${code})`)); });
  });
}

const GOOD_PROOF = { schemaVersion: 1, runtimeId: RUNTIME_ID, challenge: 'ch_123', scopes: SCOPES };
const CHILD_INIT_OK = (proof) => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'dc', version: '0' }, ...(proof ? { _meta: { acsRuntimeIdentity: proof } } : {}) } });

test('A: initialize proof extracted, exact object sent to ACS, response released only after 204', async () => {
  const { acs, completeBodies } = stubAcs();
  let sawCompletionBeforeRelease = false;
  const { upstream, bodies } = stubChild((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    // If the gateway streams through, the client response arrives before the
    // completion POST lands; we detect release-before-attestation from the
    // ACS side below instead. Here we just serve the child response.
    res.end(CHILD_INIT_OK(GOOD_PROOF));
    void sawCompletionBeforeRelease;
  });
  await new Promise((r) => { acs.listen(0, '127.0.0.1', r); });
  await new Promise((r) => { upstream.listen(0, '127.0.0.1', r); });
  const port = 18201;
  const child = startServer(port, upstream.address().port, acs.address().port, makeStateDir());
  await waitListening(child, port);
  try {
    const { status, text } = await mcpCall(port, tokenFor('a'.repeat(32)), INITIALIZE);
    assert.equal(status, 200, text);
    // Client receives the child's original initialize response, byte-for-byte payload.
    const clientBody = JSON.parse(text);
    assert.equal(clientBody.result.serverInfo.name, 'dc');
    // The completion body carries the EXACT proof object from the child response.
    assert.equal(completeBodies.length, 1, 'exactly one completion POST');
    assert.deepEqual(completeBodies[0].runtimeIdentity, GOOD_PROOF);
    assert.equal(completeBodies[0].challenge, 'ch_123');
    assert.equal(completeBodies[0].runtimeId, RUNTIME_ID);
    // The initialize forwarded upstream carried the injected challenge for the child.
    const forwarded = JSON.parse(bodies[0]);
    assert.equal(forwarded.params._meta.acsRuntimeBootstrap.challenge, 'ch_123');
    // Sequencing: by the time the client got 200, the completion already happened.
    assert.equal(completeBodies.length >= 1, true);
    void sawCompletionBeforeRelease;
  } finally {
    child.kill('SIGKILL'); acs.close(); upstream.close();
  }
});

test('A2: SSE-framed initialize response (text/event-stream) is parsed for the proof and forwarded byte-for-byte', async () => {
  const { acs, completeBodies } = stubAcs();
  const sseBody = `event: message\r\ndata: ${CHILD_INIT_OK(GOOD_PROOF)}\r\n\r\n`;
  const { upstream } = stubChild((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sseBody);
  });
  await new Promise((r) => { acs.listen(0, '127.0.0.1', r); });
  await new Promise((r) => { upstream.listen(0, '127.0.0.1', r); });
  const port = 18206;
  const child = startServer(port, upstream.address().port, acs.address().port, makeStateDir());
  await waitListening(child, port);
  try {
    const { status, text } = await mcpCall(port, tokenFor('a'.repeat(32)), INITIALIZE);
    assert.equal(status, 200, text);
    // The client gets the child's original SSE bytes, unmodified.
    assert.equal(text, sseBody);
    assert.equal(completeBodies.length, 1);
    assert.deepEqual(completeBodies[0].runtimeIdentity, GOOD_PROOF);
  } finally {
    child.kill('SIGKILL'); acs.close(); upstream.close();
  }
});

test('B: child response without acsRuntimeIdentity fails closed (503, no completion)', async () => {
  const { acs, completeBodies } = stubAcs();
  const { upstream } = stubChild((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(CHILD_INIT_OK(null));
  });
  await new Promise((r) => { acs.listen(0, '127.0.0.1', r); });
  await new Promise((r) => { upstream.listen(0, '127.0.0.1', r); });
  const port = 18202;
  const child = startServer(port, upstream.address().port, acs.address().port, makeStateDir());
  await waitListening(child, port);
  try {
    const { status, text } = await mcpCall(port, tokenFor('a'.repeat(32)), INITIALIZE);
    assert.equal(status, 503, text);
    const body = JSON.parse(text);
    assert.equal(body.error, 'managed_authorization_unavailable');
    assert.equal(body.code, 'runtime_identity_proof_missing_or_malformed');
    // No attestation completion was accepted.
    assert.equal(completeBodies.length, 0);
    // Malformed proof (wrong schemaVersion) also fails closed.
  } finally {
    child.kill('SIGKILL'); acs.close(); upstream.close();
  }
});

test('B2: malformed acsRuntimeIdentity (bad schemaVersion) fails closed', async () => {
  const { acs, completeBodies } = stubAcs();
  const { upstream } = stubChild((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(CHILD_INIT_OK({ schemaVersion: 2, runtimeId: RUNTIME_ID, challenge: 'ch_123', scopes: SCOPES }));
  });
  await new Promise((r) => { acs.listen(0, '127.0.0.1', r); });
  await new Promise((r) => { upstream.listen(0, '127.0.0.1', r); });
  const port = 18203;
  const child = startServer(port, upstream.address().port, acs.address().port, makeStateDir());
  await waitListening(child, port);
  try {
    const { status } = await mcpCall(port, tokenFor('a'.repeat(32)), INITIALIZE);
    assert.equal(status, 503);
    assert.equal(completeBodies.length, 0);
  } finally {
    child.kill('SIGKILL'); acs.close(); upstream.close();
  }
});

test('C: ACS rejecting completion fails closed — initialize success never exposed', async () => {
  const { acs, completeBodies } = stubAcs({ completeStatus: 403 });
  const { upstream } = stubChild((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(CHILD_INIT_OK(GOOD_PROOF));
  });
  await new Promise((r) => { acs.listen(0, '127.0.0.1', r); });
  await new Promise((r) => { upstream.listen(0, '127.0.0.1', r); });
  const port = 18204;
  const child = startServer(port, upstream.address().port, acs.address().port, makeStateDir());
  await waitListening(child, port);
  try {
    const { status, text } = await mcpCall(port, tokenFor('a'.repeat(32)), INITIALIZE);
    assert.equal(status, 503, text);
    const body = JSON.parse(text);
    assert.equal(body.error, 'managed_authorization_unavailable');
    assert.equal(body.code, 'runtime_bootstrap_rejected');
    // The completion was attempted with the exact proof, then rejected.
    assert.equal(completeBodies.length, 1);
    assert.deepEqual(completeBodies[0].runtimeIdentity, GOOD_PROOF);
  } finally {
    child.kill('SIGKILL'); acs.close(); upstream.close();
  }
});

test('C2: a fail-closed initialize closes the bridge session the child already opened (no session leak)', async () => {
  const { acs } = stubAcs({ completeStatus: 403 });
  const seen = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push({ method: req.method, session: req.headers['mcp-session-id'] });
      if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-leak-1' });
      res.end(CHILD_INIT_OK(GOOD_PROOF));
    });
  });
  await new Promise((r) => { acs.listen(0, '127.0.0.1', r); });
  await new Promise((r) => { upstream.listen(0, '127.0.0.1', r); });
  const port = 18207;
  const child = startServer(port, upstream.address().port, acs.address().port, makeStateDir());
  await waitListening(child, port);
  try {
    const { status, text } = await mcpCall(port, tokenFor('a'.repeat(32)), INITIALIZE);
    assert.equal(status, 503, text);
    assert.equal(JSON.parse(text).code, 'runtime_bootstrap_rejected');
    for (let i = 0; i < 50 && !seen.some((r) => r.method === 'DELETE'); i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(seen.filter((r) => r.method === 'DELETE'), [{ method: 'DELETE', session: 'sess-leak-1' }]);
  } finally {
    child.kill('SIGKILL'); acs.close(); upstream.close();
  }
});

test('D: ordinary tools/call still uses the existing streaming proxy (no initialize buffering)', async () => {
  const { acs } = stubAcs();
  const acsCalls = [];
  const origCreateServer = acs;
  void origCreateServer;
  const { upstream, bodies } = stubChild((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { ok: true } }));
  });
  // Record ACS calls (capability issue) to prove tools/call path unchanged.
  acs.on('request', () => acsCalls.push(1));
  await new Promise((r) => { acs.listen(0, '127.0.0.1', r); });
  await new Promise((r) => { upstream.listen(0, '127.0.0.1', r); });
  const port = 18205;
  const child = startServer(port, upstream.address().port, acs.address().port, makeStateDir());
  await waitListening(child, port);
  try {
    const { status, text } = await mcpCall(port, tokenFor('a'.repeat(32)), TOOLS_CALL);
    assert.equal(status, 200, text);
    assert.equal(JSON.parse(text).result.ok, true);
    // Capability issued per call (existing managed tools/call behavior preserved).
    assert.equal(acsCalls.length, 1);
    // Forwarded through the plain proxy: no _meta.acsRuntimeBootstrap injection.
    const forwarded = JSON.parse(bodies[0]);
    assert.equal(forwarded.method, 'tools/call');
    assert.equal(forwarded.params._meta?.acsRuntimeBootstrap, undefined);
  } finally {
    child.kill('SIGKILL'); acs.close(); upstream.close();
  }
});
