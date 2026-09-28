#!/usr/bin/env node
/** Writes, processes, git, and doctor through the managed MCP server. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadJcConfig } from '../dist/jace-commander/config.js';
import { createJcServer } from '../dist/jace-commander/server.js';
import { makeIssuer } from './fixtures/jc-mint.js';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-ops-')));
const home = path.join(tmp, 'home');
const root = path.join(home, 'repo');
const stateDir = path.join(home, '.jace-commander');
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });
execFileSync('git', ['init'], { cwd: root });
execFileSync('git', ['config', 'user.email', 'jc@example.com'], { cwd: root });
execFileSync('git', ['config', 'user.name', 'JC Test'], { cwd: root });
const bare = path.join(tmp, 'bare.git');
execFileSync('git', ['init', '--bare', bare]);
execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: root });

const issuer = makeIssuer();
const env = {
  HOME: home,
  JC_STATE_DIR: stateDir,
  JC_RUNTIME_ID: 'jc-test-runtime',
  JC_ACS_PUBLIC_KEY: issuer.publicKeyB64,
  JC_ACS_KEY_ID: issuer.keyId,
  JC_FS_ROOTS: home,
  JC_TRACE_ROOTS: path.join(tmp, 'traces'),
  JC_ACS_URL: 'http://127.0.0.1:9',
};
const server = createJcServer(loadJcConfig(env), 'managed', { helperAvailable: async () => false });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: 'test', version: '1' });
await client.connect(clientTransport);
const call = (name, args) => client.callTool({ name, arguments: args, _meta: { acsCapability: issuer.mint(name, args) } });
const code = (result) => result.structuredContent?.error?.code;

const file = path.join(root, 'note.txt');
const wrote = await call('write_file', { path: file, content: 'hello\n' });
assert.equal(wrote.isError, undefined, JSON.stringify(wrote.structuredContent));
assert.equal(fs.readFileSync(file, 'utf8'), 'hello\n');

const outside = await call('write_file', { path: '/etc/jc-nope.txt', content: 'x' });
assert.equal(outside.isError, true);
assert.equal(code(outside), 'path_not_allowed');

const noCap = await client.callTool({ name: 'write_file', arguments: { path: file, content: 'nope', overwrite: true } });
assert.equal(noCap.isError, true);

const edited = await call('edit_block', { path: file, old: 'hello', new: 'hello world' });
assert.equal(edited.isError, undefined);
assert.equal(fs.readFileSync(file, 'utf8'), 'hello world\n');

const added = await call('git_add', { repo: root, paths: ['note.txt'] });
assert.equal(added.isError, undefined);
const committed = await call('git_commit', { repo: root, message: 'test: jc e2e' });
assert.equal(committed.isError, undefined);
assert.match(committed.structuredContent.head, /^[a-f0-9]{40}$/);
const status = await call('git_status', { repo: root });
assert.equal(status.structuredContent.modified.length, 0);

const pushed = await call('git_push', { repo: root, remote: 'origin' });
assert.equal(pushed.isError, undefined, JSON.stringify(pushed.structuredContent));

const started = await call('start_process', { argv: ['/bin/echo', 'jc-process'], cwd: root, timeoutMs: 5000 });
assert.equal(started.isError, undefined);
await new Promise((resolve) => setTimeout(resolve, 200));
const output = await call('read_process_output', { sessionId: started.structuredContent.sessionId });
assert.match(output.structuredContent.stdout, /jc-process/);

const shell = await call('start_process', { argv: ['/bin/bash', '-c', 'echo no'], cwd: root });
assert.equal(shell.isError, true);
assert.equal(code(shell), 'command_denied');

const doctor = await call('jc_doctor', {});
assert.equal(doctor.isError, undefined);
assert.ok(doctor.structuredContent.toolCount >= 30);
const tools = await client.listTools();
assert.ok(tools.tools.length >= 30);

console.log(`jace-commander ops: ok (${tools.tools.length} tools)`);
