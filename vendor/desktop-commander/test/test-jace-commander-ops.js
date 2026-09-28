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
import { JC_MANIFEST } from '../dist/jace-commander/manifest.generated.js';
import { createJcServer } from '../dist/jace-commander/server.js';
import { makeIssuer } from './fixtures/jc-mint.js';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-ops-')));
const home = path.join(tmp, 'home');
const root = path.join(home, 'repo');
const stateDir = path.join(home, '.jace-commander');
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: home };
const sh = (args, cwd = root) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
sh(['init', '-b', 'main']);
sh(['config', 'user.email', 'jc@example.com']);
sh(['config', 'user.name', 'JC Test']);
const bare = path.join(tmp, 'bare.git');
sh(['init', '--bare', bare], tmp);
sh(['remote', 'add', 'origin', bare]);

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
// A parent secret that must never reach a child process.
process.env.JC_OPS_TEST_CANARY = 'canary-value-must-not-leak';
const server = createJcServer(loadJcConfig(env), 'managed', { helperAvailable: async () => false });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: 'test', version: '1' });
await client.connect(clientTransport);
const call = (name, args, overrides) => client.callTool({ name, arguments: args, _meta: { acsCapability: issuer.mint(name, args, overrides) } });
const code = (result) => result.structuredContent?.error?.code;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}
const okResult = (result) => assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent ?? result.content));
const refused = (result, expected) => {
  assert.equal(result.isError, true, JSON.stringify(result.structuredContent ?? result.content));
  assert.equal(code(result), expected, JSON.stringify(result.structuredContent ?? result.content));
};

const file = path.join(root, 'note.txt');

await test('tools/list is exactly the manifest (36 tools, no list_sessions alias)', async () => {
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), JC_MANIFEST.tools.map((tool) => tool.name).sort());
  assert.equal(tools.tools.length, 36);
  assert.ok(!tools.tools.some((tool) => tool.name === 'list_sessions'));
});

await test('write_file writes inside a root and refuses outside, without a capability, and without approval', async () => {
  okResult(await call('write_file', { path: file, content: 'hello\n' }));
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello\n');
  refused(await call('write_file', { path: '/etc/jc-nope.txt', content: 'x' }), 'path_not_allowed');
  const noCap = await client.callTool({ name: 'write_file', arguments: { path: file, content: 'nope', overwrite: true } });
  assert.equal(noCap.isError, true);
  assert.match(JSON.stringify(noCap), /JC_CAPABILITY_MISSING/);
  const noApproval = await call('write_file', { path: file, content: 'nope', overwrite: true }, { approvalId: undefined });
  assert.equal(noApproval.isError, true);
  assert.match(JSON.stringify(noApproval), /JC_CAPABILITY_APPROVAL_REQUIRED/);
  const wrongScope = await call('write_file', { path: file, content: 'nope', overwrite: true }, { scopes: ['fs.read'] });
  assert.equal(wrongScope.isError, true);
  assert.match(JSON.stringify(wrongScope), /JC_CAPABILITY_SCOPE_MISMATCH/);
  const expired = await call('write_file', { path: file, content: 'nope', overwrite: true }, {
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() - 40_000).toISOString(),
  });
  assert.equal(expired.isError, true);
  assert.match(JSON.stringify(expired), /JC_CAPABILITY_/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello\n');
});

await test('writes cannot reach .git, traverse, or move a root', async () => {
  refused(await call('write_file', { path: path.join(root, '.git', 'hooks', 'pre-commit'), content: '#!/bin/sh\n' }), 'path_denied');
  refused(await call('write_file', { path: path.join(root, '.git', 'config'), content: 'x', overwrite: true }), 'path_denied');
  refused(await call('create_directory', { path: path.join(root, '.git', 'hooks2') }), 'path_denied');
  const traversal = await call('write_file', { path: `${root}/../../escape.txt`, content: 'x' });
  assert.equal(traversal.isError, true);
  assert.ok(!fs.existsSync(path.join(tmp, 'escape.txt')));
  refused(await call('move_file', { from: home, to: path.join(root, 'moved-home') }), 'path_denied');
});

