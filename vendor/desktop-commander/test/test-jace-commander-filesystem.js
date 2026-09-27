#!/usr/bin/env node
/**
 * jace-commander read-only filesystem tools (fs.read): list_directory,
 * get_file_info, read_file, read_multiple_files.
 *
 * Exercised through the real MCP server in managed mode, so every call also
 * proves the acs.jc.v1 capability gate: no capability, or a capability for
 * different arguments, never reaches the filesystem.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadJcConfig } from '../dist/jace-commander/config.js';
import { createJcServer } from '../dist/jace-commander/server.js';
import { makeIssuer } from './fixtures/jc-mint.js';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-fs-')));
const home = path.join(tmp, 'home');
const root = path.join(home, 'projects');
const outside = path.join(tmp, 'outside');
const stateDir = path.join(home, '.jace-commander');
for (const dir of [root, path.join(root, 'app', 'src'), outside, stateDir, path.join(home, '.ssh')]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(root, 'app', 'package.json'), '{"name":"app"}\n');
fs.writeFileSync(path.join(root, 'app', 'src', 'index.ts'), Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') + '\n');
fs.writeFileSync(path.join(root, 'app', '.env'), 'SECRET=1\n');
fs.writeFileSync(path.join(root, 'app', 'relay.env'), 'KEY=1\n');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside\n');
fs.writeFileSync(path.join(stateDir, 'credentials.json'), '{}\n');
fs.symlinkSync(outside, path.join(root, 'escape'));
fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape-file.txt'));

const issuer = makeIssuer();
const baseEnv = {
  HOME: home,
  JC_STATE_DIR: stateDir,
  JC_RUNTIME_ID: 'jc-test-runtime',
  JC_ACS_PUBLIC_KEY: issuer.publicKeyB64,
  JC_ACS_KEY_ID: issuer.keyId,
  JC_TRACE_ROOTS: path.join(tmp, 'traces'),
};

async function connect(env, mode = 'managed') {
  const server = createJcServer(loadJcConfig(env), mode, { helperAvailable: async () => false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientTransport);
  return client;
}

const managed = await connect({ ...baseEnv, JC_FS_ROOTS: home });
const unconfigured = await connect(baseEnv);

/** Call exactly as the gateway does: an ACS capability bound to these exact arguments. */
const call = (client, name, args) => client.callTool({ name, arguments: args, _meta: { acsCapability: issuer.mint(name, args) } });
const errorCode = (result) => result.structuredContent?.error?.code ?? JSON.parse(result.content[0].text).error?.code;

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };

await test('list_directory returns structured, sorted entries and recurses to depth', async () => {
  const shallow = await call(managed, 'list_directory', { path: path.join(root, 'app') });
  assert.equal(shallow.isError, undefined);
  const names = shallow.structuredContent.entries.map((e) => e.path);
  assert.deepEqual(names, ['.env', 'package.json', 'relay.env', 'src']);
  assert.equal(shallow.structuredContent.entries.find((e) => e.name === 'src').type, 'directory');
  assert.equal(shallow.structuredContent.entries.find((e) => e.name === 'package.json').size, 15);
  const deep = await call(managed, 'list_directory', { path: path.join(root, 'app'), depth: 2 });
  assert.ok(deep.structuredContent.entries.some((e) => e.path === path.join('src', 'index.ts')));
});

await test('list_directory never follows a symlinked directory out of the root', async () => {
  const listed = await call(managed, 'list_directory', { path: root, depth: 3 });
  const escape = listed.structuredContent.entries.find((e) => e.name === 'escape');
  assert.equal(escape.type, 'symlink');
  assert.ok(!listed.structuredContent.entries.some((e) => e.path.startsWith(`escape${path.sep}`)));
});

await test('list_directory omits denied locations inside a root (JC state dir, ~/.ssh)', async () => {
  const listed = await call(managed, 'list_directory', { path: home });
  const names = listed.structuredContent.entries.map((e) => e.name);
  assert.ok(names.includes('projects'));
  assert.ok(!names.includes('.jace-commander'));
  assert.ok(!names.includes('.ssh'));
});

await test('get_file_info reports type, size, permissions and line count', async () => {
  const info = await call(managed, 'get_file_info', { path: path.join(root, 'app', 'src', 'index.ts') });
  assert.equal(info.isError, undefined);
  assert.equal(info.structuredContent.type, 'file');
  assert.equal(info.structuredContent.lineCount, 50);
  assert.match(info.structuredContent.permissions, /^[0-7]{3}$/);
  const dir = await call(managed, 'get_file_info', { path: root });
  assert.equal(dir.structuredContent.type, 'directory');
});

