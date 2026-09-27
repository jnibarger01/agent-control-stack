#!/usr/bin/env node
/**
 * Regression coverage for the executor-lease ownership model.
 *
 * Bug: src/remote-device/device.ts (supervisor) imports utils/capture.js which
 * statically imports ../server.js; server.ts used to claim the canonical
 * executor lease at MODULE INIT, so the device supervisor consumed the lease
 * and its spawned dist/index.js executor child was refused (MCP -32000).
 *
 * These tests pin the ownership contract:
 *   Test A — importing server.js as a library claims NOTHING; the spawned
 *            dist/index.js executor child owns the lease and stays up.
 *   Test B — a second independent executor while one runs is rejected (exit 1).
 *   Test C — normal shutdown (SIGTERM) releases the lease; replacement starts.
 *   Test D — stale lease (dead holder) is detected and recovered per contract.
 *   Test E — the success path is exercised WITHOUT DC_DISABLE_EXECUTOR_LEASE.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_INDEX = path.join(REPO, 'dist', 'index.js');
const DIST_SERVER = path.join(REPO, 'dist', 'server.js');

function makeTmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-ownership-'));
  // dist code resolves executor-lock and audit paths from os.homedir().
  return home;
}

function leasePath(home) { return path.join(home, '.desktop-commander', 'executor.lock'); }

function readLease(home) {
  try { return JSON.parse(fs.readFileSync(leasePath(home), 'utf8')); } catch { return null; }
}

function mkfifo(dir) { return null; } // retained for import-compat; fifo approach removed

/** Spawn dist/index.js with a held-open stdin so the stdio transport stays alive. */
function startExecutor(tmpHome, label) {
  const env = { ...process.env, HOME: tmpHome };
  assert.ok(env.DC_DISABLE_EXECUTOR_LEASE !== '1', 'Test E: DC_DISABLE_EXECUTOR_LEASE must not be set on the success path');
  const child = spawn(process.execPath, [DIST_INDEX, '--standalone'], {
    env,
    cwd: path.join(REPO, 'dist'),
    // stdin 'pipe' is held open by the parent; the stdio transport therefore
    // never sees EOF and the executor stays alive for the test.
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { child, label };
}

function waitFor(cond, timeoutMs, everyMs = 100) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const v = cond();
        if (v) return resolve(v);
      } catch (e) { /* keep polling */ }
      if (Date.now() > deadline) return reject(new Error('waitFor timeout'));
      setTimeout(tick, everyMs);
    };
    tick();
  });
}

