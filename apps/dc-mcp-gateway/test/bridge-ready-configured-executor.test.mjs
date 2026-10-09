#!/usr/bin/env node
// Regression: bridge.js /ready must admit a canonical lease held by the
// executor the bridge itself spawned, when that executor runs from a monorepo
// layout such as <repo>/vendor/desktop-commander/dist/index.js. After #286 such
// a lease was always reported ambiguous ("lease holder is not a managed
// executor"), so /ready never passed and every Execution-chain E2E case failed
// with "bridge.js did not become ready". Plain node, no deps.
// Topology: test -> bridge.js -> stub executor at <tmp>/repo/vendor/desktop-commander/dist/index.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux') {
  console.log('SKIP: canonical executor identity is Linux-only');
  process.exit(0);
}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-configured-executor-'));
const lockDir = path.join(tmp, 'state');
const entry = path.join(tmp, 'repo', 'vendor', 'desktop-commander', 'dist', 'index.js');
fs.mkdirSync(lockDir);
fs.mkdirSync(path.dirname(entry), { recursive: true });
// The stub answers MCP like stub-dc.mjs and claims a canonical executor lease
// for its own PID exactly the way the real managed executor does.
fs.writeFileSync(entry, `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const stat = fs.readFileSync('/proc/self/stat', 'utf8');
const processStartTicks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/)[19];
const now = Date.now();
fs.writeFileSync(path.join(process.env.DESKTOP_COMMANDER_EXECUTOR_LOCK_DIR, 'executor.lock'), JSON.stringify({
  pid: process.pid, instanceId: 'executor-' + process.pid, acquiredAt: now, expiresAt: now + 60000,
  hostname: os.hostname(), bootId, processStartTicks,
}));
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.id === null) return;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'initialize'
    ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'stub', version: '0' } } : {} }) + '\\n');
});
`);
fs.writeFileSync(path.join(path.dirname(entry), 'package.json'), '{"type":"module"}');

const port = await freePort();
const BR = `http://127.0.0.1:${port}`;
const bridge = spawn(process.execPath, [path.join(ROOT, 'bridge.js')], {
  cwd: ROOT,
  env: {
    PATH: process.env.PATH ?? '',
    HOME: tmp,
    BRIDGE_PORT: String(port),
    DC_CMD: process.execPath,
    DC_ARGS: `${entry} --no-onboarding`,
    DC_CWD: tmp,
    DESKTOP_COMMANDER_EXECUTOR_LOCK_DIR: lockDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
bridge.stdout.on('data', (d) => { out += d; });
bridge.stderr.on('data', (d) => { out += d; });

try {
  // Poll until the bridge admits the lease. Another managed executor root that
  // happens to be live on this host (e.g. a concurrently running self-test) makes
  // #286 fail the topology closed transiently, so keep polling past that; the
  // regression is the bridge refusing to recognise its own configured executor.
  let last;
  let admitted = false;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (bridge.exitCode !== null) throw new Error(`bridge exited early:\n${out}`);
    try {
      const ready = await fetch(`${BR}/ready`);
      const readyBody = await ready.json();
      const authority = await (await fetch(`${BR}/authority`)).json();
      last = { status: ready.status, ready: readyBody, lease: authority.executor?.lease };
      assert.doesNotMatch(
        last.lease?.detail ?? '',
        /lease holder is not a managed executor/,
        `the bridge's own configured executor must count as a managed executor: ${JSON.stringify(last)}`,
      );
      if (last.status === 200 && last.lease?.ambiguous === false) { admitted = true; break; }
    } catch (error) {
      if (error?.code === 'ERR_ASSERTION') throw error;
      /* not listening yet */
    }
    await sleep(150);
  }
  if (admitted) {
    console.log('PASS: /ready admits a canonical lease held by the configured vendor/desktop-commander executor');
  } else {
    assert.ok(last?.lease?.active, `executor lease never appeared: ${JSON.stringify(last)}\n${out}`);
    assert.match(last.lease.detail ?? '', /topology is absent or competing/, `bridge /ready never admitted its own executor: ${JSON.stringify(last)}`);
    assert.equal(last.status, 503);
    console.log('PASS: configured executor recognised; a persistently competing host topology fails closed');
  }
  // Regression for #291 post-merge P1: a separate Node process can write
  // a lease whose cmdline merely *mentions* the configured entrypoint as an
  // inert argument to -e. This must not establish managed execution identity.
  const impostor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', entry], {
    stdio: 'ignore',
  });
  try {
    await sleep(200);
    assert.equal(impostor.exitCode, null, 'spoofing process must still be alive');
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = fs.readFileSync(`/proc/${impostor.pid}/stat`, 'utf8');
    const processStartTicks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    const now = Date.now();
    fs.writeFileSync(path.join(lockDir, 'executor.lock'), JSON.stringify({
      pid: impostor.pid, instanceId: 'impostor-' + impostor.pid,
      acquiredAt: now, expiresAt: now + 60000,
      hostname: os.hostname(), bootId, processStartTicks,
    }));
    const rejected = await fetch(`${BR}/ready`);
    const authority = await (await fetch(`${BR}/authority`)).json();
    assert.equal(rejected.status, 503, 'inert argv mention must not make a spoofed lease ready');
    assert.equal(authority.executor?.lease?.ambiguous, true);
    assert.match(
      authority.executor.lease.detail,
      /lease holder is not a managed executor/,
      'configured script must occupy the actual execution position',
    );
    console.log('PASS: inert argv mention and spoofed lease are rejected');
  } finally {
    try { impostor.kill('SIGTERM'); } catch { /* noop */ }
  }
  // A foreign runtime can execute a shell script whose filename happens to be
  // a legacy managed-release JS entrypoint. A matching argv[1] alone cannot
  // establish canonical executor identity.
  const legacy = path.join(tmp, 'releases', 'dc', 'legacy-spoof', 'dist', 'index.js');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, 'while :; do sleep 1; done\\n');
  const foreignRuntime = spawn('/bin/sh', [legacy], { stdio: 'ignore' });
  try {
    await sleep(200);
    assert.equal(foreignRuntime.exitCode, null, 'foreign runtime must remain alive for the lease probe');
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = fs.readFileSync(`/proc/${foreignRuntime.pid}/stat`, 'utf8');
    const processStartTicks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/)[19];
    const now = Date.now();
    fs.writeFileSync(path.join(lockDir, 'executor.lock'), JSON.stringify({
      pid: foreignRuntime.pid, instanceId: 'foreign-' + foreignRuntime.pid,
      acquiredAt: now, expiresAt: now + 60000,
      hostname: os.hostname(), bootId, processStartTicks,
    }));
    const rejected = await fetch(`${BR}/ready`);
    const authority = await (await fetch(`${BR}/authority`)).json();
    assert.equal(rejected.status, 503, 'foreign runtime must never establish managed readiness');
    assert.equal(authority.executor?.lease?.ambiguous, true);
    assert.match(authority.executor.lease.detail, /lease holder is not a managed executor/);
    console.log('PASS: foreign interpreter with a legacy release-layout script path rejected');
  } finally {
    try { foreignRuntime.kill('SIGTERM'); } catch { /* noop */ }
  }
  console.log('PASS');
} finally {
  try { bridge.kill('SIGTERM'); } catch { /* noop */ }
  await sleep(200);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
}