await test('read_file returns a bounded line window with totals', async () => {
  const file = path.join(root, 'app', 'src', 'index.ts');
  const full = await call(managed, 'read_file', { path: file });
  assert.equal(full.structuredContent.totalLines, 50);
  assert.equal(full.structuredContent.hasMore, false);
  const partial = await call(managed, 'read_file', { path: file, offset: 10, length: 5 });
  assert.equal(partial.structuredContent.content, 'line 10\nline 11\nline 12\nline 13\nline 14');
  assert.equal(partial.structuredContent.returnedLines, 5);
  assert.equal(partial.structuredContent.hasMore, true);
  const tail = await call(managed, 'read_file', { path: file, offset: -2 });
  assert.match(tail.structuredContent.content, /line 48\nline 49/);
});

await test('read_file on a directory is a structured is_a_directory error', async () => {
  assert.equal(errorCode(await call(managed, 'read_file', { path: root })), 'is_a_directory');
});

await test('nonexistent path is a structured not_found error', async () => {
  assert.equal(errorCode(await call(managed, 'read_file', { path: path.join(root, 'nope.txt') })), 'not_found');
  assert.equal(errorCode(await call(managed, 'get_file_info', { path: path.join(root, 'nope.txt') })), 'not_found');
});

await test('path outside every root is refused (path_not_allowed)', async () => {
  assert.equal(errorCode(await call(managed, 'read_file', { path: path.join(outside, 'secret.txt') })), 'path_not_allowed');
  assert.equal(errorCode(await call(managed, 'list_directory', { path: outside })), 'path_not_allowed');
});

await test('a symlink inside a root that points outside it is refused', async () => {
  assert.equal(errorCode(await call(managed, 'read_file', { path: path.join(root, 'escape-file.txt') })), 'path_not_allowed');
  assert.equal(errorCode(await call(managed, 'list_directory', { path: path.join(root, 'escape') })), 'path_not_allowed');
});

await test('credential files and JC state are refused even inside a root (path_denied)', async () => {
  assert.equal(errorCode(await call(managed, 'read_file', { path: path.join(root, 'app', '.env') })), 'path_denied');
  assert.equal(errorCode(await call(managed, 'read_file', { path: path.join(root, 'app', 'relay.env') })), 'path_denied');
  assert.equal(errorCode(await call(managed, 'read_file', { path: path.join(stateDir, 'credentials.json') })), 'path_denied');
  assert.equal(errorCode(await call(managed, 'list_directory', { path: path.join(home, '.ssh') })), 'path_denied');
});

await test('read_multiple_files reports each file independently', async () => {
  const result = await call(managed, 'read_multiple_files', {
    paths: [path.join(root, 'app', 'package.json'), path.join(outside, 'secret.txt'), path.join(root, 'missing')],
  });
  assert.equal(result.isError, undefined);
  const { files, failed } = result.structuredContent;
  assert.equal(failed, 2);
  assert.equal(files[0].ok, true);
  assert.equal(files[0].content, '{"name":"app"}');
  assert.deepEqual(files.slice(1).map((f) => f.code), ['path_not_allowed', 'not_found']);
});

await test('no JC_FS_ROOTS configured: every filesystem tool fails closed', async () => {
  for (const [name, args] of [
    ['list_directory', { path: root }],
    ['get_file_info', { path: root }],
    ['read_file', { path: path.join(root, 'app', 'package.json') }],
  ]) {
    assert.equal(errorCode(await call(unconfigured, name, args)), 'fs_roots_unconfigured', name);
  }
  const many = await call(unconfigured, 'read_multiple_files', { paths: [path.join(root, 'app', 'package.json')] });
  assert.equal(many.structuredContent.files[0].code, 'fs_roots_unconfigured');
});

await test('managed: no capability, or one for different arguments, never reaches the filesystem', async () => {
  const target = path.join(root, 'app', 'package.json');
  const bare = await managed.callTool({ name: 'read_file', arguments: { path: target } });
  assert.equal(errorCode(bare), 'JC_CAPABILITY_MISSING');
  const swapped = await managed.callTool({
    name: 'read_file',
    arguments: { path: path.join(outside, 'secret.txt') },
    _meta: { acsCapability: issuer.mint('read_file', { path: target }) },
  });
  assert.equal(errorCode(swapped), 'JC_CAPABILITY_ARGUMENTS_MISMATCH');
  assert.ok(!JSON.stringify(swapped).includes('outside\\n'));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\njace-commander filesystem: ${passed} passed`);
process.exit(0);