let failures = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function run() {
  if (!fs.existsSync(DIST_INDEX) || !fs.existsSync(DIST_SERVER)) {
    throw new Error('dist not built — run npm run build first');
  }

  // ---------- Test A: library import claims nothing; child executor owns ----------
  {
    const home = makeTmpHome();
    const env = { ...process.env, HOME: home };
    delete env.DC_DISABLE_EXECUTOR_LEASE;
    // The supervisor path: statically import server.js exactly like
    // utils/capture.js does. Under the old bug this wrote executor.lock.
    execFileSync(process.execPath, ['-e', `import(${JSON.stringify(DIST_SERVER)})`], { env, cwd: REPO, timeout: 30_000 });
    check('A1: importing dist/server.js (supervisor/library path) does NOT claim the lease', !fs.existsSync(leasePath(home)));

    // The executor entrypoint (what DesktopCommanderIntegration spawns) claims.
    const a = startExecutor(home, 'A');
    try {
      await waitFor(() => readLease(home), 20_000);
      const lease = readLease(home);
      check('A2: spawned dist/index.js executor claims the lease', !!lease, `pid=${lease?.pid}`);
      check('A3: lease holder is the child executor, not any supervisor', lease?.pid === a.child.pid,
        `leasePid=${lease?.pid} childPid=${a.child.pid}`);
      check('A4: executor child stays alive after claiming', a.child.exitCode === null);
      check('A5 (Test E): success path ran without DC_DISABLE_EXECUTOR_LEASE', process.env.DC_DISABLE_EXECUTOR_LEASE !== '1' && fs.existsSync(leasePath(home)));
    } finally {
      a.child.kill('SIGKILL');
    }
  }

  // ---------- Test B: second independent executor rejected ----------
  {
    const home = makeTmpHome();
    const first = startExecutor(home, 'B-first');
    await waitFor(() => readLease(home), 20_000);
    const env = { ...process.env, HOME: home };
    const second = spawn(process.execPath, [DIST_INDEX, '--standalone'], {
      env, cwd: path.join(REPO, 'dist'), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let refused = '';
    second.stderr.on('data', (d) => { refused += d.toString(); });
    const exitCode = await new Promise((res) => second.on('close', (c) => res(c)));
    check('B1: second independent executor exits 1 (fail closed)', exitCode === 1, `exit=${exitCode}`);
    check('B2: refusal message names the blocking executor', /REFUSED to start/.test(refused), refused.split('\n')[0] ?? '');
    const lease = readLease(home);
    check('B3: original holder still owns the lease', lease?.pid === first.child.pid);
    first.child.kill('SIGKILL');
  }

  // ---------- Test C: clean release on normal shutdown ----------
  {
    const home = makeTmpHome();
    const first = startExecutor(home, 'C-first');
    await waitFor(() => readLease(home), 20_000);
    first.child.kill('SIGTERM');
    // Regression (onboarding-suite hang): SIGTERM must actually TERMINATE the
    // executor, not merely release the lease — registering a signal handler
    // disables Node's default terminate-on-signal.
    await waitFor(() => first.child.exitCode !== null, 10_000);
    check('C0: SIGTERM terminates the executor process (not just the lease)', first.child.exitCode !== null,
      `exit=${first.child.exitCode}`);
    await waitFor(() => !fs.existsSync(leasePath(home)), 10_000);
    check('C1: SIGTERM shutdown releases the lease', !fs.existsSync(leasePath(home)));
    const second = startExecutor(home, 'C-second');
    const lease = await waitFor(() => readLease(home), 20_000);
    check('C2: replacement executor starts successfully after clean release', lease?.pid === second.child.pid);
    second.child.kill('SIGKILL');
  }

  // ---------- Test D: stale lease recovery ----------
  // NOTE on the API: executorLeasePath(lockDir) places executor.lock DIRECTLY
  // in lockDir (the production default dir IS ~/.desktop-commander). Tests
  // must therefore pass the .desktop-commander dir as lockDir.
  {
    const home = makeTmpHome();
    const lockDir = path.join(home, '.desktop-commander');
    fs.mkdirSync(lockDir, { recursive: true });
    const leaseFile = path.join(lockDir, 'executor.lock');
    const deadPid = spawn('sleep', ['120']).pid;
    try { process.kill(deadPid, 'SIGKILL'); } catch {}
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(leaseFile, JSON.stringify({
      instanceId: 'dead-owner', pid: deadPid,
      acquiredAt: Date.now() - 60_000, renews: 0,
      expiresAt: Date.now() - 30_000, hostname: os.hostname(),
    }));
    const mod = await import(path.join(REPO, 'dist', 'executor-lock.js'));
    const claim = mod.claimCanonicalExecutor({ lockDir, staleAfterMs: 1000 });
    check('D1: stale lease from a dead holder is taken over', claim.ok === true && claim.tookOverStale === true,
      `ok=${claim.ok} tookOverStale=${claim.tookOverStale}`);
    check('D2: takeover rewrites the lease to the new owner', readLease(home)?.pid === process.pid);
    mod.releaseLease({ lockDir });
    // Alive holder with expired TTL must NOT be takeable (red-team fix).
    const alive = spawn('sleep', ['120']);
    fs.writeFileSync(leaseFile, JSON.stringify({
      instanceId: 'alive-owner', pid: alive.pid,
      acquiredAt: Date.now() - 600_000, renews: 0,
      expiresAt: Date.now() - 1000, hostname: os.hostname(),
    }));
    let conflict = null;
    try { mod.claimCanonicalExecutor({ lockDir, staleAfterMs: 1000 }); }
    catch (e) { conflict = e; }
    check('D3: expired TTL + ALIVE holder is still rejected (no takeover of live executors)', conflict !== null, conflict?.blockedBy ?? '');
    alive.kill('SIGKILL');
    try { fs.unlinkSync(leaseFile); } catch {}
  }

  console.log(failures === 0 ? '\nALL EXECUTOR-OWNERSHIP TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });
