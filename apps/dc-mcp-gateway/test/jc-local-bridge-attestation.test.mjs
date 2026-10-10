/**
 * ADR 0026: under JC_PRESET=local the bridge must not keep the legacy unauthenticated
 * loopback path. Run: node --test test/jc-local-bridge-attestation.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bridge = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bridge.js');
const PORT = 19411;
const base = { PATH: process.env.PATH, HOME: process.env.HOME, BRIDGE_PROFILE: 'jace-commander', JC_PRESET: 'local', JC_RUNTIME_ID: 'jc-test', BRIDGE_PORT: String(PORT), DC_CMD: process.execPath, JC_ALLOW_SAME_UID_CHILD: '1' };

test('local preset refuses a same-uid executor unless explicitly allowed', () => {
  const { JC_ALLOW_SAME_UID_CHILD: _omit, ...env } = base;
  const run = spawnSync(process.execPath, [bridge], { env: { ...env, DC_GATEWAY_EXECUTION_TOKEN: 'x'.repeat(40) }, encoding: 'utf8', timeout: 10_000 });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /different uid/);
});

test('local preset refuses to start without the gateway execution token', () => {
  const run = spawnSync(process.execPath, [bridge], { env: base, encoding: 'utf8', timeout: 10_000 });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /DC_GATEWAY_EXECUTION_TOKEN/);
});

test('local preset rejects a loopback call with no or forged attestation', async () => {
  const child = spawn(process.execPath, [bridge], { env: { ...base, DC_GATEWAY_EXECUTION_TOKEN: 'x'.repeat(40) }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i += 1) {
      try { await fetch(`http://127.0.0.1:${PORT}/health`); up = true; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    assert.ok(up, `bridge did not start: ${stderr.slice(0, 300)}`);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file', arguments: {} } });
    for (const headers of [{}, { 'x-dc-attestation': 'forged.sig' }]) {
      const response = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body });
      assert.equal(response.status, 401);
    }
  } finally {
    child.kill();
  }
});
