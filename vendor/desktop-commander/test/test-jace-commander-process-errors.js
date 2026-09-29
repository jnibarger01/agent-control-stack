#!/usr/bin/env node
/**
 * start_process through the managed MCP server: allow, approval-required,
 * denied, invalid executable, and spawn failure.
 *
 * The spawn-failure case guards a crash, not just a return value: exec(2)
 * failures are reported through the child's asynchronous 'error' event, and an
 * EventEmitter 'error' with no listener is an uncaughtException. Before the
 * process registry attached that listener, one failed spawn killed the managed
 * Jace Commander MCP server, so the caller saw a dead session (a generic
 * internal error) instead of the structured refusal. That case therefore runs
 * in its own node process and is asserted by exit code: a server that dies
 * cannot report exit 0.
 *
 * argv-only spawning is asserted too: a shell metacharacter stays one literal
 * argument, and no shell is involved.
 */
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

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-proc-')));
const home = path.join(tmp, 'home');
const root = path.join(home, 'repo');
const stateDir = path.join(home, '.jace-commander');
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });

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

const call = (name, args, overrides) =>
  client.callTool({ name, arguments: args, _meta: { acsCapability: issuer.mint(name, args, overrides) } });
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
  const detail = JSON.stringify(result.structuredContent ?? result.content);
  assert.equal(result.isError, true, detail);
  assert.equal(code(result), expected, detail);
};
const sessions = async () => (await call('list_processes', {})).structuredContent.processes;
/** A call that must still work: proves the previous refusal did not kill us. */
const stillServing = async () => {
  const healthy = await call('start_process', { argv: ['/bin/echo', 'alive'], cwd: root, timeoutMs: 5000 });
  okResult(healthy);
  return healthy.structuredContent.sessionId;
};

const nodePath = fs.existsSync('/usr/bin/node') ? '/usr/bin/node' : process.execPath;
const argv = [nodePath, '--version'];

await test('allowed start_process runs argv[0] with the exact argv and reports the session', async () => {
  const started = await call('start_process', { argv, cwd: root, timeoutMs: 5000 });
  okResult(started);
  assert.match(started.structuredContent.sessionId, /^proc_[0-9a-f]{16}$/u);
  assert.ok(Number.isInteger(started.structuredContent.pid) && started.structuredContent.pid > 0);
  assert.deepEqual(started.structuredContent.argv, argv);
  assert.equal(started.structuredContent.cwd, root);
  await sleep(300);
  const output = await call('read_process_output', { sessionId: started.structuredContent.sessionId });
  assert.match(output.structuredContent.stdout, /^v\d+\.\d+\.\d+/u, output.structuredContent.stdout);
  assert.equal(output.structuredContent.running, false);
  assert.equal(output.structuredContent.exitCode, 0);
});

await test('start_process without a human approvalId is refused before any process exists', async () => {
  const before = (await sessions()).length;
  refused(await call('start_process', { argv, cwd: root }, { approvalId: undefined }), 'JC_CAPABILITY_APPROVAL_REQUIRED');
  assert.equal((await sessions()).length, before, 'a refusal must not create a session');
  assert.ok(await stillServing());
});

await test('start_process with a capability bound to a different argv is denied (nothing spawned)', async () => {
  const before = (await sessions()).length;
  refused(
    await call('start_process', { argv, cwd: root }, { normalizedArguments: { argv: ['/usr/bin/env'], cwd: root } }),
    'JC_CAPABILITY_ARGUMENTS_MISMATCH',
  );
  refused(
    await call('start_process', { argv, cwd: root }, { audience: 'desktop-commander' }),
    'JC_CAPABILITY_AUDIENCE_INVALID',
  );
  assert.equal((await sessions()).length, before, 'a denial must not create a session');
});

await test('invalid executable: missing path, relative path, and a non-regular file are structured refusals', async () => {
  const notExecutable = path.join(root, 'not-executable.bin');
  fs.writeFileSync(notExecutable, 'data', { mode: 0o644 });
  const before = (await sessions()).length;
  refused(await call('start_process', { argv: [path.join(root, 'no-such-binary'), '--version'], cwd: root }), 'not_found');
  refused(await call('start_process', { argv: ['node', '--version'], cwd: root }), 'invalid_argument');
  refused(await call('start_process', { argv: [root], cwd: root }), 'not_executable');
  refused(await call('start_process', { argv: [notExecutable], cwd: root }), 'not_executable');
  assert.equal((await sessions()).length, before, 'an invalid executable must not create a session');
  assert.ok(await stillServing());
});

await test('a failed spawn is contained: the server survives and the failure stays a structured refusal', async () => {
  // exec(2) fails here even though the file is executable (missing interpreter),
  // so the refusal can only be reported through the asynchronous 'error' event.
  const brokenInterpreter = path.join(root, 'broken-interpreter');
  fs.writeFileSync(brokenInterpreter, '#!/nonexistent/interpreter\n', { mode: 0o755 });
  const script = path.join(tmp, 'spawn-failure-probe.mjs');
  fs.writeFileSync(script, `
import { createProcessRegistry } from ${JSON.stringify(new URL('../dist/jace-commander/processes.js', import.meta.url).pathname)};
const registry = createProcessRegistry();
const policy = { roots: [${JSON.stringify(root)}], deniedRoots: [] };
const outcomes = [];
for (const argv of [[${JSON.stringify(brokenInterpreter)}], [${JSON.stringify(path.join(root, 'not-executable.bin'))}]]) {
  try { outcomes.push({ argv: argv[0], result: registry.start({ argv, cwd: ${JSON.stringify(root)}, timeoutMs: 5000 }, policy) }); }
  catch (error) { outcomes.push({ argv: argv[0], code: error.code, message: error.message }); }
}
// Let the asynchronous 'error' event land before exiting: an unhandled one would
// terminate this process here.
await new Promise((resolve) => setTimeout(resolve, 500));
console.log(JSON.stringify(outcomes));
`, 'utf8');
  // execFileSync throws on a non-zero exit, which is exactly the pre-fix crash.
  const raw = execFileSync(process.execPath, [script], { encoding: 'utf8', timeout: 30_000 });
  const outcomes = JSON.parse(raw.trim().split('\n').at(-1));
  assert.deepEqual(outcomes.map((outcome) => outcome.code), ['start_failed', 'not_executable']);
  assert.equal(outcomes[0].result, undefined, 'a failed spawn must not report a session');
  refused(await call('start_process', { argv: [brokenInterpreter], cwd: root }), 'start_failed');
  assert.ok(await stillServing(), 'the MCP server must keep serving after a spawn failure');
});

await test('argv-only spawning: a shell metacharacter stays one literal argument', async () => {
  const started = await call('start_process', { argv: ['/bin/echo', 'a;b|c$(id)'], cwd: root, timeoutMs: 5000 });
  okResult(started);
  await sleep(300);
  const output = await call('read_process_output', { sessionId: started.structuredContent.sessionId });
  assert.equal(output.structuredContent.stdout.trim(), 'a;b|c$(id)');
});

await client.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\njace-commander process errors: ${passed} passed`);
process.exit(0);
