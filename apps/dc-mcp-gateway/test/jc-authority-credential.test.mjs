/**
 * The JC bridge reports the dedicated current-authority credential, and only
 * that credential, as configured. The model-facing JC_ACS_TOKEN and the worker
 * token must never satisfy readiness: without the dedicated read-scoped token
 * JC refuses every non-read call, so the lane must not report ready.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { jcBridgeReady } from '../readiness.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseEnv = {
  PATH: process.env.PATH, HOME: process.env.HOME, BRIDGE_PROFILE: 'jace-commander', ACS_MANAGED_MODE: '1',
  DC_CMD: process.execPath, DC_ARGS: `${path.join(root, 'test', 'stub-jc.mjs')} serve`, JC_DC_DIR: root,
  JC_ACS_PUBLIC_KEY: 'test-key', JC_ACS_KEY_ID: 'test-key-id', JC_RUNTIME_ID: 'test-runtime',
  DC_GATEWAY_EXECUTION_TOKEN: 'e'.repeat(40),
};

async function authority(t, overrides) {
  const listener = net.createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const env = { ...baseEnv, BRIDGE_PORT: String(port) };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const child = spawn(process.execPath, [path.join(root, 'bridge.js')], { env, stdio: ['ignore', 'ignore', 'ignore'] });
  t.after(async () => {
    if (child.exitCode === null) {
      const exit = once(child, 'exit');
      child.kill();
      await exit;
    }
  });
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/authority`);
      if (response.ok) {
        const report = await response.json();
        const ready = await fetch(`http://127.0.0.1:${port}/ready`);
        Object.defineProperty(report, 'readyProbe', { value: { status: ready.status, body: await ready.json() } });
        return report;
      }
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('bridge did not start');
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-authority-credential-'));
const tokenFile = path.join(dir, 'jc-authority.token');
const emptyFile = path.join(dir, 'empty.token');
fs.writeFileSync(tokenFile, 'read-only-authority-token\n', { mode: 0o600 });
fs.writeFileSync(emptyFile, '\n', { mode: 0o600 });
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const configured = (report) => report.enforcement.currentAuthorityCredentialConfigured;

test('the dedicated token file is configured and the bridge /ready is 200', async (t) => {
  const report = await authority(t, { JC_ACS_AUTHORITY_TOKEN_FILE: tokenFile });
  assert.equal(configured(report), true);
  assert.equal(report.readyProbe.status, 200, JSON.stringify(report.readyProbe.body));
  assert.equal(report.readyProbe.body.ready, true);
});

test('the dedicated token variable is configured', async (t) => {
  assert.equal(configured(await authority(t, { JC_ACS_AUTHORITY_TOKEN: 'read-only-authority-token' })), true);
});

for (const [name, overrides] of [
  ['nothing set', {}],
  ['only the model-facing JC_ACS_TOKEN (no fallback)', { JC_ACS_TOKEN: 'model-facing' }],
  ['only the worker token (no fallback)', { ACS_WORKER_TOKEN: 'worker', ACS_GATEWAY_URL: 'http://127.0.0.1:9' }],
  ['a missing token file, with JC_ACS_TOKEN set', { JC_ACS_AUTHORITY_TOKEN_FILE: path.join(dir, 'missing'), JC_ACS_TOKEN: 'model-facing' }],
  ['an empty token file, with JC_ACS_TOKEN set', { JC_ACS_AUTHORITY_TOKEN_FILE: emptyFile, JC_ACS_TOKEN: 'model-facing' }],
  ['a blank token variable, with JC_ACS_TOKEN set', { JC_ACS_AUTHORITY_TOKEN: '   ', JC_ACS_TOKEN: 'model-facing' }],
]) {
  test(`not configured and not ready: ${name}`, async (t) => {
    const report = await authority(t, overrides);
    assert.equal(configured(report), false);
    // The bridge's own /ready must not claim readiness either (it used to check only the child).
    assert.equal(report.readyProbe.status, 503);
    assert.equal(report.readyProbe.body.ready, false);
    assert.ok(report.readyProbe.body.notReady.some((reason) => /JC_ACS_AUTHORITY_TOKEN_FILE/.test(reason)), JSON.stringify(report.readyProbe.body));
    // The edge's /jc/ready predicate refuses the lane even when everything else holds.
    const otherwiseReady = { ...report, authoritative: true, bridge: { ...report.bridge, hasUpstreamPair: true, upstreamStarted: true, initialized: true } };
    assert.equal(jcBridgeReady(otherwiseReady), false);
    assert.equal(jcBridgeReady({ ...otherwiseReady, enforcement: { ...report.enforcement, currentAuthorityCredentialConfigured: true } }), true);
  });
}
