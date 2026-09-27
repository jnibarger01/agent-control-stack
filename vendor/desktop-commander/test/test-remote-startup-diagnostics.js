// The remote device must surface *why* its MCP child died during startup
// (notably an executor-lease refusal) instead of a bare "Connection closed".
// Every case uses a fixture child or an isolated HOME; nothing touches the
// live ~/.desktop-commander executor lease.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopCommanderIntegration } from '../dist/remote-device/desktop-commander-integration.js';
import { StartupStderrCapture, STARTUP_STDERR_MAX_BYTES } from '../dist/remote-device/startup-stderr.js';
import { claimCanonicalExecutor, releaseLease } from '../dist/executor-lock.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'remote-startup-child.js');
const distIndex = path.resolve(here, '..', 'dist', 'index.js');

function integrationFor(config) {
  const integration = new DesktopCommanderIntegration(true);
  integration.resolveMcpConfig = async () => config;
  return integration;
}

function fixtureIntegration(mode) {
  return integrationFor({ command: process.execPath, args: [fixture, mode] });
}

async function withQuietStderr(fn) {
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try { return await fn(); } finally { process.stderr.write = write; }
}

async function initFailure(integration) {
  try {
    await withQuietStderr(() => integration.initialize());
  } catch (error) {
    assert.equal(integration.ready, false, 'failed startup must not report ready');
    assert.equal(integration.mcpTransport, null, 'failed startup must release the transport/child');
    return error;
  }
  await integration.shutdown();
  assert.fail('initialize() was expected to fail');
}

// 1. Successful startup is unchanged: connects, tools list, clean shutdown.
{
  const integration = fixtureIntegration('ok');
  await withQuietStderr(() => integration.initialize());
  assert.equal(integration.ready, true);
  const { tools } = await integration.listClientTools();
  assert.deepEqual(tools, []);
  await integration.shutdown();
  assert.equal(integration.ready, false);
}

// 2. Early exit with an executor-lease refusal surfaces the refusal.
{
  const error = await initFailure(fixtureIntegration('lease-refused'));
  assert.match(error.message, /^MCP child exited during startup:\n/);
  assert.match(error.message, /\[executor-lease\] REFUSED to start: canonical executor lease is held \(blocked by: pid:338091\)/);
  assert.doesNotMatch(error.message, /some earlier startup log line/, 'lease diagnostic takes priority over noise');
  assert.doesNotMatch(error.message, /DC_DISABLE_EXECUTOR_LEASE/, 'the lease bypass hint is not echoed');
  assert.equal(error.cause?.code, -32000, 'original transport error is kept as cause');
}

// 3. Early exit with some other stderr message surfaces that message (sanitized).
{
  const error = await initFailure(fixtureIntegration('other-error'));
  assert.match(error.message, /^MCP child exited during startup:\n/);
  assert.match(error.message, /Error: Cannot find module '\/nonexistent\/dep\.js'/);
  assert.doesNotMatch(error.message, //, 'ANSI escapes are stripped');
}

// 4. Early exit without stderr still yields a meaningful message.
{
  const error = await initFailure(fixtureIntegration('silent-exit'));
  assert.match(error.message, /MCP child exited during startup without writing to stderr/);
  assert.match(error.message, /Connection closed/);
}

// 5. Excessive stderr is bounded, but the final line before exit survives.
{
  const error = await initFailure(fixtureIntegration('flood'));
  assert.match(error.message, /fatal: final line before exit/);
  assert.ok(error.message.length < 2200, `startup error must be bounded (got ${error.message.length} chars)`);

  const forwarded = [];
  const capture = new StartupStderrCapture(null, (chunk) => forwarded.push(chunk), 1024);
  for (let i = 0; i < 100; i++) capture.append(Buffer.from(`line ${i} ${'y'.repeat(100)}\n`));
  assert.ok(capture.bufferedBytes <= 1024, 'retained stderr never exceeds the cap');
  assert.equal(capture.wasTruncated, true);
  assert.match(capture.summary(), /line 99 /);
  capture.stop();
  assert.equal(capture.bufferedBytes, 0, 'nothing is retained after startup');
  assert.equal(STARTUP_STDERR_MAX_BYTES, 8 * 1024);
}

// 6. Real lease contention against the built executor, isolated via HOME.
//    This test process holds the lease in a temp HOME, so the dist/index.js
//    child must be refused (fail closed) and the refusal must be surfaced.
if (fs.existsSync(distIndex)) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-remote-startup-'));
  const lockDir = path.join(tmpHome, '.desktop-commander');
  fs.mkdirSync(lockDir, { recursive: true });
  const held = claimCanonicalExecutor({ lockDir });
  assert.equal(held.ok, true, 'test must hold the isolated lease');
  try {
    const integration = integrationFor({
      command: process.execPath,
      args: [distIndex, '--standalone'],
      cwd: path.dirname(distIndex),
      env: { HOME: tmpHome, USERPROFILE: tmpHome },
    });
    const error = await initFailure(integration);
    assert.match(error.message, /^MCP child exited during startup:\n/);
    assert.match(error.message, new RegExp(`\\[executor-lease\\] REFUSED to start: canonical executor lease is held \\(blocked by: [^)]*${process.pid}`));
  } finally {
    releaseLease({ lockDir });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

console.log('remote startup diagnostics tests passed');