await test('edit_block replaces atomically and keeps the file mode', async () => {
  fs.chmodSync(file, 0o640);
  okResult(await call('edit_block', { path: file, old: 'hello', new: 'hello world' }));
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello world\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
});

await test('git add -> commit -> push the approved commit to a local bare remote', async () => {
  okResult(await call('git_add', { repo: root, paths: ['note.txt'] }));
  const committed = await call('git_commit', { repo: root, message: 'test: jc e2e' });
  okResult(committed);
  const head = committed.structuredContent.head;
  assert.match(head, /^[a-f0-9]{40}$/);
  const status = await call('git_status', { repo: root });
  assert.equal(status.structuredContent.clean, true);
  assert.equal(status.structuredContent.head, head);
  const pushed = await call('git_push', { repo: root, remote: 'origin', expectedHead: head });
  okResult(pushed);
  assert.equal(pushed.structuredContent.pushed, head);
  assert.equal(pushed.structuredContent.secretScan.clean, true);
  assert.equal(sh(['rev-parse', 'refs/heads/main'], bare), head);
});

await test('git refuses empty commits, moved/unbound HEADs, option-shaped and unconfigured remotes', async () => {
  refused(await call('git_commit', { repo: root, message: 'empty' }), 'nothing_staged');
  const head = sh(['rev-parse', 'HEAD']);
  const stale = 'a'.repeat(40);
  refused(await call('git_push', { repo: root, remote: 'origin', expectedHead: stale }), 'head_moved');
  const noHead = await call('git_push', { repo: root, remote: 'origin' });
  assert.equal(noHead.isError, true);
  refused(await call('git_push', { repo: root, remote: '-f', expectedHead: head }), 'invalid_argument');
  refused(await call('git_push', { repo: root, remote: bare, expectedHead: head }), 'invalid_argument');
  refused(await call('git_fetch', { repo: root, remote: 'upstream' }), 'remote_not_configured');
  refused(await call('git_add', { repo: root, paths: [':(top)'] }), 'invalid_argument');
});

await test('git_push refuses a commit that adds a secret', async () => {
  const secretLine = ['API', '_TOKEN=', 'abcd1234', 'efgh5678', 'ijkl'].join('');
  fs.writeFileSync(path.join(root, 'config.env.txt'), `${secretLine}\n`);
  okResult(await call('git_add', { repo: root, paths: ['config.env.txt'] }));
  const committed = await call('git_commit', { repo: root, message: 'test: add secret' });
  okResult(committed);
  const before = sh(['rev-parse', 'refs/heads/main'], bare);
  refused(await call('git_push', { repo: root, remote: 'origin', expectedHead: committed.structuredContent.head }), 'secret_detected');
  assert.equal(sh(['rev-parse', 'refs/heads/main'], bare), before);
  sh(['reset', '--hard', 'HEAD~1']);
});

