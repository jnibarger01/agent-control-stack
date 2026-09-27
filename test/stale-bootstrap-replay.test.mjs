#!/usr/bin/env node
// Auth proxy + bridge regression: fresh ACS challenges replay initialize to a
// new child and complete only with that child's genuine matching proof.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dcRuntimeIdentityFromState } from '../managed.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const KEY = 'b'.repeat(64);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const b64u = (value) => Buffer.from(value).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function startProc(script, env, label) {
  const proc = spawn(process.execPath, [script], {
    cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (chunk) => { output += chunk; });
  proc.stderr.on('data', (chunk) => { output += chunk; });
  proc.output = () => output;
  proc.label = label;
  return proc;
}

async function waitHealthy(url, proc) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${url}/healthz`)).ok) return; } catch { /* process starting */ }
    if (proc.exitCode !== null) throw new Error(`${proc.label} exited early:\n${proc.output()}`);
    await sleep(100);
  }
  throw new Error(`${proc.label} did not become healthy:\n${proc.output()}`);
}

function tokenFor(origin) {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64u(JSON.stringify({
    iss: origin, sub: 'replay-test', aud: `${origin}/mcp`, client_id: 'replay-client',
    scope: 'mcp', iat: now(), exp: now() + 600, jti: 'replay-jti',
  }));
  const signature = crypto.createHmac('sha256', KEY).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function dataMessage(text) {
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      try { return JSON.parse(line.slice(5).trim()); } catch { /* continue */ }
    }
  }
  try { return JSON.parse(text); } catch { return null; }
}

async function initialize(gatewayUrl, token, id) {
  const response = await fetch(`${gatewayUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      jsonrpc: '2.0', id, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'replay-test', version: '1' } },
    }),
  });
  const text = await response.text();
  return { status: response.status, text, message: dataMessage(text) };
}

const acsPort = await freePort();
const bridgePort = await freePort();
const gatewayPort = await freePort();
const ACS = `http://127.0.0.1:${acsPort}`;
const BRIDGE = `http://127.0.0.1:${bridgePort}`;
const GATEWAY = `http://127.0.0.1:${gatewayPort}`;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-stale-bootstrap-'));
fs.writeFileSync(path.join(stateDir, 'runtime-identity.json'), JSON.stringify({ runtimeId: 'test-runtime' }));
assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'runtime-identity.json'), 'utf8')).runtimeId, 'test-runtime');
assert.ok(dcRuntimeIdentityFromState({
  DESKTOP_COMMANDER_STATE_DIR: stateDir,
  ACS_DC_ENTRYPOINT: path.join(ROOT, 'managed.js'),
  ACS_DC_RUNTIME_SCOPES: 'fs.read,fs.write,process.exec,process.spawn',
}), 'gateway test runtime identity fixture must be readable');
const challengeQueue = ['challenge-A', 'challenge-B', 'challenge-C', 'challenge-D', 'reject', 'malformed'];
const completed = [];
const acs = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (req.url === '/dc/runtime/bootstrap') {
      const challenge = challengeQueue.shift();
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ runtimeId: body.runtimeId, challenge, scopes: body.scopes }));
      return;
    }
    if (req.url === '/dc/runtime/bootstrap/complete') {
      completed.push(body);
      const proofMatches = body.runtimeIdentity?.challenge === body.challenge;
      res.writeHead(proofMatches && body.challenge !== 'reject' ? 204 : 403);
      res.end();
      return;
    }
    res.writeHead(404); res.end();
  });
});

await new Promise((resolve) => acs.listen(acsPort, '127.0.0.1', resolve));
const bridge = startProc(path.join(ROOT, 'bridge.js'), {
  BRIDGE_PORT: String(bridgePort),
  ACS_MANAGED_MODE: '1',
  ACS_DC_PUBLIC_KEY: 'test-public-key',
  ACS_DC_KEY_ID: 'test-key-id',
  DC_CMD: process.execPath,
  DC_ARGS: `${path.join(ROOT, 'test/stub-bootstrap-dc.mjs')} 100`,
  DC_CWD: ROOT,
}, 'bridge');
const gateway = startProc(path.join(ROOT, 'server.js'), {
  GATEWAY_PORT: String(gatewayPort),
  PUBLIC_ORIGIN: GATEWAY,
  UPSTREAM: BRIDGE,
  CONSENT_PASSPHRASE: 'replay-test-passphrase',
  SIGNING_KEY: KEY,
  ACS_MANAGED_MODE: '1',
  ACS_GATEWAY_URL: ACS,
  ACS_GATEWAY_TOKEN: 'test-service-token',
  ACS_NATIVE_RUNTIME_BOOTSTRAP: '1',
  DESKTOP_COMMANDER_STATE_DIR: stateDir,
  ACS_DC_ENTRYPOINT: path.join(ROOT, 'managed.js'),
  ACS_DC_RUNTIME_SCOPES: 'fs.read,fs.write,process.exec,process.spawn',
}, 'gateway');

try {
  await waitHealthy(BRIDGE, bridge);
  await waitHealthy(GATEWAY, gateway);
  const token = tokenFor(GATEWAY);

  const first = await initialize(GATEWAY, token, 101);
  assert.equal(first.status, 200, `${first.text}\n${gateway.output()}\n${bridge.output()}`);
  assert.equal(first.message?.id, 101);
  assert.equal(first.message?.result?._meta?.acsRuntimeIdentity?.challenge, 'challenge-A');
  assert.equal(completed.at(-1)?.challenge, 'challenge-A');

  // This is a single HTTP initialize: no caller retry. Its successful proof
  // must originate from the replacement child and bind challenge B.
  const second = await initialize(GATEWAY, token, 202);
  assert.equal(second.status, 200, `${second.text}\n${gateway.output()}\n${bridge.output()}`);
  assert.equal(second.message?.id, 202, 'replayed response lost the original JSON-RPC id');
  assert.equal(second.message?.result?._meta?.acsRuntimeIdentity?.challenge, 'challenge-B');
  assert.equal(completed.at(-1)?.challenge, 'challenge-B');
  assert.equal(completed.at(-1)?.runtimeIdentity?.challenge, 'challenge-B');
  let debug = await (await fetch(`${BRIDGE}/debug/last-headers`)).json();
  assert.equal(debug.spawn_count, 1, 'fresh challenge must reuse the canonical executor');
  assert.equal(debug.session_count, 2, 'fresh challenge must not evict the first initialized session');

  // Concurrent unique challenges serialize through pair replacement. Neither
  // request can be answered with the other request's proof or JSON-RPC id.
  const [third, fourth] = await Promise.all([
    initialize(GATEWAY, token, 303),
    initialize(GATEWAY, token, 404),
  ]);
  assert.equal(third.status, 200, `${third.text}\n${gateway.output()}\n${bridge.output()}`);
  assert.equal(fourth.status, 200, `${fourth.text}\n${gateway.output()}\n${bridge.output()}`);
  assert.equal(third.message?.id, 303);
  assert.equal(fourth.message?.id, 404);
  const concurrentProofChallenges = [
    third.message?.result?._meta?.acsRuntimeIdentity?.challenge,
    fourth.message?.result?._meta?.acsRuntimeIdentity?.challenge,
  ];
  assert.deepEqual(concurrentProofChallenges.sort(), ['challenge-C', 'challenge-D']);
  assert.deepEqual(completed.slice(-2).map((entry) => entry.runtimeIdentity.challenge).sort(), ['challenge-C', 'challenge-D']);
  debug = await (await fetch(`${BRIDGE}/debug/last-headers`)).json();
  assert.equal(debug.pending_count, 0, 'concurrent initialize routes leaked request ids');
  assert.equal(debug.spawn_count, 1, 'concurrent fresh challenges must not recycle the canonical executor');
  assert.equal(debug.session_count, 4, 'concurrent initializes must preserve all live sessions');

  // ACS rejection remains fail-closed after pair replacement.
  const rejected = await initialize(GATEWAY, token, 505);
  assert.equal(rejected.status, 503, rejected.text);
  assert.equal(JSON.parse(rejected.text).code, 'runtime_bootstrap_rejected');
  assert.equal(completed.at(-1)?.challenge, 'reject');

  // The malformed child emits no proof; the auth proxy must not accept or
  // replace it with the last valid proof cached by the bridge.
  const malformed = await initialize(GATEWAY, token, 606);
  assert.equal(malformed.status, 503, malformed.text);
  assert.equal(JSON.parse(malformed.text).code, 'runtime_identity_proof_missing_or_malformed');
  assert.equal(completed.at(-1)?.challenge, 'reject', 'malformed proof must not reach ACS completion');

  console.log('PASS: fresh challenge replay, concurrent routing, and fail-closed bootstrap');
} finally {
  for (const proc of [gateway, bridge]) {
    proc.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => proc.once('exit', resolve)), sleep(2000)]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
  }
  acs.closeAllConnections();
  await new Promise((resolve) => acs.close(resolve));
  fs.rmSync(stateDir, { recursive: true, force: true });
}
