#!/usr/bin/env node
// Self-test: gateway identity forwarding + trusted transport attestation
// and (pass 2) lease-safe session recycling. Plain node, no deps.
//
// Topology: test -> gateway (server.js) -> bridge (bridge.js) -> stub executor
// plus a second bridge instance for the no-attestation pass-through case.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXEC_TOKEN = 'test-execution-token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

function startProc(script, env, label) {
  const child = spawn(process.execPath, [script], {
    cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
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
    try {
      const r = await fetch(`${url}/healthz`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    if (proc.exitCode !== null) throw new Error(`${proc.label} exited early:\n${proc.buf()}`);
    await sleep(150);
  }
  throw new Error(`${url}/healthz never became healthy;\n${proc.label} output:\n${proc.buf()}`);
}

async function post(url, headers, body) {
  const r = await fetch(url, { method: 'POST', headers, body });
  const text = await r.text();
  return { status: r.status, headers: Object.fromEntries(r.headers.entries()), text };
}

// --- JWT/attestation minting (mirrors server.js) ---
const b64u = (s) => Buffer.from(s).toString('base64url');
function signJwt(payload, key) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', key).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}
function mintAttestation(payload, key) {
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function extractSseData(text) {
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) {
      try { return JSON.parse(line.slice(5).trim()); } catch { /* keep looking */ }
    }
  }
  return null;
}

// --- bring up services ---
const gwPort = await freePort();
const brPort = await freePort();
const br2Port = await freePort();
const GW = `http://127.0.0.1:${gwPort}`;
const BR = `http://127.0.0.1:${brPort}`;
const BR2 = `http://127.0.0.1:${br2Port}`;
const ORIGIN = `http://127.0.0.1:${gwPort}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-gw-test-'));
const stubPath = path.join(ROOT, 'test', 'stub-dc.mjs');

const bridge = startProc(path.join(ROOT, 'bridge.js'), {
  BRIDGE_PORT: String(brPort),
  DC_GATEWAY_EXECUTION_TOKEN: EXEC_TOKEN,
  DC_CMD: process.execPath,
  DC_ARGS: stubPath,
  DC_CWD: ROOT,
}, 'bridge');
const bridge2 = startProc(path.join(ROOT, 'bridge.js'), {
  BRIDGE_PORT: String(br2Port),
  DC_GATEWAY_EXECUTION_TOKEN: EXEC_TOKEN,
  DC_CMD: process.execPath,
  DC_ARGS: stubPath,
  DC_CWD: ROOT,
}, 'bridge2');
const gateway = startProc(path.join(ROOT, 'server.js'), {
  GATEWAY_PORT: String(gwPort),
  UPSTREAM: BR,
  PUBLIC_ORIGIN: ORIGIN,
  CONSENT_PASSPHRASE: 'test-passphrase',
  SIGNING_KEY: 'a'.repeat(64),
  GATEWAY_EXECUTION_TOKEN: EXEC_TOKEN,
  DATA_DIR: dataDir,
}, 'gateway');

try {
  await waitHealthy(BR, bridge);
  await waitHealthy(BR2, bridge2);
  await waitHealthy(GW, gateway);

  const t = Math.floor(Date.now() / 1000);
  const access = signJwt({
    iss: ORIGIN, sub: 'jacen', aud: `${ORIGIN}/mcp`, client_id: 'https://chatgpt.example/client',
    scope: 'mcp', iat: t, exp: t + 3600, jti: 'test-jti-1',
  }, 'a'.repeat(64));
  const authHeaders = {
    Authorization: `Bearer ${access}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  // --- 1. MCP initialize through the gateway ---
  const init = await post(`${GW}/mcp`, authHeaders, JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'selftest', version: '0' } },
  }));
  assert.equal(init.status, 200, `initialize failed: ${init.status} ${init.text}`);
  const sessionId = init.headers['mcp-session-id'];
  assert.ok(sessionId, 'no mcp-session-id returned');
  const initData = extractSseData(init.text);
  assert.equal(initData?.result?.serverInfo?.name, 'stub-dc', `bad initialize result: ${init.text}`);

  // --- 2. attested identity arrives on the executor side ---
  const dbg = await (await fetch(`${BR}/debug/last-headers`)).json();
  assert.equal(dbg.last_headers['x-dc-agent'], 'jacen', `x-dc-agent: ${JSON.stringify(dbg.last_headers)}`);
  assert.equal(dbg.last_headers['x-dc-client'], 'https://chatgpt.example/client');
  assert.ok(dbg.last_headers['x-dc-attestation'], 'no x-dc-attestation forwarded');
  assert.ok(!dbg.last_headers.authorization, 'bearer token must not be forwarded');
  const fwd = dbg.last_upstream_message;
  assert.equal(fwd.method, 'initialize');
  assert.equal(fwd.params._meta.agent, 'chatgpt:jacen');
  assert.equal(fwd.params._meta.gateway.verified, true);
  assert.equal(fwd.params._meta.gateway.sub, 'jacen');
  assert.equal(fwd.params._meta.gateway.client_id, 'https://chatgpt.example/client');
  assert.equal(fwd.params._meta.gateway.jti, 'test-jti-1');
  assert.equal(fwd.params._meta.transport, 'oauth-gateway');
  console.log('attested identity + _meta injection: OK');

  // --- 3. tampered attestation -> -32001, no forward ---
  const att = mintAttestation({ sub: 'jacen', client_id: 'c', jti: 'j2', iat: t, exp: t + 30 }, EXEC_TOKEN);
  const [attBody, attSig] = att.split('.');
  const tampered = `${attBody.slice(0, -2)}${attBody.endsWith('AA') ? 'BB' : 'AA'}.${attSig}`;
  const rej = await post(`${BR}/mcp`, {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'x-dc-agent': 'jacen',
    'x-dc-attestation': tampered,
  }, JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'ping' }));
  assert.equal(rej.status, 400, `tampered attestation status: ${rej.status}`);
  const rejBody = JSON.parse(rej.text);
  assert.equal(rejBody.error.code, -32001);
  assert.equal(rejBody.error.message, 'gateway attestation invalid');
  const dbg2 = await (await fetch(`${BR}/debug/last-headers`)).json();
  assert.notEqual(dbg2.last_upstream_message?.id, 999, 'tampered request was forwarded upstream');
  console.log('tampered attestation rejected (-32001, no forward): OK');

  // --- 4. no attestation header -> pass through unchanged ---
  const plain = await post(`${BR2}/mcp`, {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }, JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'plain', version: '0' } },
  }));
  assert.equal(plain.status, 200, `plain initialize failed: ${plain.status} ${plain.text}`);
  const dbg3 = await (await fetch(`${BR2}/debug/last-headers`)).json();
  assert.equal(dbg3.last_upstream_message.params._meta, undefined, '_meta injected without attestation');
  console.log('no-attestation pass-through unchanged: OK');

  // --- 5. lease-safe session recycling ---
  // 5a. second POST without session id: no recycle, single executor, 400.
  const again = await post(`${BR}/mcp`, {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }, JSON.stringify({
    jsonrpc: '2.0', id: 2, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'second', version: '0' } },
  }));
  assert.equal(again.status, 400, `second session-less initialize status: ${again.status}`);
  let dbg4 = await (await fetch(`${BR}/debug/last-headers`)).json();
  assert.equal(dbg4.spawn_count, 1, `executor respawned on session-less POST (spawn_count=${dbg4.spawn_count})`);
  console.log('second session-less POST -> 400, still ONE executor: OK');

  // 5b. mismatched session id -> 400 'session unknown', no recycle.
  const bogus = await post(`${BR}/mcp`, {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'mcp-session-id': 'not-a-real-session',
  }, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }));
  assert.equal(bogus.status, 400, `bogus session status: ${bogus.status}`);
  assert.equal(JSON.parse(bogus.text).error.message, 'session unknown; reconnect and re-initialize');
  console.log('session mismatch -> 400 session unknown: OK');

  // 5c. executor crash -> single respawn, old session dies.
  const crash = await post(`${BR}/mcp`, {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'mcp-session-id': sessionId,
  }, JSON.stringify({ jsonrpc: '2.0', method: 'test/crash' }));
  assert.equal(crash.status, 202, `crash notification status: ${crash.status}`);
  const crashDeadline = Date.now() + 5000;
  do { dbg4 = await (await fetch(`${BR}/debug/last-headers`)).json(); if (dbg4.spawn_count === 2) break; await sleep(150); } while (Date.now() < crashDeadline);
  assert.equal(dbg4.spawn_count, 2, `executor not respawned after crash (spawn_count=${dbg4.spawn_count})`);
  const stale = await post(`${BR}/mcp`, {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'mcp-session-id': sessionId,
  }, JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }));
  assert.equal(stale.status, 400, `stale session after respawn status: ${stale.status}`);

  // 5d. the respawned pair still serves a full gateway-authenticated initialize.
  const reinit = await post(`${GW}/mcp`, authHeaders, JSON.stringify({
    jsonrpc: '2.0', id: 5, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'reinit', version: '0' } },
  }));
  assert.equal(reinit.status, 200, `re-initialize after respawn failed: ${reinit.status} ${reinit.text}`);
  assert.ok(extractSseData(reinit.text)?.result?.serverInfo?.name === 'stub-dc');
  console.log('crash respawn (single), stale session 400, re-initialize OK: OK');

  console.log('PASS');
} finally {
  for (const p of [gateway, bridge, bridge2]) { try { p.kill('SIGTERM'); } catch { /* noop */ } }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ }
}