await test('git never runs repository hooks or fsmonitor', async () => {
  const marker = path.join(tmp, 'hook-ran');
  const hook = path.join(root, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  const monitor = path.join(tmp, 'fsmonitor.sh');
  fs.writeFileSync(monitor, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  sh(['config', 'core.fsmonitor', monitor]);
  okResult(await call('git_status', { repo: root }));
  fs.writeFileSync(path.join(root, 'second.txt'), 'two\n');
  okResult(await call('git_add', { repo: root, paths: ['second.txt'] }));
  okResult(await call('git_commit', { repo: root, message: 'test: no hooks' }));
  assert.ok(!fs.existsSync(marker), 'a repository hook or fsmonitor ran');
  sh(['config', '--unset', 'core.fsmonitor']);
});

await test('git commit refuses a detached HEAD and git_status reports it', async () => {
  sh(['checkout', '--detach', 'HEAD']);
  const status = await call('git_status', { repo: root });
  assert.equal(status.structuredContent.detached, true);
  fs.writeFileSync(path.join(root, 'third.txt'), 'three\n');
  okResult(await call('git_add', { repo: root, paths: ['third.txt'] }));
  refused(await call('git_commit', { repo: root, message: 'detached' }), 'detached_head');
  sh(['reset', '-q', 'HEAD', '--', 'third.txt']);
  sh(['checkout', '-q', 'main']);
});

await test('start_process runs argv with an allowlisted env and bounded output', async () => {
  const started = await call('start_process', { argv: ['/bin/echo', 'jc-process'], cwd: root, timeoutMs: 5000 });
  okResult(started);
  await sleep(200);
  const output = await call('read_process_output', { sessionId: started.structuredContent.sessionId });
  assert.match(output.structuredContent.stdout, /jc-process/);
  assert.equal(output.structuredContent.running, false);
  const printenv = fs.existsSync('/usr/bin/printenv') ? '/usr/bin/printenv' : '/bin/printenv';
  const envRun = await call('start_process', { argv: [printenv], cwd: root, timeoutMs: 5000 });
  okResult(envRun);
  await sleep(200);
  const envOut = await call('read_process_output', { sessionId: envRun.structuredContent.sessionId });
  assert.doesNotMatch(envOut.structuredContent.stdout, /JC_OPS_TEST_CANARY|JC_ACS_PUBLIC_KEY/);
});

await test('start_process refuses shells (including via symlink), relative paths, and cwd outside roots', async () => {
  refused(await call('start_process', { argv: ['/bin/bash', '-c', 'echo no'], cwd: root }), 'command_denied');
  refused(await call('start_process', { argv: ['/bin/sh', '-c', 'echo no'], cwd: root }), 'command_denied');
  const link = path.join(root, 'innocent');
  fs.symlinkSync('/bin/bash', link);
  refused(await call('start_process', { argv: [link, '-c', 'echo no'], cwd: root }), 'command_denied');
  fs.rmSync(link);
  refused(await call('start_process', { argv: ['echo', 'x'], cwd: root }), 'invalid_argument');
  refused(await call('start_process', { argv: ['/bin/echo', 'x'], cwd: '/etc' }), 'path_not_allowed');
  const noApproval = await call('start_process', { argv: ['/bin/echo', 'x'], cwd: root }, { approvalId: undefined });
  assert.match(JSON.stringify(noApproval), /JC_CAPABILITY_APPROVAL_REQUIRED/);
});

await test('kill_process terminates a managed process; list_processes reports it', async () => {
  const started = await call('start_process', { argv: ['/bin/sleep', '30'], cwd: root, timeoutMs: 60000 });
  okResult(started);
  const listed = await call('list_processes', {});
  assert.ok(listed.structuredContent.processes.some((item) => item.sessionId === started.structuredContent.sessionId && item.running));
  okResult(await call('kill_process', { sessionId: started.structuredContent.sessionId }));
  await sleep(200);
  const output = await call('read_process_output', { sessionId: started.structuredContent.sessionId });
  assert.equal(output.structuredContent.running, false);
  assert.equal(output.structuredContent.signal, 'SIGTERM');
  refused(await call('kill_process', { pid: 1 }), 'not_found');
});

await test('jc_doctor reports manifest/handler parity, verifier, served path, and backends', async () => {
  const doctor = await call('jc_doctor', {});
  okResult(doctor);
  const report = doctor.structuredContent;
  assert.equal(report.toolCount, 36);
  assert.equal(report.liveHandlerCount, 36);
  const check = (name) => report.checks.find((item) => item.name === name);
  assert.equal(check('manifest').ok, true);
  assert.equal(check('capability verification').ok, true);
  assert.equal(check('bridge path').ok, true, check('bridge path').detail);
  assert.equal(check('filesystem roots').ok, true);
  assert.equal(check('acs').ok, false);
  assert.equal(report.ok, true);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|BEGIN/);
});

await client.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\njace-commander ops: ${passed} passed`);
process.exit(0);
