#!/usr/bin/env node
// Self-test: the public edge /ready (server.js) must reject the same ambiguous,
// expired, malformed, or process-mismatched executor leases that the bridge's
// own /ready rejects (Codex P1 on #286). Plain node, no deps.
// Topology: test -> server.js -> stub bridge /authority (+ stub ACS /readyz).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dcBridgeReady, dcExecutionAuthorityReady } from '../readiness.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

const canonicalLease = { active: true, ambiguous: false, pid: 4242, instanceId: 'sim', expiresAt: Date.now() + 60_000, detail: 'executor lease held by pid 4242' };
const noBreakGlass = { active: false, ambiguous: false, detail: 'no break-glass marker file' };
const startedBridge = { hasUpstreamPair: true, upstreamStarted: true, initialized: false, spawnCount: 1, sessionCount: 0 };
function authority(overrides = {}) {
  return {
    variant: 'dc',
    configuredExecutionMode: 'managed',
    observedMode: 'managed',
    executor: { lease: canonicalLease, breakGlass: noBreakGlass },
    bridge: startedBridge,
    ...overrides,
  };
}
// Exactly what bridge.js executorLeaseStatus() reports for leases it rejects:
// it stays active (so observedMode is still "managed") but ambiguous.
const rejectedLeases = {
  malformed: { active: true, ambiguous: true, detail: 'executor lease file present but unreadable/malformed: /x/executor.lock' },
  expired: { active: true, ambiguous: true, pid: 4242, detail: 'executor lease failed canonical process identity/expiry validation (invalid lease fields or expiry): /x/executor.lock' },
  processMismatch: { active: true, ambiguous: true, pid: 4242, detail: 'executor lease failed canonical process identity/expiry validation (lease process identity no longer matches the live PID): /x/executor.lock' },
  competingTopology: { active: true, ambiguous: true, pid: 4242, detail: 'executor lease failed canonical process identity/expiry validation (managed executor topology is absent or competing (2 roots)): /x/executor.lock' },
};

// --- unit: shared predicate --------------------------------------------------
assert.equal(dcBridgeReady(authority(), { managed: true }), true, 'canonical managed lease is ready');
for (const [name, lease] of Object.entries(rejectedLeases)) {
  const a = authority({ executor: { lease, breakGlass: noBreakGlass } });
  assert.equal(dcExecutionAuthorityReady(a, { managed: true }), false, `${name} lease must not be ready (managed)`);
  assert.equal(dcExecutionAuthorityReady(a, { managed: false }), false, `${name} lease must not be ready (unmanaged)`);
}
assert.equal(dcBridgeReady(authority({ executor: { lease: canonicalLease, breakGlass: { active: true, ambiguous: true } } }), { managed: true }), false, 'ambiguous break-glass marker is not ready');
assert.equal(dcBridgeReady(authority({ executor: undefined }), { managed: true }), false, 'missing executor report is not ready');
assert.equal(dcBridgeReady(authority({ executor: { lease: { active: true }, breakGlass: noBreakGlass } }), { managed: true }), false, 'lease without an ambiguity verdict is not ready');
assert.equal(dcBridgeReady(authority({ variant: 'jc' }), { managed: true }), false, 'a jc bridge is never a ready DC bridge');
assert.equal(dcBridgeReady(authority({ bridge: { ...startedBridge, upstreamStarted: false } }), { managed: true }), false, 'unstarted upstream is not ready');
const breakGlassOnly = authority({ observedMode: 'break_glass', executor: { lease: { active: false, ambiguous: false }, breakGlass: { active: true, ambiguous: false, pid: 1 } } });
assert.equal(dcBridgeReady(breakGlassOnly, { managed: true }), false, 'break-glass is never ready on a managed lane');
assert.equal(dcBridgeReady(breakGlassOnly, { managed: false }), true, 'break-glass is ready on an unmanaged lane');
console.log('PASS: shared readiness predicate rejects every ambiguous/expired/malformed/mismatched lease');

// --- integration: the edge's public /ready uses it -------------------------
let current = authority();
const stub = http.createServer((req, res) => {
  if (req.url === '/authority') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(current)); return; }
  if (req.url === '/readyz') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
  res.writeHead(404); res.end();
});
const stubPort = await freePort();
await new Promise((resolve) => stub.listen(stubPort, '127.0.0.1', resolve));
const STUB = `http://127.0.0.1:${stubPort}`;

const gwPort = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-ready-lease-'));
const gateway = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: {
    PATH: process.env.PATH ?? '',
    HOME: dataDir,
    GATEWAY_PORT: String(gwPort),
    UPSTREAM: STUB,
    PUBLIC_ORIGIN: `http://127.0.0.1:${gwPort}`,
    CONSENT_PASSPHRASE: 'test-passphrase',
    SIGNING_KEY: 'b'.repeat(64),
    GATEWAY_EXECUTION_TOKEN: 'test-execution-token',
    DATA_DIR: dataDir,
    ACS_MANAGED_MODE: '1',
    ACS_GATEWAY_URL: STUB,
    ACS_GATEWAY_TOKEN: 'test-acs-token',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
gateway.stdout.on('data', (d) => { out += d; });
gateway.stderr.on('data', (d) => { out += d; });
const GW = `http://127.0.0.1:${gwPort}`;

try {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (gateway.exitCode !== null) throw new Error(`server.js exited early:\n${out}`);
    try { if ((await fetch(`${GW}/healthz`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server.js never became healthy:\n${out}`);
    await sleep(100);
  }

  async function edgeReady() {
    const r = await fetch(`${GW}/ready`);
    return { status: r.status, body: await r.json() };
  }

  current = authority();
  {
    const { status, body } = await edgeReady();
    assert.equal(status, 200, `canonical managed lease should be ready: ${JSON.stringify(body)}\n${out}`);
    assert.equal(body.bridgeReady, true);
  }
  for (const [name, lease] of Object.entries(rejectedLeases)) {
    current = authority({ executor: { lease, breakGlass: noBreakGlass } });
    const { status, body } = await edgeReady();
    assert.equal(status, 503, `edge /ready must reject a ${name} lease the bridge rejects: ${JSON.stringify(body)}`);
    assert.equal(body.bridgeReady, false);
  }
  current = authority({ executor: { lease: canonicalLease, breakGlass: { active: false, ambiguous: true, detail: 'break-glass marker file present but unreadable/malformed' } } });
  assert.equal((await edgeReady()).status, 503, 'edge /ready must reject an ambiguous break-glass marker');
  current = { variant: 'dc', observedMode: 'managed', bridge: startedBridge };
  assert.equal((await edgeReady()).status, 503, 'edge /ready must reject an authority report with no executor state');
  console.log('PASS: edge /ready rejects ambiguous, expired, malformed, and process-mismatched executor leases');
  console.log('PASS');
} finally {
  try { gateway.kill('SIGTERM'); } catch { /* noop */ }
  await new Promise((resolve) => stub.close(resolve));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ }
}
