#!/usr/bin/env node
/**
 * Hardening item #1/#4: mutual exclusion between the ACS-managed executor and
 * the UNMANAGED/BREAK_GLASS npx fallback.
 *
 * Proves fail-closed, not just an error string:
 *   Test A — no marker present -> inactive, not ambiguous.
 *   Test B — a live break-glass marker (this test's own pid, genuinely alive)
 *            reports active, and the managed executor's startup gate
 *            (ensureCanonicalExecutorLease) refuses to start while it exists.
 *   Test C — a stale marker (dead pid) reports inactive - crash recovery
 *            does not wedge the managed executor forever.
 *   Test D — a malformed/unparsable marker fails CLOSED: reported active AND
 *            ambiguous, never silently treated as safe to proceed.
 *   Test E — authority ambiguity: executor lease AND break-glass marker both
 *            live at once observedMode is 'ambiguous_conflict', not silently
 *            resolved in either direction.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { checkBreakGlassStatus, breakGlassMarkerPath } = await import(path.join(REPO, 'dist', 'break-glass.js'));

function makeTmpState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-breakglass-'));
  return dir;
}

// Test A: no marker
{
  const dir = makeTmpState();
  const status = checkBreakGlassStatus(dir);
  assert.equal(status.active, false, 'no marker -> inactive');
  assert.equal(status.ambiguous, false, 'no marker -> not ambiguous');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('PASS: no break-glass marker -> inactive, unambiguous');
}

// Test B: live marker (this test process's own pid is genuinely alive)
{
  const dir = makeTmpState();
  const marker = path.join(dir, 'break-glass.lock');
  fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), mode: 'UNMANAGED_BREAK_GLASS', hostname: os.hostname() }));
  const status = checkBreakGlassStatus(dir);
  assert.equal(status.active, true, 'live pid marker -> active');
  assert.equal(status.ambiguous, false, 'well-formed live marker -> not ambiguous');
  assert.equal(status.info.pid, process.pid);

  // Prove the managed executor's own startup gate actually refuses while this
  // is active - not just that the status function reports it.
  const child = spawn(process.execPath, [path.join(REPO, 'dist', 'index.js')], {
    env: { ...process.env, HOME: dir, DESKTOP_COMMANDER_EXECUTOR_LOCK_DIR: dir, DC_AUDIT_DIR: path.join(dir, 'audit') },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const exitCode = await new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  assert.notEqual(exitCode, 0, 'managed executor must refuse to start while break-glass marker is live');
  assert.match(stderr, /break-glass/i, 'refusal must clearly name break-glass, not a generic failure');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('PASS: managed executor refuses startup while a live break-glass marker exists (fail closed)');
}

// Test C: stale marker (dead pid) - crash recovery, not a permanent wedge
{
  const dir = makeTmpState();
  const marker = path.join(dir, 'break-glass.lock');
  // A pid that is essentially guaranteed not to be alive in this test's pid namespace.
  const deadPid = 2_000_000_000;
  fs.writeFileSync(marker, JSON.stringify({ pid: deadPid, acquiredAt: Date.now(), mode: 'UNMANAGED_BREAK_GLASS', hostname: os.hostname() }));
  const status = checkBreakGlassStatus(dir);
  assert.equal(status.active, false, 'dead-pid marker -> inactive (stale, recoverable)');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('PASS: stale break-glass marker (dead pid) does not permanently block the managed executor');
}

// Test D: malformed marker fails CLOSED (active + ambiguous), never silently safe
{
  const dir = makeTmpState();
  const marker = path.join(dir, 'break-glass.lock');
  fs.writeFileSync(marker, 'not valid json{{{');
  const status = checkBreakGlassStatus(dir);
  assert.equal(status.active, true, 'unparsable marker must report active (fail closed)');
  assert.equal(status.ambiguous, true, 'unparsable marker must report ambiguous');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('PASS: malformed break-glass marker fails closed (active+ambiguous), never treated as safe');
}

// Test E: authority ambiguity - both a live executor lease AND a live
// break-glass marker exist at once. Neither side silently wins; the bridge's
// computeAuthority() (bridge.js) reports observedMode: 'ambiguous_conflict'
// for exactly this shape. Reproduced here at the marker-status level since
// that is the shared primitive both the managed executor and the bridge read.
{
  const dir = makeTmpState();
  fs.writeFileSync(path.join(dir, 'executor.lock'), JSON.stringify({ pid: process.pid, instanceId: 'x', acquiredAt: Date.now(), renews: 0, expiresAt: Date.now() + 60_000, hostname: os.hostname() }));
  fs.writeFileSync(path.join(dir, 'break-glass.lock'), JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), mode: 'UNMANAGED_BREAK_GLASS', hostname: os.hostname() }));
  const bg = checkBreakGlassStatus(dir);
  assert.equal(bg.active, true, 'break-glass marker still reports active even with a concurrent executor lease');
  // The managed executor's own gate must also refuse in this shape (break-glass
  // check runs before the lease is even attempted), proving the ambiguous case
  // fails closed rather than the executor silently taking over.
  const child = spawn(process.execPath, [path.join(REPO, 'dist', 'index.js')], {
    env: { ...process.env, HOME: dir, DESKTOP_COMMANDER_EXECUTOR_LOCK_DIR: dir, DC_AUDIT_DIR: path.join(dir, 'audit') },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const exitCode = await new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  assert.notEqual(exitCode, 0, 'ambiguous dual-authority state must fail closed, not let the managed executor start');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('PASS: authority ambiguity (both executor lease and break-glass live) fails closed');
}

console.log('ALL BREAK-GLASS EXCLUSION TESTS PASSED');
