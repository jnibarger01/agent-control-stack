#!/usr/bin/env node
/**
 * ADR 0026 slice 6: ACS is optional. Per-provider acs modes, the distinct ACS_UNAVAILABLE,
 * admin-delegated never degrading to local, and the best-effort trace mirror.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadJcConfig } from '../dist/jace-commander/config.js';
import { loadJcPolicy } from '../dist/jace-commander/local-policy.js';
import { MirrorOutbox, MIRROR_SCHEMA } from '../dist/jace-commander/mirror-outbox.js';
import { JsonlTraceChain, readTraceFile, verifyChain } from '../dist/jace-commander/looptrace.js';
import { createJcServer } from '../dist/jace-commander/server.js';
import { makeIssuer } from './fixtures/jc-mint.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-acsopt-')));
const work = path.join(root, 'work');
const repo = path.join(work, 'repo');
fs.mkdirSync(repo, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: root } });
fs.writeFileSync(path.join(work, 'a.txt'), 'hello\n');
const systemPath = path.join(root, 'pol', 'policy.json');
fs.mkdirSync(path.dirname(systemPath));
const userPath = path.join(root, 'user-policy.json');
const issuer = makeIssuer();

const writePolicy = (doc) => fs.writeFileSync(systemPath, JSON.stringify({ version: 'jc.policy.v1', constraints: { fs: { roots: [work] } }, ...doc }));
const loadPolicy = () => loadJcPolicy({ systemPath, systemPathExplicit: true, userPath, requireImmutable: false, baseFsRoots: [work] });

// ---------------------------------------------------------------- policy ----

await test('acs modes: defaults are derived, explicit values validate, off conflicts with ACS routing, user layer cannot set them', () => {
  writePolicy({});
  const plain = loadPolicy();
  assert.equal(plain.state, 'loaded');
  assert.equal(plain.effective.acsModes.acs, 'optional');
  for (const id of ['jc.fs', 'jc.git', 'jc.process', 'jc.privileged', 'jc.meta', 'jc.integration']) assert.equal(plain.effective.acsModes[id], 'off', id);

  writePolicy({ authorizers: { default: 'local', providers: { 'jc.git': 'acs-capability' } } });
  const routed = loadPolicy();
  assert.equal(routed.effective.acsModes['jc.git'], 'required', 'a provider routed to ACS defaults to required');
  assert.notEqual(routed.hash, plain.hash);

  writePolicy({ authorizers: { default: 'local', providers: { 'jc.git': 'acs-capability' } }, acs: { providers: { 'jc.git': 'optional' } } });
  assert.equal(loadPolicy().effective.acsModes['jc.git'], 'optional');

  const bad = {
    'off but routed': { authorizers: { default: 'local', providers: { 'jc.git': 'acs-capability' } }, acs: { providers: { 'jc.git': 'off' } } },
    'default off but admin-delegated': { authorizers: { default: 'local', tools: { write_file: 'admin-delegated' } }, acs: { default: 'off' } },
    'unknown mode': { acs: { providers: { acs: 'sometimes' } } },
    'unknown provider': { acs: { providers: { 'jc.nope': 'off' } } },
    'unknown key': { acs: { everything: true } },
  };
  for (const [label, doc] of Object.entries(bad)) {
    writePolicy(doc);
    assert.equal(loadPolicy().state, 'invalid', label);
  }
  writePolicy({});
  fs.writeFileSync(userPath, JSON.stringify({ version: 'jc.policy.v1', acs: { default: 'off' } }));
  assert.equal(loadPolicy().state, 'invalid', 'the user layer may not touch acs modes');
  fs.rmSync(userPath);
});

// ---------------------------------------------------------------- server ----

let seq = 0;
function configFor(extra = {}) {
  seq += 1;
  return loadJcConfig({
    HOME: root,
    JC_STATE_DIR: path.join(root, `state${seq}`),
    JC_FS_ROOTS: work,
    JC_RUNTIME_ID: 'jc-test-runtime',
    JC_POLICY_PATH: systemPath,
    JC_ACS_PUBLIC_KEY: issuer.publicKeyB64,
    JC_ACS_KEY_ID: issuer.keyId,
    JC_ACS_URL: 'http://127.0.0.1:9',
    ...extra,
  });
}
const fetchLog = [];
const acsDown = async (url) => { fetchLog.push(String(url)); throw new Error('connect ECONNREFUSED'); };
const acsUp = async (url) => { fetchLog.push(String(url)); return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }); };
async function connect(config, deps = {}) {
  const server = createJcServer(config, 'local', { helperAvailable: async () => false, fetchImpl: acsDown, policy: loadPolicy(), ...deps });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(b);
  return client;
}
const code = (result) => result.structuredContent?.error?.code;

await test('with ACS completely absent every local tool works; the acs provider degrades alone', async () => {
  writePolicy({ classes: { mutate: 'allow' } });
  const client = await connect(configFor());
  fetchLog.length = 0;
  assert.equal((await client.callTool({ name: 'read_file', arguments: { path: path.join(work, 'a.txt') } })).isError, undefined);
  assert.equal((await client.callTool({ name: 'write_file', arguments: { path: path.join(work, 'b.txt'), content: 'ok' } })).isError, undefined);
  assert.equal((await client.callTool({ name: 'ping', arguments: {} })).isError, undefined);
  assert.equal((await client.callTool({ name: 'git_status', arguments: { repo } })).isError, undefined);
  assert.equal(fetchLog.some((url) => url.includes('/readyz')), false, 'local tools never probe ACS');
  const down = await client.callTool({ name: 'acs_read', arguments: { view: 'health' } });
  assert.equal(code(down), 'ACS_UNAVAILABLE');
  const status = (await client.callTool({ name: 'jc_status', arguments: {} })).structuredContent;
  const by = Object.fromEntries(status.providers.map((entry) => [entry.id, entry]));
  assert.equal(by.acs.state, 'unavailable');
  for (const id of ['jc.fs', 'jc.git', 'jc.process', 'jc.meta']) assert.equal(by[id].state, 'ok', id);
  assert.equal(status.acsModes.acs, 'optional');
  assert.deepEqual(status.mirror, { enabled: false });
  await client.close();
});

await test('acs "off" for the acs provider refuses without touching the network', async () => {
  writePolicy({ acs: { providers: { acs: 'off' } } });
  const client = await connect(configFor());
  fetchLog.length = 0;
  const result = await client.callTool({ name: 'acs_read', arguments: { view: 'health' } });
  assert.equal(code(result), 'ACS_DISABLED');
  assert.deepEqual(fetchLog, []);
  await client.close();
});

await test('ACS_UNAVAILABLE vs JC_CAPABILITY_MISSING is decided by ACS readiness; a presented capability still verifies offline', async () => {
  writePolicy({ authorizers: { default: 'local', providers: { 'jc.git': 'acs-capability' } } });
  const gitArgs = { repo };
  const down = await connect(configFor(), { fetchImpl: acsDown });
  assert.equal(code(await down.callTool({ name: 'git_status', arguments: gitArgs })), 'ACS_UNAVAILABLE');
  assert.equal((await down.callTool({ name: 'read_file', arguments: { path: path.join(work, 'a.txt') } })).isError, undefined, 'a local provider is unaffected by the outage');
  const viaCap = await down.callTool({ name: 'git_status', arguments: gitArgs, _meta: { acsCapability: issuer.mint('git_status', gitArgs) } });
  assert.equal(viaCap.isError, undefined, JSON.stringify(viaCap.structuredContent));
  assert.equal(viaCap._meta.acsAuthorization.decision, 'granted');
  const priv = await down.callTool({ name: 'privileged_exec', arguments: { argv: ['/usr/bin/id'] } });
  assert.equal(code(priv), 'JC_LOCAL_APPROVAL_UNAVAILABLE', 'privileged is a local-authorizer tool here, unaffected by ACS');
  await down.close();

  const up = await connect(configFor(), { fetchImpl: acsUp });
  assert.equal(code(await up.callTool({ name: 'git_status', arguments: gitArgs })), 'JC_CAPABILITY_MISSING');
  await up.close();

  writePolicy({ authorizers: { default: 'local', providers: { 'jc.privileged': 'acs-capability' } } });
  const privDown = await connect(configFor(), { fetchImpl: acsDown });
  assert.equal(code(await privDown.callTool({ name: 'privileged_exec', arguments: { argv: ['/usr/bin/id'] } })), 'ACS_UNAVAILABLE');
  await privDown.close();
});

await test('admin-delegated never degrades to local: with ACS down or capability missing the call is refused and nothing runs', async () => {
  writePolicy({ classes: { mutate: 'allow' }, authorizers: { default: 'local', providers: { 'jc.fs': 'admin-delegated' } } });
  const target = path.join(work, 'delegated.txt');
  const args = { path: target, content: 'x' };

  const down = await connect(configFor(), { fetchImpl: acsDown });
  assert.equal(code(await down.callTool({ name: 'write_file', arguments: args })), 'ACS_UNAVAILABLE');
  assert.equal(fs.existsSync(target), false, 'local policy would have allowed it; it must not run');
  await down.close();

  const upConfig = configFor();
  const up = await connect(upConfig, { fetchImpl: acsUp });
  assert.equal(code(await up.callTool({ name: 'write_file', arguments: args })), 'JC_CAPABILITY_MISSING');
  assert.equal(fs.existsSync(target), false);
  const granted = await up.callTool({ name: 'write_file', arguments: args, _meta: { acsCapability: issuer.mint('write_file', args) } });
  assert.equal(granted.isError, undefined, JSON.stringify(granted.structuredContent));
  assert.equal(fs.readFileSync(target, 'utf8'), 'x');
  assert.equal(granted._meta.jcAuthorization.authorizer, 'admin-delegated');
  assert.equal(granted._meta.acsAuthorization.decision, 'granted');
  const dir = path.join(upConfig.stateDir, 'traces');
  const events = fs.readdirSync(dir).flatMap((f) => readTraceFile(path.join(dir, f)).events).filter((event) => event.payload.tool === 'write_file' && !event.payload.code);
  assert.deepEqual(events.map((event) => event.type), ['tool_call_started', 'tool_call_finished'], 'admin-delegated writes an intent record too');
  assert.equal(events[0].payload.authorizer, 'admin-delegated');
  await up.close();
});

await test('required ACS makes jc_doctor fail when ACS is down; optional does not', async () => {
  const report = async (fetchImpl) => {
    const client = await connect(configFor(), { fetchImpl });
    const status = (await client.callTool({ name: 'jc_status', arguments: {} })).structuredContent;
    const doctor = (await client.callTool({ name: 'jc_doctor', arguments: {} })).structuredContent;
    await client.close();
    return { status, acsCheck: doctor.checks.find((entry) => entry.name === 'acs'), ok: doctor.ok };
  };
  writePolicy({ classes: { mutate: 'deny', exec: 'deny', network: 'deny', privileged: 'deny' }, authorizers: { default: 'local', providers: { 'jc.git': 'acs-capability' } } });
  const requiredDown = await report(acsDown);
  assert.equal(requiredDown.acsCheck.required, true);
  assert.equal(requiredDown.acsCheck.ok, false);
  assert.equal(requiredDown.ok, false);
  assert.equal(requiredDown.status.providers.find((entry) => entry.id === 'jc.git').required, true);
  assert.equal((await report(acsUp)).acsCheck.ok, true);

  // No class sends calls to a human here, so only the ACS requirement is under test.
  writePolicy({ classes: { mutate: 'deny', exec: 'deny', network: 'deny', privileged: 'deny' } });
  const optionalDown = await report(acsDown);
  assert.equal(optionalDown.acsCheck.required, false);
  assert.equal(optionalDown.acsCheck.ok, false);
  assert.equal(optionalDown.ok, true, 'an optional ACS being down does not fail the report');
});

// ---------------------------------------------------------------- mirror ----

function seedTrace(dir, runId, count) {
  const chain = new JsonlTraceChain(path.join(dir, `${runId}.jsonl`), runId);
  for (let i = 0; i < count; i += 1) chain.append('tool_call_finished', { tool: 'ping', n: i, argumentsSha256: 'a'.repeat(64), policyHash: `${runId}`.padEnd(64, 'p') });
}
const bytesOf = (dir) => fs.readdirSync(dir).sort().map((f) => `${f}:${fs.readFileSync(path.join(dir, f), 'utf8')}`).join('\n');

await test('mirror: runs are ordered by when they started, not by file name', async () => {
  const dir = path.join(root, 'm0', 'traces');
  const newerLow = new JsonlTraceChain(path.join(dir, 'jc-mcp-100-2.jsonl'), 'run-newer');
  newerLow.append('tool_call_finished', { tool: 'ping' }, '2026-10-10T10:00:00.000Z');
  const olderHigh = new JsonlTraceChain(path.join(dir, 'jc-mcp-999-1.jsonl'), 'run-older');
  olderHigh.append('tool_call_finished', { tool: 'ping' }, '2026-10-09T10:00:00.000Z');
  const sent = [];
  const outbox = new MirrorOutbox({ traceDir: dir, stateDir: path.join(root, 'm0'), runtimeId: 'jc-x', send: async (b) => { sent.push(b); return { ok: true }; }, batchSize: 1 });
  assert.equal(await outbox.pump(), true);
  assert.equal(sent[0].runs[0].runId, 'run-older');
});

await test('mirror: ordered, contiguous, idempotent batches; the cursor advances only on confirmed success', async () => {
  const dir = path.join(root, 'm1', 'traces');
  const stateDir = path.join(root, 'm1');
  seedTrace(dir, 'run-aaaaaa', 5);
  const before = bytesOf(dir);
  const sent = [];
  let healthy = false;
  const send = async (batch) => { sent.push(batch); return { ok: healthy, status: healthy ? 200 : 503 }; };
  const outbox = new MirrorOutbox({ traceDir: dir, stateDir, runtimeId: 'jc-x', send, batchSize: 2 });

  assert.equal(await outbox.pump(), false);
  assert.equal(outbox.status().failures, 1);
  assert.equal(outbox.status().pending, 5);
  assert.equal(await outbox.pump(), false);
  assert.equal(sent[0].batchId, sent[1].batchId, 'a retry resends the identical batch');
  assert.equal(sent[0].schema, MIRROR_SCHEMA);
  assert.equal(sent[0].runs[0].policyHash, 'run-aaaaaa'.padEnd(64, 'p'), 'each run carries its own policy hash');
  assert.equal(sent[0].policyHash, undefined);

  healthy = true;
  assert.equal(await outbox.pump(), true);
  assert.equal(await outbox.pump(), true);
  assert.equal(await outbox.pump(), true);
  assert.equal(await outbox.pump(), false, 'nothing left to send');
  const ok = sent.slice(2);
  assert.deepEqual(ok.map((batch) => [batch.runs[0].fromSeq, batch.runs[0].events.length]), [[0, 2], [2, 2], [4, 1]]);
  assert.equal(ok[0].runs[0].prevHash, '0'.repeat(64));
  assert.equal(ok[1].runs[0].prevHash, ok[0].runs[0].chainHead, 'batches chain together');
  assert.equal(ok[2].runs[0].prevHash, ok[1].runs[0].chainHead);
  assert.equal(outbox.status().pending, 0);
  assert.equal(outbox.status().failures, 0);
  assert.equal(JSON.stringify(sent).includes('"arguments"'), false, 'only digests are mirrored, never raw arguments');
  assert.equal(bytesOf(dir), before, 'the mirror never modifies the local trace');
});

await test('mirror: a sender that throws never propagates, and the cursor survives a restart', async () => {
  const dir = path.join(root, 'm2', 'traces');
  const stateDir = path.join(root, 'm2');
  seedTrace(dir, 'run-bbbbbb', 3);
  const boom = new MirrorOutbox({ traceDir: dir, stateDir, runtimeId: 'jc-x', send: async () => { throw new Error('socket hang up'); } });
  assert.equal(await boom.pump(), false);
  assert.match(boom.status().lastError, /socket hang up/);
  const seen = [];
  const first = new MirrorOutbox({ traceDir: dir, stateDir, runtimeId: 'jc-x', batchSize: 2, send: async (batch) => { seen.push(batch); return { ok: true }; } });
  assert.equal(await first.pump(), true);
  const second = new MirrorOutbox({ traceDir: dir, stateDir, runtimeId: 'jc-x', batchSize: 2, send: async (batch) => { seen.push(batch); return { ok: true }; } });
  assert.equal(await second.pump(), true);
  assert.deepEqual(seen.map((batch) => [batch.runs[0].fromSeq, batch.runs[0].events.length]), [[0, 2], [2, 1]], 'a new instance resumes, not restarts');
  fs.writeFileSync(path.join(dir, 'garbage.jsonl'), '{nope');
  assert.equal(await second.pump(), false, 'an unreadable trace file is skipped, not fatal');
});

await test('mirror: over the bound the OLDEST records are skipped for delivery only and reported as explicit gaps', async () => {
  const dir = path.join(root, 'm3', 'traces');
  const stateDir = path.join(root, 'm3');
  seedTrace(dir, 'run-cccccc', 10);
  const before = bytesOf(dir);
  const sent = [];
  const outbox = new MirrorOutbox({ traceDir: dir, stateDir, runtimeId: 'jc-x', maxPending: 4, batchSize: 100, send: async (batch) => { sent.push(batch); return { ok: true }; } });
  assert.equal(await outbox.pump(), true);
  assert.deepEqual(sent[0].gaps, [{ runId: 'run-cccccc', fromSeq: 0, toSeq: 5 }]);
  assert.deepEqual(sent[0].runs[0].events.map((event) => event.seq), [6, 7, 8, 9]);
  assert.equal(sent[0].runs[0].prevHash, readTraceFile(path.join(dir, 'run-cccccc.jsonl')).events[5].hash, 'prevHash lets ACS see exactly where the gap is');
  assert.equal(outbox.status().gaps, 0, 'gaps are cleared once ACS confirmed receipt');
  assert.equal(bytesOf(dir), before, 'nothing is dropped from the local trace');
  assert.equal(verifyChain(readTraceFile(path.join(dir, 'run-cccccc.jsonl')).events).ok, true);
});

await test('mirror in the server: ACS down never affects a call or the local chain; when it returns, records arrive in order', async () => {
  writePolicy({ classes: { mutate: 'allow' } });
  const config = configFor({ JC_ACS_MIRROR_URL: 'http://127.0.0.1:9/mirror', JC_ACS_MIRROR_INTERVAL_MS: '100' });
  const batches = [];
  let healthy = false;
  const client = await connect(config, { mirrorSender: async (batch) => { batches.push(batch); return { ok: healthy, status: healthy ? 200 : 502 }; } });
  for (let i = 0; i < 3; i += 1) {
    const result = await client.callTool({ name: 'write_file', arguments: { path: path.join(work, `mirrored${i}.txt`), content: String(i) } });
    assert.equal(result.isError, undefined, 'a mirror outage must not fail a tool call');
  }
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.ok(batches.length >= 1, 'the mirror attempted delivery');
  assert.ok((await client.callTool({ name: 'jc_status', arguments: {} })).structuredContent.mirror.pending >= 6);
  healthy = true;
  await new Promise((resolve) => setTimeout(resolve, 450));
  const status = (await client.callTool({ name: 'jc_status', arguments: {} })).structuredContent.mirror;
  assert.equal(status.failures, 0);
  assert.ok(status.lastSuccessAt);
  const delivered = batches.filter((batch) => batch.runs.length).at(-1);
  assert.ok(delivered.runs[0].events.every((event, i, all) => i === 0 || event.seq === all[i - 1].seq + 1), 'contiguous sequence');
  const dir = path.join(config.stateDir, 'traces');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) assert.equal(verifyChain(readTraceFile(path.join(dir, file)).events).ok, true);
  await client.close();
});

await test('mirror over HTTP: POSTs jc.trace.mirror.v1 to JC_ACS_MIRROR_URL with the ACS bearer credential', async () => {
  writePolicy({});
  const posts = [];
  const fetchImpl = async (url, init) => {
    if (init?.method === 'POST') posts.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  process.env.JC_ACS_TOKEN = 'test-acs-token';
  try {
    const config = configFor({ JC_ACS_MIRROR_URL: 'http://127.0.0.1:9/jc/trace/ingest', JC_ACS_MIRROR_INTERVAL_MS: '100' });
    const client = await connect(config, { fetchImpl });
    await client.callTool({ name: 'ping', arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.ok(posts.length >= 1, 'mirror posted');
    assert.equal(posts[0].url, 'http://127.0.0.1:9/jc/trace/ingest');
    assert.equal(posts[0].headers.authorization, 'Bearer test-acs-token');
    assert.equal(posts[0].body.schema, MIRROR_SCHEMA);
    assert.equal(posts[0].body.runtimeId, 'jc-test-runtime');
    await client.close();
  } finally {
    delete process.env.JC_ACS_TOKEN;
  }
});

await test('mirroring is local-preset only: managed and standalone never start it', async () => {
  const config = configFor({ JC_ACS_MIRROR_URL: 'http://127.0.0.1:9/mirror' });
  const server = createJcServer(config, 'standalone', { helperAvailable: async () => false, fetchImpl: acsDown, mirrorSender: async () => { throw new Error('must not be used'); } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(b);
  assert.equal((await client.callTool({ name: 'jc_status', arguments: {} })).structuredContent.mirror, undefined);
  await client.close();
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\njace-commander acs-optional: ${passed} passed`);
