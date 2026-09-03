import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalMcpRuntime } from '../dist/local-runtime.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-local-runtime-'));
const stateDir = path.join(root, 'child-state');
process.env.DESKTOP_COMMANDER_STATE_DIR = path.join(root, 'parent-state');

function childPids() {
  if (process.platform === 'win32') return [];
  try {
    return fs.readFile(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8')
      .then((text) => text.trim().split(/\s+/).filter(Boolean).map(Number));
  } catch {
    return Promise.resolve([]);
  }
}

async function waitForChildCount(expected, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let observed = await childPids();
  while (observed.length !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    observed = await childPids();
  }
  return observed;
}

const runtime = createLocalMcpRuntime({
  startupTimeoutMs: 15_000,
  healthTimeoutMs: 5_000,
  shutdownTimeoutMs: 5_000,
  env: {
    DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1',
    DESKTOP_COMMANDER_STATE_DIR: stateDir,
  },
});

try {
  const before = await childPids();
  const firstStart = runtime.start();
  const secondStart = runtime.start();
  assert.equal(firstStart, secondStart, 'concurrent start calls must share one startup');
  await Promise.all([firstStart, secondStart]);

  const health = await runtime.health();
  assert.equal(health.ok, true, JSON.stringify(health));
  assert.equal(health.state, 'ready');
  assert.ok((health.tool_count ?? 0) > 0, 'health must prove tools/list works');
  assert.ok(health.runtime_identity?.runtime_id, 'health must expose stable runtime identity');

  const identityResult = await runtime.callTool('get_runtime_identity');
  const identityPayload = JSON.parse(identityResult.content[0].text);
  assert.equal(identityPayload.runtime_id, health.runtime_identity.runtime_id);
  assert.equal(identityPayload.authorization, 'external');

  const smokeFile = path.join(stateDir, 'safe-smoke.txt');
  await fs.writeFile(smokeFile, 'desktop-commander-filesystem-smoke\n');
  const readResult = await runtime.callTool('read_file', { path: smokeFile, offset: 0, length: 10 });
  assert.match(readResult.content[0].text, /desktop-commander-filesystem-smoke/);

  const processCommand = `${JSON.stringify(process.execPath)} -e "process.stdout.write('desktop-commander-process-smoke')"`;
  const processResult = await runtime.callTool('start_process', {
    command: processCommand,
    cwd: stateDir,
    timeout_ms: 5_000,
  });
  assert.equal(processResult.isError, undefined, processResult.content[0].text);
  assert.match(processResult.content[0].text, /desktop-commander-process-smoke/);

  const during = await childPids();
  if (process.platform !== 'win32') {
    assert.equal(during.length - before.length, 1, `expected exactly one local MCP child, before=${before} during=${during}`);
  }

  const firstStop = runtime.shutdown();
  const secondStop = runtime.shutdown();
  assert.equal(firstStop, secondStop, 'concurrent shutdown calls must share one shutdown');
  await Promise.all([firstStop, secondStop]);

  const stopped = await runtime.health();
  assert.equal(stopped.ok, false);
  assert.equal(stopped.state, 'stopped');
  if (process.platform !== 'win32') {
    const after = await waitForChildCount(before.length);
    assert.equal(after.length, before.length, `local MCP child must be reaped, before=${before} after=${after}`);
  }

  await assert.rejects(() => runtime.start(), (error) => error?.code === 'RUNTIME_STOPPED');

  const hanging = createLocalMcpRuntime({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: process.cwd(),
    startupTimeoutMs: 100,
    shutdownTimeoutMs: 2_000,
    env: { DESKTOP_COMMANDER_STATE_DIR: stateDir },
  });
  await assert.rejects(
    () => hanging.start(),
    (error) => error?.code === 'STARTUP_TIMEOUT',
    'a child that never speaks MCP must fail with a structured startup timeout',
  );
  const failedHealth = await hanging.health();
  assert.equal(failedHealth.ok, false);
  assert.equal(failedHealth.state, 'failed');
  assert.equal(failedHealth.error?.code, 'STARTUP_TIMEOUT');
  await hanging.shutdown();
  if (process.platform !== 'win32') {
    const afterTimeout = await waitForChildCount(before.length);
    assert.equal(afterTimeout.length, before.length, `timed-out child must be reaped, before=${before} after=${afterTimeout}`);
  }

  const interrupted = createLocalMcpRuntime({
    startupTimeoutMs: 15_000,
    shutdownTimeoutMs: 2_000,
    env: { DESKTOP_COMMANDER_STATE_DIR: path.join(root, 'interrupted-state') },
  });
  const interruptedStart = interrupted.start();
  await interrupted.shutdown();
  await assert.rejects(
    () => interruptedStart,
    (error) => error?.code === 'STARTUP_CANCELLED',
    'shutdown racing startup must cancel before a child can survive',
  );
  if (process.platform !== 'win32') {
    const afterInterrupted = await waitForChildCount(before.length);
    assert.equal(afterInterrupted.length, before.length, `shutdown/start race must not leave a child, before=${before} after=${afterInterrupted}`);
  }

  const inheritedIdentity = createLocalMcpRuntime({ startupTimeoutMs: 15_000, shutdownTimeoutMs: 5_000 });
  await inheritedIdentity.start();
  const inheritedHealth = await inheritedIdentity.health();
  const inheritedToolResult = await inheritedIdentity.callTool('get_runtime_identity');
  const inheritedToolIdentity = JSON.parse(inheritedToolResult.content[0].text);
  assert.equal(
    inheritedHealth.runtime_identity.runtime_id,
    inheritedToolIdentity.runtime_id,
    'process-level identity path overrides must be forwarded to the child',
  );
  await inheritedIdentity.shutdown();
  if (process.platform !== 'win32') {
    const afterInherited = await waitForChildCount(before.length);
    assert.equal(afterInherited.length, before.length, `inherited-identity runtime must reap its child, before=${before} after=${afterInherited}`);
  }

  const originalCwd = process.cwd();
  process.chdir(root);
  try {
    const relativeIdentity = createLocalMcpRuntime({
      startupTimeoutMs: 15_000,
      shutdownTimeoutMs: 5_000,
      env: { DESKTOP_COMMANDER_STATE_DIR: 'relative-child-state' },
    });
    await relativeIdentity.start();
    const relativeHealth = await relativeIdentity.health();
    const relativeResult = await relativeIdentity.callTool('get_runtime_identity');
    assert.equal(
      relativeHealth.runtime_identity.runtime_id,
      JSON.parse(relativeResult.content[0].text).runtime_id,
      'relative identity paths must be normalized before the child changes cwd',
    );
    await relativeIdentity.shutdown();
  } finally {
    process.chdir(originalCwd);
  }

  console.log('local MCP runtime startup, health, singleton, and shutdown tests passed');
} finally {
  await runtime.shutdown().catch(() => undefined);
  delete process.env.DESKTOP_COMMANDER_STATE_DIR;
  await fs.rm(root, { recursive: true, force: true });
}
