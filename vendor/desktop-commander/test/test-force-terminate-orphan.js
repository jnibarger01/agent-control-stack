/**
 * Regression test for terminal-manager.ts forceTerminate(): the primary
 * start_process / force_terminate tool surface must not orphan descendant
 * processes when a session is killed — e.g. a shell command that itself
 * spawns a child (a pipeline, a background job, a REPL forking workers).
 *
 * Historically forceTerminate() only signaled the direct child (the shell),
 * which left any grandchild running unmanaged and unkillable through this
 * server. It now spawns sessions as their own POSIX process group leader
 * (see terminateProcessTree in utils/process-tree.ts, shared with the ACPX
 * typed process runner) and signals the whole group.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

import { terminalManager } from '../dist/terminal-manager.js';

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

async function waitForFileContent(filePath, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (content) return content;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${filePath} to be written`);
}

async function testForceTerminateKillsGrandchild() {
  console.log('\n--- Test: force_terminate does not orphan a grandchild process ---');

  const tag = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const pidFile = path.join(os.tmpdir(), `dc-orphan-test-${tag}.pid`);
  const scriptFile = path.join(os.tmpdir(), `dc-orphan-test-${tag}.cjs`);

  // The wrapper spawns a grandchild that ignores SIGINT/SIGTERM outright, so
  // only a real process-group kill (escalating to SIGKILL) can end it —
  // exactly the scenario forceTerminate() must handle for the whole tree.
  const script = `
    const { spawn } = require('child_process');
    const fs = require('fs');
    const gc = spawn(process.execPath, ['-e', "process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid));
    process.on('SIGINT', () => {});
    setInterval(() => {}, 1000);
  `;
  fs.writeFileSync(scriptFile, script);

  try {
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptFile)}`;
    const result = await terminalManager.executeCommand(command, 1500);
    assert.ok(result.pid > 0, 'expected a real pid from executeCommand');

    const grandchildPid = parseInt(await waitForFileContent(pidFile, 5000), 10);
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, 'expected a grandchild pid in the pid file');
    assert.strictEqual(isAlive(grandchildPid), true, 'grandchild should be alive before termination');

    const initiated = terminalManager.forceTerminate(result.pid);
    assert.strictEqual(initiated, true, 'forceTerminate must report it initiated termination');

    const wrapperDied = await waitUntilDead(result.pid, 5000);
    assert.strictEqual(wrapperDied, true, 'wrapper process must die after forceTerminate');

    const grandchildDied = await waitUntilDead(grandchildPid, 10000);
    assert.strictEqual(
      grandchildDied,
      true,
      'grandchild must not be orphaned after forceTerminate (process-group kill must reach it)'
    );
  } finally {
    fs.rmSync(pidFile, { force: true });
    fs.rmSync(scriptFile, { force: true });
  }

  console.log('ok: force_terminate reaches the whole process group, no orphan survives');
}

export default async function runTests() {
  if (process.platform === 'win32') {
    // Windows termination goes through taskkill /T, a different mechanism
    // covered indirectly by the ACPX runner tests; the POSIX process-group
    // behavior asserted here does not apply there.
    console.log('Skipping POSIX process-group orphan test on win32.');
    return true;
  }

  try {
    await testForceTerminateKillsGrandchild();
    console.log('\nforce_terminate orphan-cleanup tests passed.');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('force_terminate orphan-cleanup test failed:', message);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests()
    .then((success) => {
      process.exit(success ? 0 : 1);
    })
    .catch((error) => {
      console.error('Unhandled error:', error);
      process.exit(1);
    });
}
