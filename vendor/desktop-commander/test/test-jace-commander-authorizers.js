#!/usr/bin/env node
/**
 * ADR 0026 slice 2: authorizer resolution, presets, and the `local` preset.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadJcConfig } from '../dist/jace-commander/config.js';
import { JC_MANIFEST } from '../dist/jace-commander/manifest.generated.js';
import {
  JC_DEFAULT_CLASS_DECISIONS,
  JcConfigError,
  createAuthorizerResolver,
  validateAuthorizerTable,
} from '../dist/jace-commander/authorizers.js';
import { createJcServer } from '../dist/jace-commander/server.js';
import { readTraceFile, verifyChain } from '../dist/jace-commander/looptrace.js';
import { main } from '../dist/jace-commander/cli.js';
import { JC_EXIT } from '../dist/jace-commander/mcp-http-client.js';
import { makeIssuer } from './fixtures/jc-mint.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}
const names = JC_MANIFEST.tools.map((tool) => tool.name);

await test('managed preset resolves every tool to acs-capability; standalone to 24 local + 12 refused', () => {
  const managed = createAuthorizerResolver('managed');
  assert.ok(managed.routes().every((route) => route.authorizer === 'acs-capability'));
  assert.equal(managed.routes().length, 36);
  assert.equal(managed.usesAcs(), true);
  const standalone = createAuthorizerResolver('standalone');
  assert.equal(standalone.routes().filter((route) => route.authorizer === 'local').length, 24);
  assert.equal(standalone.routes().filter((route) => route.authorizer === 'refused').length, 12);
  assert.equal(standalone.usesAcs(), false);
  assert.equal(createAuthorizerResolver('local').routes().every((route) => route.authorizer === 'local'), true);
});

await test('precedence is per-tool, then provider, then default', () => {
  const table = validateAuthorizerTable({
    default: 'local',
    providers: { 'jc.git': 'acs-capability', 'jc.fs': 'admin-delegated' },
    tools: { git_status: 'local', read_file: 'acs-capability' },
  });
  const resolver = createAuthorizerResolver('local', table);
  const at = (tool) => resolver.resolve(tool);
  assert.deepEqual([at('git_status').authorizer, at('git_status').source], ['local', 'tool']);
  assert.deepEqual([at('git_push').authorizer, at('git_push').source], ['acs-capability', 'provider']);
  assert.deepEqual([at('write_file').authorizer, at('write_file').source], ['admin-delegated', 'provider']);
  assert.deepEqual([at('read_file').authorizer, at('read_file').source], ['acs-capability', 'tool']);
  assert.deepEqual([at('ping').authorizer, at('ping').source], ['local', 'default']);
  assert.equal(resolver.usesAcs(), true);
  assert.equal(resolver.resolve('no_such_tool'), undefined);
});

await test('invalid tables are errors: unknown keys, unknown authorizers, global admin-delegated, fixed presets', () => {
  const bad = (raw) => assert.throws(() => validateAuthorizerTable(raw), (error) => error instanceof JcConfigError && error.code === 'JC_POLICY_INVALID');
  bad(null);
  bad({ default: 'sudo' });
  bad({ default: 'admin-delegated' });
  bad({ default: 'local', extra: 1 });
  bad({ default: 'local', providers: { 'jc.nope': 'local' } });
  bad({ default: 'local', providers: { 'jc.fs': 'refused' } });
  bad({ default: 'local', tools: { no_such_tool: 'local' } });
  const table = validateAuthorizerTable({ default: 'local' });
  assert.throws(() => createAuthorizerResolver('managed', table), JcConfigError);
  assert.throws(() => createAuthorizerResolver('standalone', table), JcConfigError);
  assert.throws(() => createAuthorizerResolver('bogus'), JcConfigError);
});

await test('default class decisions: read allow, everything else approve; privileged never allow', () => {
  assert.deepEqual({ ...JC_DEFAULT_CLASS_DECISIONS }, { read: 'allow', mutate: 'approve', exec: 'approve', network: 'approve', privileged: 'approve' });
});

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-authz-')));
const issuer = makeIssuer();
const config = loadJcConfig({
  HOME: root,
  JC_STATE_DIR: path.join(root, '.jc'),
  JC_FS_ROOTS: root,
  JC_RUNTIME_ID: 'jc-test-runtime',
  JC_ACS_PUBLIC_KEY: issuer.publicKeyB64,
  JC_ACS_KEY_ID: issuer.keyId,
  JC_ACS_URL: 'http://127.0.0.1:9',
});
fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n');
const helperCalls = [];
async function connect(mode, deps = {}) {
  const server = createJcServer(config, mode, {
    helperAvailable: async () => false,
    invokeHelper: async (request) => { helperCalls.push(request); return { ok: true }; },
    fetchImpl: async () => { throw new Error('no network'); },
    ...deps,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(b);
  return client;
}

const local = await connect('local');

await test('local preset lists the whole manifest', async () => {
  assert.deepEqual((await local.listTools()).tools.map((tool) => tool.name).sort(), [...names].sort());
});

await test('local preset: read class runs with no capability, reports local authorization, ignores a presented capability', async () => {
  const read = await local.callTool({ name: 'read_file', arguments: { path: path.join(root, 'a.txt') } });
  assert.equal(read.isError, undefined, JSON.stringify(read.structuredContent));
  assert.equal(read.structuredContent.content, 'hello');
  assert.equal(read._meta.acsAuthorization.decision, 'not-required');
  assert.deepEqual(
    { authorizer: read._meta.jcAuthorization.authorizer, provider: read._meta.jcAuthorization.provider, class: read._meta.jcAuthorization.class },
    { authorizer: 'local', provider: 'jc.fs', class: 'read' },
  );
  const withCap = await local.callTool({ name: 'ping', arguments: {}, _meta: { acsCapability: 'garbage' } });
  assert.equal(withCap.isError, undefined);
});

await test('local preset: mutate/exec/network/privileged need approval; with no approver nothing runs', async () => {
  const planted = path.join(root, 'planted.txt');
  const cases = {
    write_file: { path: planted, content: 'x' },
    start_process: { argv: [process.execPath, '-e', ''], cwd: root },
    git_push: { repo: root, expectedHead: 'a'.repeat(40) },
    privileged_exec: { argv: ['/usr/bin/id'] },
  };
  for (const [name, args] of Object.entries(cases)) {
    for (const meta of [undefined, { acsCapability: issuer.mint(name, args) }]) {
      const result = await local.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
      assert.equal(result.isError, true, name);
      assert.equal(result.structuredContent.error.code, 'JC_LOCAL_APPROVAL_UNAVAILABLE', name);
      assert.equal(result._meta.jcAuthorization.decision, 'approval-unavailable');
    }
  }
  assert.equal(fs.existsSync(planted), false);
  assert.equal(helperCalls.length, 0);
});

await test('class decisions are honored: deny refuses, allow runs, and privileged can never be allow', async () => {
  const planted = path.join(root, 'allowed.txt');
  const client = await connect('local', { classDecisions: { read: 'allow', mutate: 'allow', exec: 'deny', network: 'deny', privileged: 'allow' } });
  const written = await client.callTool({ name: 'write_file', arguments: { path: planted, content: 'ok' } });
  assert.equal(written.isError, undefined, JSON.stringify(written.structuredContent));
  assert.equal(fs.readFileSync(planted, 'utf8'), 'ok');
  assert.equal(written._meta.jcAuthorization.class, 'mutate');
  const denied = await client.callTool({ name: 'start_process', arguments: { argv: [process.execPath, '-e', ''], cwd: root } });
  assert.equal(denied.structuredContent.error.code, 'JC_LOCAL_DENIED');
  const priv = await client.callTool({ name: 'privileged_exec', arguments: { argv: ['/usr/bin/id'] } });
  assert.equal(priv.structuredContent.error.code, 'JC_LOCAL_DENIED');
  assert.equal(helperCalls.length, 0);
  await client.close();
});

await test('mixed table: acs-capability / admin-delegated providers still demand a capability; local ones do not', async () => {
  const table = validateAuthorizerTable({ default: 'local', providers: { 'jc.git': 'acs-capability', 'jc.fs': 'admin-delegated' } });
  const client = await connect('local', { authorizerTable: table });
  const noCap = await client.callTool({ name: 'read_file', arguments: { path: path.join(root, 'a.txt') } });
  assert.equal(noCap.structuredContent.error.code, 'JC_CAPABILITY_MISSING');
  const args = { path: path.join(root, 'a.txt') };
  const viaCap = await client.callTool({ name: 'read_file', arguments: args, _meta: { acsCapability: issuer.mint('read_file', args) } });
  assert.equal(viaCap.isError, undefined, JSON.stringify(viaCap.structuredContent));
  assert.equal(viaCap._meta.acsAuthorization.decision, 'granted');
  assert.equal(viaCap._meta.jcAuthorization.authorizer, 'admin-delegated');
  const gitNoCap = await client.callTool({ name: 'git_status', arguments: { repo: root } });
  assert.equal(gitNoCap.structuredContent.error.code, 'JC_CAPABILITY_MISSING');
  const ping = await client.callTool({ name: 'ping', arguments: {} });
  assert.equal(ping.isError, undefined);
  await client.close();
});

await test('trace records carry authorizer, provider and risk class and the chain verifies', async () => {
  const dir = path.join(config.stateDir, 'traces');
  let seen = 0;
  for (const file of fs.readdirSync(dir).filter((entry) => entry.endsWith('.jsonl'))) {
    const { events } = readTraceFile(path.join(dir, file));
    assert.equal(verifyChain(events).ok, true, file);
    for (const event of events) {
      if (event.payload.tool === 'write_file' && event.payload.code === 'JC_LOCAL_APPROVAL_UNAVAILABLE') {
        assert.deepEqual([event.payload.authorizer, event.payload.provider, event.payload.riskClass], ['local', 'jc.fs', 'mutate']);
        seen += 1;
      }
    }
  }
  assert.ok(seen >= 1);
});

await test('CLI serve rejects an unknown preset and a --standalone/--preset conflict before starting', async () => {
  const lines = [];
  const io = { stdout: (text) => lines.push(text), stderr: (text) => lines.push(text) };
  assert.equal(await main(['serve', '--preset', 'bogus'], { HOME: root }, io), JC_EXIT.invalidArguments);
  assert.equal(await main(['serve', '--standalone', '--preset', 'local'], { HOME: root }, io), JC_EXIT.invalidArguments);
  assert.ok(lines.some((line) => /unknown preset/.test(line)));
});

await local.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(`\njace-commander authorizers: ${passed} passed`);
