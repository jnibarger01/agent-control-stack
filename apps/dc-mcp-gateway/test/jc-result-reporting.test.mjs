#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function extractSseData(text) {
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) {
      try { return JSON.parse(line.slice(5).trim()); } catch { /* continue */ }
    }
  }
  return null;
}

async function startFixture() {
  const [bridgePort, acsPort] = await Promise.all([freePort(), freePort()]);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-result-reporting-'));
  const reports = [];
  const acs = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      reports.push({ path: req.url, auth: req.headers.authorization, body });
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => acs.listen(acsPort, '127.0.0.1', resolve));

  const bridge = spawn(process.execPath, [path.join(ROOT, 'bridge.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      BRIDGE_PORT: String(bridgePort),
      BRIDGE_PROFILE: 'jace-commander',
      ACS_MANAGED_MODE: '1',
      DC_CMD: process.execPath,
      DC_ARGS: `${path.join(ROOT, 'test', 'stub-jc.mjs')} serve`,
      DC_CWD: ROOT,
      JC_STATE_DIR: stateDir,
      JC_ACS_PUBLIC_KEY: 'test-public-key',
      JC_ACS_KEY_ID: 'test-key',
      JC_RUNTIME_ID: 'jc-test-runtime',
      JC_ACS_URL: `http://127.0.0.1:${acsPort}`,
      ACS_JC_GATEWAY_TOKEN: 'jc-worker-token'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  bridge.stdout.on('data', (data) => { output += data; });
  bridge.stderr.on('data', (data) => { output += data; });

  const base = `http://127.0.0.1:${bridgePort}`;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch { /* starting */ }
    if (bridge.exitCode !== null) throw new Error(`bridge exited early:\n${output}`);
    await sleep(50);
  }
  const healthy = await fetch(`${base}/healthz`);
  assert.equal(healthy.status, 200, output);

  const init = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
    })
  });
  assert.equal(init.status, 200);
  assert.ok(extractSseData(await init.text())?.result);
  const sessionId = init.headers.get('mcp-session-id');
  assert.ok(sessionId);

  return {
    base,
    sessionId,
    reports,
    close: async () => {
      bridge.kill('SIGTERM');
      await new Promise((resolve) => bridge.once('exit', resolve));
      await new Promise((resolve) => acs.close(resolve));
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  };
}

function capability(toolName, suffix) {
  return {
    payload: {
      version: 'acs.jc.v1',
      audience: 'jace-commander',
      toolName,
      normalizedArguments: toolName === 'hang' ? {} : { view: 'health' },
      workItemId: `wrk_${suffix}`,
      attemptId: `attempt_${suffix}`,
      leaseId: `lease_${suffix}`,
      leaseEpoch: 1,
      planHash: 'a'.repeat(64),
      actionHash: 'b'.repeat(64),
      invocationHash: 'c'.repeat(64)
    },
    signature: 'test-signature',
    keyId: 'test-key'
  };
}

async function call(fixture, toolName, suffix, signal) {
  return fetch(`${fixture.base}/mcp`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': fixture.sessionId
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: suffix,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: toolName === 'hang' ? {} : { view: 'health' },
        _meta: {
          acsCapability: capability(toolName, suffix),
          acsLeaseBinding: {
            claimActionHash: 'b'.repeat(64),
            inputHash: 'd'.repeat(64),
            workerId: 'acs-jc-bridge'
          }
        }
      }
    })
  });
}

async function waitForReport(fixture, suffix) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const report = fixture.reports.find((entry) => entry.path === `/work-items/wrk_${suffix}/results`);
    if (report) return report;
    await sleep(20);
  }
  throw new Error(`result report not observed for ${suffix}`);
}

test('JC bridge reports successful governed execution with the JC worker identity', async () => {
  const fixture = await startFixture();
  try {
    const response = await call(fixture, 'acs_read', 'success');
    assert.equal(response.status, 200);
    const report = await waitForReport(fixture, 'success');
    assert.equal(report.auth, 'Bearer jc-worker-token');
    assert.equal(report.body.workerId, 'acs-jc-bridge');
    assert.equal(report.body.outcome, 'succeeded');
    assert.equal(report.body.simulationMetadata.executionMode, 'jace_commander');
    assert.equal(report.body.simulationMetadata.backend, 'jace-commander-mcp');
  } finally {
    await fixture.close();
  }
});

test('JC bridge reports a failed terminal result when a governed session closes mid-call', async () => {
  const fixture = await startFixture();
  try {
    const abort = new AbortController();
    const pending = call(fixture, 'hang', 'hang', abort.signal).catch(() => undefined);
    await sleep(50);
    const closed = await fetch(`${fixture.base}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': fixture.sessionId }
    });
    assert.ok([200, 202, 204].includes(closed.status));
    abort.abort();
    await pending;
    const report = await waitForReport(fixture, 'hang');
    assert.equal(report.body.workerId, 'acs-jc-bridge');
    assert.equal(report.body.outcome, 'failed');
    assert.match(report.body.summary, /session closed|failed/i);
  } finally {
    await fixture.close();
  }
});

test('JC bridge reports JSON-RPC executor errors as failed terminal results', async () => {
  const fixture = await startFixture();
  try {
    const response = await call(fixture, 'error', 'error');
    assert.equal(response.status, 200);
    const report = await waitForReport(fixture, 'error');
    assert.equal(report.body.workerId, 'acs-jc-bridge');
    assert.equal(report.body.outcome, 'failed');
    assert.match(report.body.summary, /stub executor error/);
  } finally {
    await fixture.close();
  }
});

test('a governed call dropped before routing still reports a failed terminal result', async () => {
  // Regression: an already-authorized governed call (it carries an ACS-issued
  // capability) can be dropped by the bridge before the generic result path
  // runs - here because the session it names is gone. Nothing else would ever
  // report it, so the attempt-bound execution-admission permit would be held
  // for the whole ACS lease. The bridge must report the non-delivery, with the
  // lease binding ACS validates against.
  const fixture = await startFixture();
  try {
    const response = await fetch(`${fixture.base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'session-that-no-longer-exists'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'abandoned',
        method: 'tools/call',
        params: {
          name: 'acs_read',
          arguments: { view: 'health' },
          _meta: {
            acsCapability: capability('acs_read', 'abandoned'),
            acsLeaseBinding: {
              claimActionHash: 'b'.repeat(64),
              inputHash: 'd'.repeat(64),
              workerId: 'acs-jc-bridge'
            }
          }
        }
      })
    });
    assert.equal(response.status, 400);
    const report = await waitForReport(fixture, 'abandoned');
    assert.equal(report.auth, 'Bearer jc-worker-token');
    assert.equal(report.body.workerId, 'acs-jc-bridge');
    assert.equal(report.body.outcome, 'failed');
    assert.equal(report.body.attemptId, 'attempt_abandoned');
    assert.equal(report.body.leaseId, 'lease_abandoned');
    assert.equal(report.body.planHash, 'a'.repeat(64));
    assert.equal(report.body.actionHash, 'b'.repeat(64));
    assert.equal(report.body.inputHash, 'd'.repeat(64));
    assert.equal(report.body.fencingEpoch, 1);
  } finally {
    await fixture.close();
  }
});
