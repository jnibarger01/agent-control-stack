#!/usr/bin/env node
/**
 * jace-commander MCP server: managed gating, integration views, and that
 * privileged_exec is delegated to the helper (never decided locally).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadJcConfig } from '../dist/jace-commander/config.js';
import { createJcServer } from '../dist/jace-commander/server.js';
import { JC_TOOL_POLICIES } from '../dist/jace-commander/contract.js';
import { JC_MANIFEST } from '../dist/jace-commander/manifest.generated.js';
import { buildEvent, GENESIS_HASH } from '../dist/jace-commander/looptrace.js';
import { makeIssuer } from './fixtures/jc-mint.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-server-'));
const issuer = makeIssuer();
delete process.env.JC_ACS_TOKEN;
const config = loadJcConfig({
  HOME: tmp,
  JC_STATE_DIR: path.join(tmp, 'state'),
  JC_RUNTIME_ID: 'jc-test-runtime',
  JC_ACS_PUBLIC_KEY: issuer.publicKeyB64,
  JC_ACS_KEY_ID: issuer.keyId,
  JC_ACS_URL: 'http://127.0.0.1:3999',
  JC_SWARM_URL: 'http://127.0.0.1:9711',
  JC_MISSION_ROUTER_DIR: path.join(tmp, 'mr'),
  JC_TRACE_ROOTS: path.join(tmp, 'traces'),
});

const fetchLog = [];
const fakeFetch = async (url, init = {}) => {
  fetchLog.push({ url: String(url), method: init.method ?? 'GET', auth: init.headers?.authorization });
  const body = String(url).endsWith('/readyz') ? { status: 'ok' } : { url: String(url) };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};
const helperCalls = [];
const fakeHelper = async (request) => {
  helperCalls.push(request);
  return { ok: true, exitCode: 0, stdout: 'ran\n' };
};

async function connect(mode) {
  const server = createJcServer(config, mode, { fetchImpl: fakeFetch, invokeHelper: fakeHelper, helperAvailable: async () => false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientTransport);
  return client;
}
const parse = (result) => JSON.parse(result.content[0].text);

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };

const managed = await connect('managed');
const standalone = await connect('standalone');

await test('lists exactly the governed tool set (derived from the generated manifest)', async () => {
  const { tools } = await managed.listTools();
  const expected = JC_MANIFEST.tools.map((t) => t.name).sort();
  assert.deepEqual(tools.map((t) => t.name).sort(), expected);
  assert.deepEqual(Object.keys(JC_TOOL_POLICIES).sort(), expected);
  // The original control-plane tools are still served (compatibility).
  for (const legacy of ['acs_read', 'acs_submit_mission', 'jc_status', 'looptrace_verify', 'mission_router_list', 'privileged_exec', 'swarm_read', 'visualizer_read']) {
    assert.ok(expected.includes(legacy), `${legacy} must remain available`);
  }
});

await test('managed: a call without a capability is rejected before any upstream request', async () => {
  const before = fetchLog.length;
  const result = await managed.callTool({ name: 'acs_read', arguments: { view: 'health' } });
  assert.equal(result.isError, true);
  assert.equal(parse(result).error.code, 'JC_CAPABILITY_MISSING');
  assert.equal(fetchLog.length, before);
});

await test('managed: a valid capability is granted and attributed', async () => {
  const args = { view: 'health' };
  const result = await managed.callTool({ name: 'acs_read', arguments: args, _meta: { acsCapability: issuer.mint('acs_read', args) } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(parse(result), { status: 'ok' });
  assert.equal(result._meta.acsAuthorization.decision, 'granted');
  assert.equal(result._meta.acsAuthorization.workItemId, 'wi-123');
  assert.equal(fetchLog.at(-1).url, 'http://127.0.0.1:3999/readyz');
});

await test('standalone: integration reads work without a capability; views are allowlisted', async () => {
  const result = await standalone.callTool({ name: 'swarm_read', arguments: { view: 'status', taskId: 'task-1' } });
  assert.equal(parse(result).url, 'http://127.0.0.1:9711/api/v1/readonly/status?task_id=task-1');
  const bad = await standalone.callTool({ name: 'swarm_read', arguments: { view: 'task', taskId: '../../etc' } });
  assert.equal(parse(bad).error.code, 'invalid_argument');
});

await test('oversized upstream bodies are cut off while streaming, not after buffering', async () => {
  let pulled = 0;
  const huge = new ReadableStream({
    pull(controller) {
      pulled += 1;
      if (pulled > 10_000) return controller.close();
      controller.enqueue(new Uint8Array(64 * 1024));
    },
  });
  const { requestJson } = await import('../dist/jace-commander/integrations.js');
  await assert.rejects(
    requestJson('http://127.0.0.1:1/x', { timeoutMs: 5000, fetchImpl: async () => new Response(huge, { status: 200 }) }),
    (error) => error.code === 'response_too_large',
  );
  assert.ok(pulled < 100, `stopped reading after ~2 MiB (pulled ${pulled} chunks)`);
});

await test('visualizer requires an explicit loopback URL', async () => {
  const result = await standalone.callTool({ name: 'visualizer_read', arguments: { view: 'system-status' } });
  assert.equal(parse(result).error.code, 'not_configured');
});

// acs_submit_mission is integration.write, so it is managed-only (PR #212 B5).
const managedCall = (name, args) => managed.callTool({ name, arguments: args, _meta: { acsCapability: issuer.mint(name, args) } });

await test('acs_submit_mission without an ACS credential does not call ACS', async () => {
  const before = fetchLog.length;
  const result = await managedCall('acs_submit_mission', { title: 't', intent: 'i', target: {} });
  assert.equal(parse(result).error.code, 'acs_not_logged_in');
  assert.equal(fetchLog.length, before);
});

await test('acs_submit_mission posts only governed fields with the bearer token', async () => {
  process.env.JC_ACS_TOKEN = 'test-token-value';
  try {
    const result = await managedCall('acs_submit_mission', { title: 'apt update', intent: 'refresh package lists', target: { services: ['apt'] }, correlationId: 'corr-1' });
    assert.equal(result.isError, undefined);
    const call = fetchLog.at(-1);
    assert.equal(call.url, 'http://127.0.0.1:3999/work-items');
    assert.equal(call.method, 'POST');
    assert.equal(call.auth, 'Bearer test-token-value');
  } finally {
    delete process.env.JC_ACS_TOKEN;
  }
});

await test('privileged_exec with no capability is refused without touching sudo', async () => {
  const result = await managed.callTool({ name: 'privileged_exec', arguments: { argv: ['/usr/bin/id'] } });
  assert.equal(parse(result).error.code, 'JC_CAPABILITY_MISSING');
  assert.equal(helperCalls.length, 0);
});

await test('privileged_exec is not served in standalone mode at all, even with a capability', async () => {
  const args = { argv: ['/usr/bin/id'] };
  const result = await standalone.callTool({ name: 'privileged_exec', arguments: args, _meta: { acsCapability: issuer.mint('privileged_exec', args) } });
  assert.equal(parse(result).error.code, 'JC_STANDALONE_TOOL_REFUSED');
  assert.equal(helperCalls.length, 0);
});

await test('privileged_exec is delegated verbatim to the helper in managed mode (no local consumption)', async () => {
  const args = { argv: ['/usr/bin/id'] };
  const cap = issuer.mint('privileged_exec', args);
  const result = await managed.callTool({ name: 'privileged_exec', arguments: args, _meta: { acsCapability: cap } });
  assert.equal(result.isError, undefined);
  assert.equal(helperCalls.length, 1);
  assert.deepEqual(helperCalls[0], { capability: cap, arguments: args });
  assert.equal(result._meta.acsAuthorization.decision, 'delegated-to-privileged-helper');
});

await test('looptrace_verify enforces trace roots and verifies chains', async () => {
  const dir = path.join(tmp, 'traces');
  fs.mkdirSync(dir, { recursive: true });
  const e0 = buildEvent('jc-run-xyz', 0, GENESIS_HASH, 'task_received', {}, '2026-09-26T00:00:00.000Z');
  fs.writeFileSync(path.join(dir, 'ok.jsonl'), `${JSON.stringify(e0)}\n`);
  const good = parse(await standalone.callTool({ name: 'looptrace_verify', arguments: { path: path.join(dir, 'ok.jsonl') } }));
  assert.equal(good.ok, true);
  assert.equal(good.events, 1);
  const outside = parse(await standalone.callTool({ name: 'looptrace_verify', arguments: { path: '/etc/passwd' } }));
  assert.equal(outside.error.code, 'path_not_allowed');
  const escape = parse(await standalone.callTool({ name: 'looptrace_verify', arguments: { path: path.join(dir, '..', 'state', 'x.jsonl') } }));
  assert.equal(escape.error.code, 'path_not_allowed');
});

await test('mission_router_list returns ids/states only, never mission bodies', async () => {
  const dir = path.join(tmp, 'mr', 'missions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'm1.json'), JSON.stringify({ id: 'm1', state: 'AWAITING_APPROVAL', goal: 'SECRET-GOAL' }));
  const listing = parse(await standalone.callTool({ name: 'mission_router_list', arguments: {} }));
  assert.deepEqual(listing.missions, [{ file: path.join('missions', 'm1.json'), id: 'm1', state: 'AWAITING_APPROVAL' }]);
  assert.equal(JSON.stringify(listing).includes('SECRET-GOAL'), false);
});

await test('jc_status reports mode, endpoints and helper availability without secrets', async () => {
  const status = parse(await standalone.callTool({ name: 'jc_status', arguments: {} }));
  assert.equal(status.mode, 'standalone');
  assert.equal(status.publicMcpUrl, 'https://jacen-ubuntu.tailaa6d41.ts.net/jc/mcp');
  assert.equal(status.privilegedHelper.sudoNonInteractive, false);
  assert.equal(status.acs.reachable, true);
});

await test('tool calls are recorded to a verifiable local LoopTrace projection', async () => {
  const traceDir = path.join(config.stateDir, 'traces');
  const files = fs.readdirSync(traceDir).filter((f) => f.endsWith('.jsonl'));
  assert.ok(files.length >= 1);
  const { readTraceFile, verifyChain } = await import('../dist/jace-commander/looptrace.js');
  for (const file of files) assert.equal(verifyChain(readTraceFile(path.join(traceDir, file)).events).ok, true);
});

await managed.close();
await standalone.close();
console.log(`\njace-commander server: ${passed} passed`);
