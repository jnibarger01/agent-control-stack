#!/usr/bin/env node
/**
 * Regression (PR #212 review B5): `jace-commander serve --standalone` has no
 * ACS capability, so it must not register, list, or dispatch any tool that is
 * approval-gated or has a non-read scope. Before the fix a standalone server
 * wrote files and spawned processes for any MCP client
 * (repro: /tmp/acs212-repro/standalone.mjs). Managed mode is unchanged.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadJcConfig } from '../dist/jace-commander/config.js';
import { JC_MANIFEST } from '../dist/jace-commander/manifest.generated.js';
import { JC_STANDALONE_TOOL_NAMES, createJcServer, jcStandaloneToolAllowed } from '../dist/jace-commander/server.js';
import { makeIssuer } from './fixtures/jc-mint.js';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-standalone-')));
const repo = path.join(root, 'repo');
fs.mkdirSync(repo);
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: root };
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: gitEnv });
fs.writeFileSync(path.join(root, 'existing.txt'), 'original\n');
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

const MUTATING = ['write_file', 'move_file', 'edit_block', 'create_directory', 'start_process', 'kill_process',
  'git_add', 'git_commit', 'git_fetch', 'git_push', 'privileged_exec', 'acs_submit_mission'];
const gated = JC_MANIFEST.tools.filter((tool) => tool.requiresApproval || tool.scopes.some((scope) => !scope.endsWith('.read')));

// Arguments that would succeed in managed mode, so a refusal can only come from the standalone gate.
const planted = path.join(root, 'planted.sh');
const ARGS = {
  write_file: { path: planted, content: 'echo pwned\n' },
  move_file: { from: path.join(root, 'existing.txt'), to: path.join(root, 'moved.txt') },
  edit_block: { path: path.join(root, 'existing.txt'), old: 'original', new: 'pwned' },
  create_directory: { path: path.join(root, 'made') },
  start_process: { argv: [process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], "ran")', path.join(root, 'ran.txt')], cwd: root },
  kill_process: { pid: process.pid },
  git_add: { repo, paths: ['.'] },
  git_commit: { repo, message: 'pwned' },
  git_fetch: { repo },
  git_push: { repo, expectedHead: 'a'.repeat(40) },
  privileged_exec: { argv: ['/usr/bin/id'] },
  acs_submit_mission: { title: 't', intent: 'i', target: {} },
};

const standalone = await connect('standalone');
const managed = await connect('managed');

await test('the gated set is derived from the manifest and covers every approval-gated / non-read tool', async () => {
  assert.deepEqual(gated.map((tool) => tool.name).sort(), [...MUTATING].sort());
  for (const tool of gated) assert.equal(jcStandaloneToolAllowed(tool.name), false, tool.name);
  assert.equal(jcStandaloneToolAllowed('no_such_tool'), false);
  assert.equal(JC_STANDALONE_TOOL_NAMES.length, JC_MANIFEST.tools.length - gated.length);
});

await test('standalone tools/list omits every write, exec, git-mutation and approval-gated tool', async () => {
  const names = (await standalone.listTools()).tools.map((tool) => tool.name);
  for (const name of MUTATING) assert.ok(!names.includes(name), `${name} must not be listed in standalone`);
  assert.deepEqual([...names].sort(), [...JC_STANDALONE_TOOL_NAMES].sort());
  for (const name of ['read_file', 'list_directory', 'start_search', 'git_status', 'jc_status']) assert.ok(names.includes(name), name);
});

await test('standalone refuses every gated tool if called directly (with or without a capability); nothing happens', async () => {
  for (const name of MUTATING) {
    const args = ARGS[name];
    for (const meta of [undefined, { acsCapability: issuer.mint(name, args) }]) {
      const result = await standalone.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
      assert.equal(result.isError, true, `${name}: ${JSON.stringify(result.structuredContent)}`);
      assert.equal(result.structuredContent.error.code, 'JC_STANDALONE_TOOL_REFUSED', name);
    }
  }
  assert.equal(fs.existsSync(planted), false, 'write_file must not have written');
  assert.equal(fs.readFileSync(path.join(root, 'existing.txt'), 'utf8'), 'original\n');
  assert.equal(fs.existsSync(path.join(root, 'moved.txt')), false);
  assert.equal(fs.existsSync(path.join(root, 'made')), false);
  assert.equal(fs.existsSync(path.join(root, 'ran.txt')), false, 'start_process must not have run');
  assert.equal(helperCalls.length, 0);
});

await test('standalone read tools still work', async () => {
  const read = await standalone.callTool({ name: 'read_file', arguments: { path: path.join(root, 'existing.txt') } });
  assert.equal(read.isError, undefined, JSON.stringify(read.structuredContent));
  assert.equal(read.structuredContent.content, 'original');
  const listed = await standalone.callTool({ name: 'list_directory', arguments: { path: root } });
  assert.equal(listed.isError, undefined);
  const search = await standalone.callTool({ name: 'start_search', arguments: { path: root, pattern: 'original', mode: 'content' } });
  assert.equal(search.structuredContent.matched, 1);
  const status = await standalone.callTool({ name: 'git_status', arguments: { repo } });
  assert.equal(status.isError, undefined, JSON.stringify(status.structuredContent));
});

await test('managed mode is unchanged: lists the whole manifest and runs an approved write with a capability', async () => {
  const names = (await managed.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, JC_MANIFEST.tools.map((tool) => tool.name).sort());
  const args = ARGS.write_file;
  const result = await managed.callTool({ name: 'write_file', arguments: args, _meta: { acsCapability: issuer.mint('write_file', args) } });
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  assert.equal(fs.readFileSync(planted, 'utf8'), 'echo pwned\n');
});

await standalone.close();
await managed.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(`\njace-commander standalone gating: ${passed} passed`);
