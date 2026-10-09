#!/usr/bin/env node
/**
 * ADR 0026 slice 3: local policy. Loader, immutability rule, tighten-only user
 * layer, constraint enforcement, policy hash and intent-before-execute trace.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadJcConfig } from '../dist/jace-commander/config.js';
import { assertPolicyImmutable, checkPolicyConstraints, loadJcPolicy } from '../dist/jace-commander/local-policy.js';
import { createJcServer } from '../dist/jace-commander/server.js';
import { readTraceFile, verifyChain } from '../dist/jace-commander/looptrace.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-policy-')));
const work = path.join(root, 'work');
const polDir = path.join(root, 'pol');
fs.mkdirSync(work);
fs.mkdirSync(polDir);
const systemPath = path.join(polDir, 'policy.json');
const userPath = path.join(root, '.jc', 'policy.user.json');
fs.mkdirSync(path.dirname(userPath), { recursive: true });
const writePolicy = (file, doc) => fs.writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify({ version: 'jc.policy.v1', ...doc }));
const load = (extra = {}) => loadJcPolicy({ systemPath, systemPathExplicit: true, userPath, requireImmutable: false, baseFsRoots: [work], ...extra });
const clean = () => { fs.rmSync(systemPath, { force: true }); fs.rmSync(userPath, { force: true }); };

await test('no policy configured: built-in defaults, stable hash; explicit missing path is invalid', () => {
  clean();
  const implicit = load({ systemPathExplicit: false });
  assert.equal(implicit.state, 'builtin-default');
  assert.deepEqual({ ...implicit.effective.classDecisions }, { read: 'allow', mutate: 'approve', exec: 'approve', network: 'approve', privileged: 'approve' });
  assert.match(implicit.hash, /^[a-f0-9]{64}$/);
  assert.equal(implicit.hash, load({ systemPathExplicit: false }).hash);
  const explicit = load();
  assert.equal(explicit.state, 'invalid');
  assert.match(explicit.errors[0], /does not exist/);
});

await test('a valid system policy loads, changes the hash, and is validated strictly', () => {
  clean();
  const base = load({ systemPathExplicit: false }).hash;
  writePolicy(systemPath, { classes: { mutate: 'allow' }, constraints: { fs: { roots: [work] }, exec: { denyCommands: ['rm'] }, git: { remotes: ['origin'] } } });
  const loaded = load();
  assert.equal(loaded.state, 'loaded');
  assert.equal(loaded.effective.classDecisions.mutate, 'allow');
  assert.deepEqual(loaded.effective.fsRoots, [work]);
  assert.notEqual(loaded.hash, base);
  const bad = {
    'not json': '{nope',
    'wrong version': { version: 'x' },
    'unknown key': { surprise: true },
    'privileged allow': { classes: { privileged: 'allow' } },
    'unknown class': { classes: { godmode: 'allow' } },
    'relative root': { constraints: { fs: { roots: ['relative/dir'] } } },
    'bad remote': { constraints: { git: { remotes: ['a b'] } } },
    'unknown authorizer': { authorizers: { default: 'sudo' } },
    'global admin-delegated': { authorizers: { default: 'admin-delegated' } },
  };
  for (const [label, doc] of Object.entries(bad)) {
    writePolicy(systemPath, typeof doc === 'string' ? doc : doc.version ? JSON.stringify(doc) : doc);
    assert.equal(load().state, 'invalid', label);
  }
});

await test('immutability: a file this process can edit is rejected; unsafe-dev accepts it but reports it', () => {
  clean();
  writePolicy(systemPath, { classes: { mutate: 'allow' } });
  assert.throws(() => assertPolicyImmutable(systemPath), /writable|group\/world-writable/);
  const strict = loadJcPolicy({ systemPath, systemPathExplicit: true, userPath });
  assert.equal(strict.state, 'invalid');
  assert.equal(strict.immutable, false);
  const dev = loadJcPolicy({ systemPath, systemPathExplicit: true, userPath, unsafeDev: true });
  assert.equal(dev.state, 'loaded');
  assert.equal(dev.immutable, false);
  assert.equal(dev.unsafeDev, true);
  const link = path.join(root, 'link.json');
  fs.symlinkSync(systemPath, link);
  assert.throws(() => assertPolicyImmutable(link), /symlink/);
  if (process.geteuid?.() !== 0) assert.doesNotThrow(() => assertPolicyImmutable('/etc/hostname'));
});

await test('user layer may only tighten: loosening, authorizers, wider roots and extra commands are rejected', () => {
  clean();
  writePolicy(systemPath, { classes: { mutate: 'allow', exec: 'approve' }, constraints: { fs: { roots: [work] }, exec: { allowCommands: ['git', 'node'] }, git: { remotes: ['origin', 'upstream'] } } });
  writePolicy(userPath, { classes: { mutate: 'approve' }, constraints: { fs: { roots: [path.join(work, 'sub')], deniedRoots: [path.join(work, 'secret')] }, exec: { allowCommands: ['git'], denyCommands: ['curl'] }, git: { remotes: ['origin'] } } });
  const tightened = load();
  assert.equal(tightened.state, 'loaded');
  assert.equal(tightened.effective.classDecisions.mutate, 'approve');
  assert.deepEqual(tightened.effective.fsRoots, [path.join(work, 'sub')]);
  assert.deepEqual(tightened.effective.allowCommands, ['git']);
  assert.deepEqual(tightened.effective.denyCommands, ['curl']);
  assert.deepEqual(tightened.effective.gitRemotes, ['origin']);
  assert.ok(tightened.effective.fsDeniedRoots.includes(path.join(work, 'secret')));
  assert.equal(tightened.sources.length, 2);
  const loosen = {
    'loosen class': { classes: { exec: 'allow' } },
    'set authorizers': { authorizers: { default: 'local' } },
    'root outside': { constraints: { fs: { roots: ['/'] } } },
    'extra command': { constraints: { exec: { allowCommands: ['git', 'bash'] } } },
    'extra remote': { constraints: { git: { remotes: ['evil'] } } },
  };
  for (const [label, doc] of Object.entries(loosen)) {
    writePolicy(userPath, doc);
    assert.equal(load().state, 'invalid', label);
  }
  // With no system policy the user layer is still bound by the defaults.
  fs.rmSync(systemPath);
  writePolicy(userPath, { classes: { mutate: 'allow' } });
  assert.equal(load({ systemPathExplicit: false }).state, 'invalid');
});

await test('constraint checks: command allow/deny by name or absolute path, git remotes', () => {
  const effective = { ...load({ systemPathExplicit: false }).effective, denyCommands: ['curl', '/usr/bin/wget'], allowCommands: undefined, gitRemotes: ['origin'] };
  assert.match(checkPolicyConstraints(effective, 'start_process', { argv: ['/usr/bin/curl'] }), /denied/);
  assert.match(checkPolicyConstraints(effective, 'start_process', { argv: ['/usr/bin/wget'] }), /denied/);
  assert.equal(checkPolicyConstraints(effective, 'start_process', { argv: ['/opt/wget'] }), undefined);
  const allow = { ...effective, allowCommands: ['git'] };
  assert.match(checkPolicyConstraints(allow, 'start_process', { argv: ['/usr/bin/node'] }), /allowlist/);
  assert.equal(checkPolicyConstraints(allow, 'start_process', { argv: ['/usr/bin/git'] }), undefined);
  assert.match(checkPolicyConstraints(effective, 'git_push', { remote: 'other' }), /remote other/);
  assert.equal(checkPolicyConstraints(effective, 'git_fetch', {}), undefined, 'default remote origin is allowed');
});

// ---- server level ----
fs.writeFileSync(path.join(work, 'a.txt'), 'hello\n');
function configFor(stateName, env = {}) {
  return loadJcConfig({
    HOME: root,
    JC_STATE_DIR: path.join(root, stateName),
    JC_FS_ROOTS: work,
    JC_RUNTIME_ID: 'jc-test-runtime',
    JC_POLICY_PATH: systemPath,
    ...env,
  });
}
async function connectLocal(config, policy) {
  const server = createJcServer(config, 'local', { policy, helperAvailable: async () => false, fetchImpl: async () => { throw new Error('no network'); } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(b);
  return client;
}
const tracesOf = (config) => {
  const dir = path.join(config.stateDir, 'traces');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).flatMap((f) => {
    const { events } = readTraceFile(path.join(dir, f));
    assert.equal(verifyChain(events).ok, true);
    return events;
  });
};

await test('server: policy-allowed mutation runs without approval, with intent+result trace carrying the policy hash', async () => {
  clean();
  writePolicy(systemPath, { classes: { mutate: 'allow' }, constraints: { fs: { roots: [work] } } });
  const config = configFor('.jc1');
  const policy = load();
  const client = await connectLocal(config, policy);
  const target = path.join(work, 'new.txt');
  const result = await client.callTool({ name: 'write_file', arguments: { path: target, content: 'hi' } });
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  assert.equal(fs.readFileSync(target, 'utf8'), 'hi');
  const events = tracesOf(config).filter((event) => event.payload.tool === 'write_file');
  assert.deepEqual(events.map((event) => event.type), ['tool_call_started', 'tool_call_finished']);
  for (const event of events) assert.equal(event.payload.policyHash, policy.hash);
  assert.equal(events[0].payload.riskClass, 'mutate');
  const exec = await client.callTool({ name: 'start_process', arguments: { argv: [process.execPath, '-e', ''], cwd: work } });
  assert.equal(exec.structuredContent.error.code, 'JC_LOCAL_APPROVAL_UNAVAILABLE');
  await client.close();
});

await test('server: policy fs roots override the environment, and the policy itself is unreadable to the model', async () => {
  clean();
  const narrow = path.join(work, 'narrow');
  fs.mkdirSync(narrow);
  fs.writeFileSync(path.join(narrow, 'ok.txt'), 'in');
  writePolicy(systemPath, { constraints: { fs: { roots: [narrow] } } });
  const config = configFor('.jc2', { JC_FS_ROOTS: [work, polDir].join(path.delimiter) });
  const client = await connectLocal(config, load());
  assert.equal((await client.callTool({ name: 'read_file', arguments: { path: path.join(narrow, 'ok.txt') } })).isError, undefined);
  assert.equal((await client.callTool({ name: 'read_file', arguments: { path: path.join(work, 'a.txt') } })).isError, true);
  const policyRead = await client.callTool({ name: 'read_file', arguments: { path: systemPath } });
  assert.equal(policyRead.isError, true);
  assert.equal(JSON.stringify(policyRead).includes('jc.policy.v1'), false);
  await client.close();
});

await test('server: exec constraints refuse a denied/unlisted command before anything runs', async () => {
  clean();
  writePolicy(systemPath, { classes: { exec: 'allow' }, constraints: { fs: { roots: [work] }, exec: { allowCommands: ['/usr/bin/git'] } } });
  const config = configFor('.jc3');
  const client = await connectLocal(config, load());
  const marker = path.join(work, 'ran.txt');
  const result = await client.callTool({ name: 'start_process', arguments: { argv: [process.execPath, '-e', `require("fs").writeFileSync(${JSON.stringify(marker)},"x")`], cwd: work } });
  assert.equal(result.structuredContent.error.code, 'JC_POLICY_CONSTRAINT');
  assert.equal(result._meta.jcAuthorization.decision, 'constraint-violation');
  assert.equal(fs.existsSync(marker), false);
  await client.close();
});

await test('server: an invalid configured policy denies everything except jc.meta and says so in jc_status', async () => {
  clean();
  writePolicy(systemPath, { classes: { privileged: 'allow' } });
  const config = configFor('.jc4');
  const client = await connectLocal(config, load());
  for (const name of ['read_file', 'write_file', 'list_processes']) {
    const result = await client.callTool({ name, arguments: { path: path.join(work, 'a.txt'), content: 'x' } });
    assert.equal(result.structuredContent.error.code, 'JC_POLICY_INVALID', name);
  }
  const ping = await client.callTool({ name: 'ping', arguments: {} });
  assert.equal(ping.isError, undefined);
  const status = (await client.callTool({ name: 'jc_status', arguments: {} })).structuredContent;
  assert.equal(status.policy.state, 'invalid');
  const doctor = (await client.callTool({ name: 'jc_doctor', arguments: {} })).structuredContent;
  const check = doctor.checks.find((entry) => entry.name === 'local policy');
  assert.equal(check.ok, false);
  assert.equal(doctor.ok, false);
  await client.close();
});

await test('server: if the intent record cannot be written a mutating call is refused and nothing happens', async () => {
  clean();
  writePolicy(systemPath, { classes: { mutate: 'allow' }, constraints: { fs: { roots: [work] } } });
  const config = configFor('.jc5');
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.writeFileSync(path.join(config.stateDir, 'traces'), 'not a directory'); // the trace dir cannot be created
  const client = await connectLocal(config, load());
  const target = path.join(work, 'blocked.txt');
  const result = await client.callTool({ name: 'write_file', arguments: { path: target, content: 'x' } });
  assert.equal(result.structuredContent.error.code, 'JC_TRACE_UNAVAILABLE');
  assert.equal(fs.existsSync(target), false);
  const read = await client.callTool({ name: 'read_file', arguments: { path: path.join(work, 'a.txt') } });
  assert.equal(read.isError, undefined, 'reads keep working when the trace is unavailable');
  await client.close();
});

await test('managed and standalone presets never read the policy (parity): status has no policy block', async () => {
  clean();
  writePolicy(systemPath, '{garbage');
  const config = configFor('.jc6');
  const server = createJcServer(config, 'standalone', { helperAvailable: async () => false, fetchImpl: async () => { throw new Error('no network'); } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(b);
  const status = (await client.callTool({ name: 'jc_status', arguments: {} })).structuredContent;
  assert.equal(status.policy, undefined);
  assert.equal((await client.callTool({ name: 'read_file', arguments: { path: path.join(work, 'a.txt') } })).isError, undefined);
  await client.close();
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\njace-commander policy: ${passed} passed`);
