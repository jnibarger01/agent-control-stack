#!/usr/bin/env node
// Self-test: bridge.js /health, /ready, /authority (hardening item #2/#4).
// Plain node, no deps. Topology: test -> bridge.js -> stub executor.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

function startBridge(env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'bridge.js')], {
    cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.buf = () => out;
  return child;
}

async function waitHealthy(url, proc, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${url}/healthz`); if (r.ok) return; } catch { /* not up yet */ }
    if (proc.exitCode !== null) throw new Error(`bridge exited early:\n${proc.buf()}`);
    await sleep(150);
  }
  throw new Error(`${url}/healthz never became healthy:\n${proc.buf()}`);
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-authority-endpoints-'));
const port = await freePort();
const BR = `http://127.0.0.1:${port}`;
const bridge = startBridge({
  BRIDGE_PORT: String(port),
  DC_CMD: process.execPath,
  DC_ARGS: path.join(ROOT, 'test', 'stub-dc.mjs'),
  // Pin the stub's cwd; the bridge default is a host-specific checkout path.
  DC_CWD: ROOT,
  DESKTOP_COMMANDER_EXECUTOR_LOCK_DIR: stateDir,
});

try {
  await waitHealthy(BR, bridge);

  // /health: process-alive framing.
  {
    const r = await fetch(`${BR}/health`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.pid, 'number');
    console.log('PASS: /health reports process-alive');
  }

  // /authority with no lease/break-glass marker present: observedMode none_active.
  {
    const r = await fetch(`${BR}/authority`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.observedMode, 'none_active');
    assert.equal(body.executor.lease.active, false);
    assert.equal(body.executor.breakGlass.active, false);
    // Never leak secrets: no key material, tokens, or signatures anywhere in the payload.
    const flat = JSON.stringify(body);
    for (const secretish of ['privateKey', 'PRIVATE_KEY', 'signature', 'HMAC', 'Bearer']) {
      assert.ok(!flat.includes(secretish), `/authority payload must never contain "${secretish}"`);
    }
    console.log('PASS: /authority reports none_active with no lease/break-glass, no secret material');
  }

  // /ready: a live upstream without execution authority must fail closed.
  {
    const r = await fetch(`${BR}/ready`);
    const body = await r.json();
    assert.equal(r.status, 503, `expected ready 503 without authority, got ${r.status}: ${JSON.stringify(body)}`);
    assert.equal(body.ready, false);
    console.log('PASS: /ready fails closed when no managed lease or break-glass authority exists');
  }

  // A live PID is not enough: malformed executor identity must fail closed.
  {
    fs.writeFileSync(path.join(stateDir, 'executor.lock'), JSON.stringify({
      pid: process.pid,
      expiresAt: Date.now() + 60_000,
    }));
    const authority = await (await fetch(`${BR}/authority`)).json();
    assert.equal(authority.executor.lease.ambiguous, true);
    const ready = await fetch(`${BR}/ready`);
    assert.equal(ready.status, 503, 'malformed executor lease must not satisfy readiness');
    fs.unlinkSync(path.join(stateDir, 'executor.lock'));
    console.log('PASS: malformed live-PID executor lease fails closed');
  }

  // Simulate a live managed executor lease -> /authority reflects 'managed'.
  {
    fs.writeFileSync(path.join(stateDir, 'executor.lock'), JSON.stringify({
      pid: process.pid, instanceId: 'sim', acquiredAt: Date.now(), renews: 0,
      expiresAt: Date.now() + 60_000, hostname: os.hostname(),
    }));
    const body = await (await fetch(`${BR}/authority`)).json();
    assert.equal(body.observedMode, 'managed');
    assert.equal(body.executor.lease.active, true);
    // authoritative additionally requires a completed initialize handshake
    // with the upstream child, not just a lease file - no client has
    // connected yet in this test, so it must still be false here.
    assert.equal(body.authoritative, false, 'authoritative must require a proven handshake, not just a lease file');
    const ready = await fetch(`${BR}/ready`);
    assert.equal(ready.status, 200, 'a canonical live managed lease should satisfy execution-authority readiness');
    console.log('PASS: /authority reflects a canonical live managed executor lease and /ready admits it');
  }

  // Now also simulate a live break-glass marker -> ambiguous_conflict, /ready must fail (503).
  {
    fs.writeFileSync(path.join(stateDir, 'break-glass.lock'), JSON.stringify({
      pid: process.pid, acquiredAt: Date.now(), mode: 'UNMANAGED_BREAK_GLASS', hostname: os.hostname(),
    }));
    const authority = await (await fetch(`${BR}/authority`)).json();
    assert.equal(authority.observedMode, 'ambiguous_conflict');
    assert.equal(authority.authoritative, false);
    const ready = await fetch(`${BR}/ready`);
    assert.equal(ready.status, 503, 'ready must fail closed on authority ambiguity');
    console.log('PASS: dual lease+break-glass state reports ambiguous_conflict and /ready fails closed (503)');
    fs.unlinkSync(path.join(stateDir, 'executor.lock'));
    fs.unlinkSync(path.join(stateDir, 'break-glass.lock'));
  }

  console.log('PASS');
} finally {
  try { bridge.kill('SIGTERM'); } catch { /* noop */ }
  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* noop */ }
}
