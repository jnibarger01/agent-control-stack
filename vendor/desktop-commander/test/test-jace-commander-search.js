#!/usr/bin/env node
/**
 * start_search / get_more_search_results / list_searches / stop_search.
 * Same capability gate as the filesystem tools: no capability, no walk.
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

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-search-')));
const home = path.join(tmp, 'home');
const root = path.join(home, 'projects');
const stateDir = path.join(home, '.jace-commander');
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const CapabilityVerifier = 1;\nconst other = 2;\n');
fs.writeFileSync(path.join(root, 'notes.md'), 'nothing to see\n');
fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'CapabilityVerifier\n');

const issuer = makeIssuer();
const env = {
  HOME: home,
  JC_STATE_DIR: stateDir,
  JC_RUNTIME_ID: 'jc-test-runtime',
  JC_ACS_PUBLIC_KEY: issuer.publicKeyB64,
  JC_ACS_KEY_ID: issuer.keyId,
  JC_FS_ROOTS: home,
  JC_TRACE_ROOTS: path.join(tmp, 'traces'),
};

const server = createJcServer(loadJcConfig(env), 'managed', { helperAvailable: async () => false });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: 'test', version: '1' });
await client.connect(clientTransport);
const call = (name, args) => client.callTool({ name, arguments: args, _meta: { acsCapability: issuer.mint(name, args) } });

const started = await call('start_search', { path: root, pattern: 'CapabilityVerifier', mode: 'content', limit: 10 });
assert.equal(started.isError, undefined);
assert.equal(started.structuredContent.matched, 1);
assert.equal(started.structuredContent.results[0].line, 1);
assert.ok(started.structuredContent.results[0].path.endsWith(`${path.sep}src${path.sep}index.ts`));

const names = await call('start_search', { path: root, pattern: '*.md', mode: 'filename', fileFilter: '*.md' });
assert.equal(names.structuredContent.matched, 1);
assert.ok(names.structuredContent.results[0].path.endsWith('notes.md'));

const denied = await client.callTool({ name: 'start_search', arguments: { path: root, pattern: 'x', mode: 'filename' } });
assert.equal(denied.isError, true);

const outside = await call('start_search', { path: '/etc', pattern: 'x', mode: 'filename' });
assert.equal(outside.isError, true);

const listed = await call('list_searches', {});
assert.ok(listed.structuredContent.searches.length >= 2);
const id = started.structuredContent.searchId;
const stopped = await call('stop_search', { searchId: id });
assert.equal(stopped.structuredContent.cancelled, true);
const more = await call('get_more_search_results', { searchId: id });
assert.equal(more.structuredContent.cancelled, true);

console.log('jace-commander search: ok');
