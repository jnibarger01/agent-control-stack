#!/usr/bin/env node
/**
 * ADR 0026 parity gate. A golden matrix, derived from the manifest and NOT from
 * the provider/authorizer code under change, that pins today's behavior for the
 * `managed` and `standalone` presets across all 36 tools. Every rollout slice
 * must keep this file green: new authorizers may add rows, never change these.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadJcConfig } from '../dist/jace-commander/config.js';
import { JC_MANIFEST } from '../dist/jace-commander/manifest.generated.js';
import { createJcServer } from '../dist/jace-commander/server.js';
import { makeIssuer } from './fixtures/jc-mint.js';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-parity-')));
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
const helperCalls = [];
async function connect(mode) {
  const server = createJcServer(config, mode, {
    helperAvailable: async () => false,
    invokeHelper: async (request) => { helperCalls.push(request); return { ok: true }; },
    fetchImpl: async () => { throw new Error('no network in this test'); },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(b);
  return client;
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const all = JC_MANIFEST.tools;
const names = all.map((tool) => tool.name);
// Golden standalone set, from the manifest alone (not the code under change).
const standaloneAllowed = all.filter((tool) => !tool.requiresApproval && tool.scopes.every((scope) => scope.endsWith('.read'))).map((tool) => tool.name);
const standaloneRefused = names.filter((name) => !standaloneAllowed.includes(name));

const managed = await connect('managed');
const standalone = await connect('standalone');

await test('golden: 36 tools, 24 standalone-allowed, 12 refused', () => {
  assert.equal(names.length, 36);
  assert.equal(standaloneAllowed.length, 24);
  assert.equal(standaloneRefused.length, 12);
});

await test('managed: tools/list is the whole manifest', async () => {
  assert.deepEqual((await managed.listTools()).tools.map((tool) => tool.name).sort(), [...names].sort());
});

await test('managed: with no capability EVERY tool is denied before its handler runs (including liveness tools)', async () => {
  for (const name of names) {
    const result = await managed.callTool({ name, arguments: {} });
    assert.equal(result.isError, true, name);
    assert.equal(result.structuredContent.error.code, 'JC_CAPABILITY_MISSING', name);
  }
  assert.equal(helperCalls.length, 0);
});

await test('managed: unknown tool and malformed capability keep their codes', async () => {
  const unknown = await managed.callTool({ name: 'no_such_tool', arguments: {} });
  assert.equal(unknown.structuredContent.error.code, 'unknown_tool');
  const malformed = await managed.callTool({ name: 'ping', arguments: {}, _meta: { acsCapability: 'nope' } });
  assert.equal(malformed.structuredContent.error.code, 'JC_CAPABILITY_MALFORMED');
});

await test('managed: a valid capability for a non-approval tool runs, is single-use, and reports its authorization', async () => {
  const capability = issuer.mint('ping', {});
  const first = await managed.callTool({ name: 'ping', arguments: {}, _meta: { acsCapability: capability } });
  assert.equal(first.isError, undefined, JSON.stringify(first.structuredContent));
  assert.equal(first._meta.jaceCommanderMode, 'managed');
  assert.equal(first._meta.acsAuthorization.decision, 'granted');
  assert.equal(first._meta.acsAuthorization.version, 'acs.jc.v1');
  const replay = await managed.callTool({ name: 'ping', arguments: {}, _meta: { acsCapability: capability } });
  assert.equal(replay.structuredContent.error.code, 'JC_CAPABILITY_NONCE_REPLAY');
});

await test('managed: privileged_exec without a capability never reaches the helper; with one it is delegated to it', async () => {
  const denied = await managed.callTool({ name: 'privileged_exec', arguments: { argv: ['/usr/bin/id'] } });
  assert.equal(denied.structuredContent.error.code, 'JC_CAPABILITY_MISSING');
  assert.equal(denied._meta.acsAuthorization.decision, 'delegated-to-privileged-helper');
  assert.equal(helperCalls.length, 0);
  const args = { argv: ['/usr/bin/id'] };
  const delegated = await managed.callTool({ name: 'privileged_exec', arguments: args, _meta: { acsCapability: issuer.mint('privileged_exec', args) } });
  assert.equal(delegated.isError, undefined, JSON.stringify(delegated.structuredContent));
  assert.equal(helperCalls.length, 1);
});

await test('standalone: lists exactly the 24 read-only tools', async () => {
  assert.deepEqual((await standalone.listTools()).tools.map((tool) => tool.name).sort(), [...standaloneAllowed].sort());
});

await test('standalone: every refused tool returns JC_STANDALONE_TOOL_REFUSED, with or without a capability', async () => {
  for (const name of standaloneRefused) {
    for (const meta of [undefined, { acsCapability: issuer.mint(name, {}) }]) {
      const result = await standalone.callTool({ name, arguments: {}, ...(meta ? { _meta: meta } : {}) });
      assert.equal(result.structuredContent.error.code, 'JC_STANDALONE_TOOL_REFUSED', name);
      assert.equal(result._meta.acsAuthorization.decision, 'refused-standalone', name);
    }
  }
});

await test('standalone: allowed tools need no capability and report not-required', async () => {
  for (const name of ['ping', 'get_config', 'jc_status', 'list_processes']) {
    const result = await standalone.callTool({ name, arguments: {} });
    assert.equal(result.isError, undefined, `${name}: ${JSON.stringify(result.structuredContent)}`);
    assert.equal(result._meta.acsAuthorization.decision, 'not-required', name);
    assert.equal(result._meta.jaceCommanderMode, 'standalone');
  }
});

await managed.close();
await standalone.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(`\njace-commander parity: ${passed} passed`);
