#!/usr/bin/env node
/**
 * ADR 0026 slice 1: provider registry. Pure addition: coverage against the
 * manifest, derived risk classes, isolated provider health, and jc_status.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadJcConfig } from '../dist/jace-commander/config.js';
import { JC_MANIFEST } from '../dist/jace-commander/manifest.generated.js';
import { JC_TOOL_POLICIES } from '../dist/jace-commander/contract.js';
import { JC_STANDALONE_TOOL_NAMES, createJcServer } from '../dist/jace-commander/server.js';
import {
  JC_PROVIDERS,
  JC_PROVIDER_IDS,
  JC_RISK_CLASSES,
  assertProviderCoverage,
  collectProviderHealth,
  jcProviderOf,
  jcRiskClassOf,
} from '../dist/jace-commander/providers.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const manifestNames = JC_MANIFEST.tools.map((tool) => tool.name);

await test('every manifest tool has exactly one provider and no provider names an unknown tool', () => {
  assert.doesNotThrow(() => assertProviderCoverage());
  const owned = JC_PROVIDERS.flatMap((provider) => provider.tools);
  assert.equal(owned.length, new Set(owned).size, 'no tool in two providers');
  assert.deepEqual([...owned].sort(), [...manifestNames].sort());
  for (const name of manifestNames) assert.ok(JC_PROVIDER_IDS.includes(jcProviderOf(name)), name);
  assert.equal(jcProviderOf('no_such_tool'), undefined);
});

await test('coverage assertion fails on manifest drift in either direction', () => {
  assert.throws(() => assertProviderCoverage([...manifestNames, 'brand_new_tool']), /no provider for \[brand_new_tool\]/);
  assert.throws(() => assertProviderCoverage(manifestNames.filter((name) => name !== 'ping')), /not in manifest \[ping\]/);
});

await test('provider table matches the architecture draft', () => {
  const byId = Object.fromEntries(JC_PROVIDERS.map((provider) => [provider.id, provider.tools]));
  assert.deepEqual(byId['jc.privileged'], ['privileged_exec']);
  assert.deepEqual(byId.acs, ['acs_read', 'acs_submit_mission']);
  assert.deepEqual([...byId['jc.meta']].sort(), ['get_config', 'jc_doctor', 'jc_status', 'looptrace_verify', 'ping']);
  assert.deepEqual([...byId['jc.integration']].sort(), ['mission_router_list', 'swarm_read', 'visualizer_read']);
  assert.ok(byId['jc.git'].every((name) => name.startsWith('git_')));
  assert.equal(byId['jc.git'].length, 9);
  assert.equal(byId['jc.process'].length, 4);
  assert.equal(byId['jc.fs'].length, 12);
});

await test('risk classes are derived from scopes, most severe scope wins, and cover every tool', () => {
  const expected = {
    read: 24,
    mutate: 6, // write_file create_directory move_file edit_block git_add git_commit
    network: 3, // git_fetch git_push acs_submit_mission
    exec: 2, // start_process kill_process
    privileged: 1,
  };
  const counts = Object.fromEntries(JC_RISK_CLASSES.map((cls) => [cls, 0]));
  for (const name of manifestNames) counts[jcRiskClassOf(name)] += 1;
  assert.deepEqual(counts, expected);
  assert.equal(jcRiskClassOf('privileged_exec'), 'privileged');
  assert.equal(jcRiskClassOf('git_push'), 'network');
  assert.equal(jcRiskClassOf('acs_submit_mission'), 'network');
  assert.equal(jcRiskClassOf('read_file'), 'read');
  assert.equal(jcRiskClassOf('no_such_tool'), undefined);
});

await test('the read class is exactly the standalone tool set (24), so later presets cannot drift from standalone', () => {
  const readTools = manifestNames.filter((name) => jcRiskClassOf(name) === 'read' && !JC_TOOL_POLICIES[name].requiresApproval);
  assert.deepEqual([...readTools].sort(), [...JC_STANDALONE_TOOL_NAMES].sort());
  assert.equal(readTools.length, 24);
});

await test('provider health isolates a throwing, rejecting or hanging probe to its own provider', async () => {
  const health = await collectProviderHealth({
    'jc.fs': async () => { throw new Error('boom'); },
    'jc.git': () => new Promise(() => {}),
    acs: async () => ({ state: 'ok', detail: 'fine' }),
    'jc.integration': async () => ({ state: 'degraded', detail: 'swarm down' }),
  }, { timeoutMs: 50 });
  const by = Object.fromEntries(health.map((entry) => [entry.id, entry]));
  assert.equal(health.length, JC_PROVIDER_IDS.length);
  assert.equal(by['jc.fs'].state, 'unavailable');
  assert.equal(by['jc.fs'].detail, 'boom');
  assert.equal(by['jc.git'].state, 'unavailable');
  assert.match(by['jc.git'].detail, /timed out/);
  assert.equal(by.acs.state, 'ok');
  assert.equal(by['jc.integration'].state, 'degraded');
  assert.equal(by['jc.meta'].state, 'ok');
  assert.equal(by['jc.process'].state, 'ok');
  assert.equal(by['jc.meta'].required, true);
  assert.equal(by.acs.required, false);
});

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-providers-')));
const fetchLog = [];
async function connect(env, mode, fetchImpl) {
  const config = loadJcConfig({ HOME: root, JC_STATE_DIR: path.join(root, '.jc'), JC_FS_ROOTS: root, JC_RUNTIME_ID: 'jc-test-runtime', ...env });
  const server = createJcServer(config, mode, { helperAvailable: async () => false, fetchImpl });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(b);
  return client;
}
const okFetch = async (url) => {
  fetchLog.push(String(url));
  return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const downFetch = async (url) => {
  fetchLog.push(String(url));
  if (String(url).includes('3999')) throw new Error('connect ECONNREFUSED');
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};

await test('jc_status reports per-provider health, probes ACS at /readyz, and keeps its legacy fields', async () => {
  const client = await connect({ JC_ACS_URL: 'http://127.0.0.1:3999' }, 'standalone', okFetch);
  const status = (await client.callTool({ name: 'jc_status', arguments: {} })).structuredContent;
  assert.equal(status.mode, 'standalone');
  assert.equal(status.acs.reachable, true);
  assert.equal(status.privilegedHelper.sudoNonInteractive, false);
  assert.ok(fetchLog.includes('http://127.0.0.1:3999/readyz'), JSON.stringify(fetchLog));
  assert.ok(!fetchLog.includes('http://127.0.0.1:3999/health'), 'status must not call the slow deep /health');
  assert.deepEqual(status.providers.map((entry) => entry.id), [...JC_PROVIDER_IDS]);
  const by = Object.fromEntries(status.providers.map((entry) => [entry.id, entry]));
  assert.equal(by.acs.state, 'ok');
  assert.equal(by['jc.fs'].state, 'ok');
  assert.equal(by['jc.privileged'].state, 'unavailable');
  assert.equal(by['jc.meta'].state, 'ok');
  assert.equal(JSON.stringify(status).includes('PRIVATE KEY'), false);
  await client.close();
});

await test('ACS down degrades only the acs provider; every other provider is unaffected', async () => {
  const client = await connect({ JC_ACS_URL: 'http://127.0.0.1:3999' }, 'standalone', downFetch);
  const status = (await client.callTool({ name: 'jc_status', arguments: {} })).structuredContent;
  const by = Object.fromEntries(status.providers.map((entry) => [entry.id, entry]));
  assert.equal(by.acs.state, 'unavailable');
  assert.equal(status.acs.reachable, false);
  for (const id of ['jc.fs', 'jc.git', 'jc.process', 'jc.meta']) assert.equal(by[id].state, 'ok', id);
  const ping = await client.callTool({ name: 'ping', arguments: {} });
  assert.equal(ping.isError, undefined);
  await client.close();
});

await test('empty filesystem roots degrade jc.fs without failing status', async () => {
  const client = await connect({ JC_FS_ROOTS: '' }, 'standalone', okFetch);
  const status = (await client.callTool({ name: 'jc_status', arguments: {} })).structuredContent;
  const by = Object.fromEntries(status.providers.map((entry) => [entry.id, entry]));
  assert.equal(by['jc.fs'].state, 'degraded');
  assert.match(by['jc.fs'].detail, /JC_FS_ROOTS empty/);
  await client.close();
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\njace-commander providers: ${passed} passed`);
