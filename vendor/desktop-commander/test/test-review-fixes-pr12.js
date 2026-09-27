#!/usr/bin/env node
/**
 * Regression tests for the Codex review findings on PR #12 (non-jc code):
 *  - run_command: symlink alias of a blocked binary is refused
 *  - git_state: repository root outside allowedDirectories is refused
 *  - restore_snapshot: directory root mode preserved; uncapturable entries
 *    (FIFOs) carried over instead of deleted
 *  - break-glass: non-integer / non-positive PIDs are ambiguous (fail closed)
 *  - ACS pipeline: a verified capability cannot be replayed; get_runtime_identity
 *    stays callable for identity discovery without a capability
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };

// --- unit-level (in-process) ------------------------------------------------
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-pr12-state-'));
process.env.DESKTOP_COMMANDER_STATE_DIR = stateDir;
process.env.DC_AUDIT_DIR = path.join(stateDir, 'audit');

await test('break-glass marker with an invalid numeric pid is ambiguous, never stale', async () => {
  const { checkBreakGlassStatus } = await import('../dist/break-glass.js');
  for (const pid of [-1, 0, 1.5, 2 ** 60]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-bg-'));
    fs.writeFileSync(path.join(dir, 'break-glass.lock'), JSON.stringify({ pid, acquiredAt: 1, mode: 'x', hostname: 'h' }));
    const status = checkBreakGlassStatus(dir);
    assert.equal(status.active, true, `pid ${pid}`);
    assert.equal(status.ambiguous, true, `pid ${pid}`);
  }
});

const { preExecuteEnforcement } = await import('../dist/enforcement/pipeline.js');
const { strictCanonicalJsonV1, computeDesktopCommanderInvocationHash } = await import('../dist/managed-acs.js');
const keys = crypto.generateKeyPairSync('ed25519');
process.env.DC_ACS_CAPABILITY_PUBLIC_KEY = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
const hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
function envelope(toolName, args, scopes) {
  const issuedAt = new Date(Date.now() - 1000);
  const payload = {
    version: 'acs.dc.v1', issuer: 'acs', audience: 'desktop-commander', runtimeId: 'rt-1', workItemId: 'wi-1',
    attemptId: 'at-1', leaseId: 'le-1', leaseEpoch: 1, toolName, normalizedArguments: args,
    invocationHash: computeDesktopCommanderInvocationHash(toolName, args),
    actionHash: hex('a'), requestHash: hex('r'), planHash: hex('p'), scopes,
    issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + 20_000).toISOString(),
    nonce: crypto.randomBytes(32).toString('base64url'),
  };
  const signature = crypto.sign(null, Buffer.from(strictCanonicalJsonV1(payload), 'utf8'), keys.privateKey).toString('base64url');
  return { payload, signature, keyId: 'acs-test-key' };
}

await test('ACS pipeline: the same verified capability cannot be used twice (persistent nonce store)', async () => {
  const args = { path: '/tmp/x.txt' };
  const cap = envelope('read_file', args, ['fs.read']);
  const first = await preExecuteEnforcement({ tool: 'read_file', args, meta: { agent: 'a', capability: cap } });
  assert.equal(first.allowed, true, JSON.stringify(first));
  const replay = await preExecuteEnforcement({ tool: 'read_file', args, meta: { agent: 'a', capability: cap } });
  assert.equal(replay.allowed, false);
  assert.equal(replay.code, 'ACS_CAPABILITY_REPLAY');
  assert.ok(fs.readdirSync(path.join(stateDir, 'acs-pipeline-nonces')).length >= 1);
});

await test('ACS pipeline: get_runtime_identity is callable without a capability; other tools are not', async () => {
  const identity = await preExecuteEnforcement({ tool: 'get_runtime_identity', args: {}, meta: { agent: 'a' } });
  assert.notEqual(identity.code, 'ACS_CAPABILITY_MALFORMED');
  const other = await preExecuteEnforcement({ tool: 'read_file', args: { path: '/tmp/x' }, meta: { agent: 'a' } });
  assert.equal(other.allowed, false);
  assert.equal(other.code, 'ACS_CAPABILITY_MALFORMED');
});
delete process.env.DC_ACS_CAPABILITY_PUBLIC_KEY;

// --- through the real MCP stdio server --------------------------------------
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-pr12-home-')));
const root = path.join(home, 'work');
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(path.join(home, '.claude-server-commander'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude-server-commander', 'config.json'), JSON.stringify({
  blockedCommands: ['sudo', 'forbiddentool'], defaultShell: '/bin/bash', allowedDirectories: [root], telemetryEnabled: false,
}));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(repo, 'dist', 'index.js'), '--standalone'],
  cwd: root,
  env: { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', DC_UNMATCHED_COMMAND_POLICY: 'auto' },
  stderr: 'ignore',
});
const client = new Client({ name: 'pr12', version: '0' }, { capabilities: {} });
await client.connect(transport);
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).find((c) => c.type === 'text')?.text ?? '';
  let json = null;
  try { json = JSON.parse(text); } catch { /* prose */ }
  return { isError: !!result.isError, json, text };
}

try {
  await test('run_command refuses a symlink alias of a blocked executable', async () => {
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir);
    const blocked = path.join(binDir, 'forbiddentool');
    fs.writeFileSync(blocked, '#!/bin/sh\necho RAN\n', { mode: 0o755 });
    const alias = path.join(root, 'safe-name');
    fs.symlinkSync(blocked, alias);
    const r = await call('run_command', { argv: [alias], cwd: root });
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, /DC_COMMAND_FORBIDDEN/);
    assert.doesNotMatch(r.text, /RAN/);
  });

  await test('git_state refuses a repository whose root is outside allowedDirectories', async () => {
    execFileSync('git', ['init', '-q', home]);
    fs.writeFileSync(path.join(home, 'outside-secret.txt'), 'x');
    const r = await call('git_state', { repoPath: root });
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, /DC_PATH_OUTSIDE_ALLOWED_SCOPE/);
    assert.doesNotMatch(r.text, /outside-secret/);
    fs.rmSync(path.join(home, '.git'), { recursive: true, force: true });
  });

  await test('restore_snapshot keeps the directory root mode and carries over uncapturable FIFOs', async () => {
    const app = path.join(root, 'app');
    fs.mkdirSync(app);
    fs.chmodSync(app, 0o755);
    fs.writeFileSync(path.join(app, 'index.html'), 'v1');
    execFileSync('mkfifo', [path.join(app, 'control.fifo')]);
    const snap = await call('snapshot_path', { path: app });
    assert.equal(snap.isError, false, snap.text);
    assert.ok(snap.json.skipped.some((s) => s.relPath === 'control.fifo'));
    fs.writeFileSync(path.join(app, 'index.html'), 'v2');
    const restored = await call('restore_snapshot', { snapshotId: snap.json.snapshotId });
    assert.equal(restored.isError, false, restored.text);
    assert.equal(fs.readFileSync(path.join(app, 'index.html'), 'utf8'), 'v1');
    assert.equal(fs.statSync(app).mode & 0o777, 0o755, 'root mode preserved, not 0700');
    assert.ok(fs.lstatSync(path.join(app, 'control.fifo')).isFIFO(), 'FIFO carried over, not deleted');
    assert.deepEqual(restored.json.carriedOverUncapturable, ['control.fifo']);
    assert.deepEqual(fs.readdirSync(root).filter((e) => e.includes('dc-displaced')), [], 'displaced tree cleaned up');
  });

  // ---- Codex review round 2 ----------------------------------------------
  await test('apply_patch applies an ordinary unified diff to a CRLF file and keeps CRLF', async () => {
    const file = path.join(root, 'crlf.txt');
    const before = 'one\r\ntwo\r\nthree\r\n';
    fs.writeFileSync(file, before);
    const patch = '--- a/crlf.txt\n+++ b/crlf.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n';
    const r = await call('apply_patch', { path: file, patch, expectedSha256: crypto.createHash('sha256').update(before).digest('hex') });
    assert.equal(r.isError, false, r.text);
    assert.equal(fs.readFileSync(file, 'utf8'), 'one\r\nTWO\r\nthree\r\n');
  });

  await test('secret_scan diff: an added line whose content starts with "++" is still scanned', async () => {
    const token = `ghp_${'A1b2C3d4'.repeat(5)}`;
    const patch = `--- a/x\n+++ b/x\n@@ -0,0 +1,2 @@\n+normal line\n+++ ${token}\n`;
    const r = await call('secret_scan', { target: 'diff', patch });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.clean, false, 'token on a "+++"-prefixed added line must be found');
    assert.doesNotMatch(r.text, new RegExp(token));
  });

  await test('restore of a file snapshot succeeds when the path is currently a directory', async () => {
    const target = path.join(root, 'was-a-file');
    fs.writeFileSync(target, 'original');
    const snap = await call('snapshot_path', { path: target });
    assert.equal(snap.isError, false, snap.text);
    fs.rmSync(target);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'inner.txt'), 'dir content');
    const restored = await call('restore_snapshot', { snapshotId: snap.json.snapshotId });
    assert.equal(restored.isError, false, restored.text);
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');
    assert.ok(restored.json.preRestoreSnapshotId, 'divergent directory preserved in a pre-restore snapshot');
  });

  await test('start_search surfaces an engine-rejected pattern as an error, not an empty success', async () => {
    fs.writeFileSync(path.join(root, 'searchme.txt'), 'hello');
    const r = await call('start_search', { path: root, pattern: '(unclosed', searchType: 'content', structured: true });
    if (!r.isError) {
      // Slow engines may not have failed within the first poll; then it must not claim completion.
      assert.notEqual(r.json.status, 'completed', r.text);
    } else {
      assert.match(r.text, /DC_INVALID_ARGUMENT/);
    }
  });

  await test('wait_for_process: catastrophic pattern is interrupted (runtime stays responsive); tailLines 0 returns no output', async () => {
    const started = await call('start_process', { command: `printf '${'a'.repeat(40)}!'; sleep 30`, timeout_ms: 1500 });
    const pid = Number(/PID (\d+)/.exec(started.text)?.[1]);
    assert.ok(pid > 0, started.text);
    const t0 = Date.now();
    const redos = await call('wait_for_process', { pid, until: { type: 'stdout_pattern', pattern: '(a+)+$' }, timeoutMs: 5000 });
    assert.equal(redos.isError, true, redos.text);
    assert.match(redos.text, /evaluation budget/);
    assert.ok(Date.now() - t0 < 4000, 'did not block the event loop');
    const tail = await call('wait_for_process', { pid, until: { type: 'stdout_pattern', pattern: 'a!' }, timeoutMs: 2000, tailLines: 0 });
    assert.equal(tail.isError, false, tail.text);
    assert.equal(tail.json.stdoutTail ?? tail.json.tail?.stdout ?? '', '');
    await call('terminate_process', { pid, force: true });
  });

  await test('service_status http probe honours an absolute deadline against a trickling endpoint', async () => {
    const http = await import('node:http');
    const server = http.createServer((req, res) => {
      res.writeHead(200);
      const tick = setInterval(() => res.write('.'), 50);
      req.on('close', () => clearInterval(tick));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const t0 = Date.now();
      const r = await call('service_status', { checks: [{ type: 'http', url: `http://127.0.0.1:${server.address().port}/` }], timeoutMs: 500 });
      assert.ok(Date.now() - t0 < 3000, `probe returned in ${Date.now() - t0}ms`);
      assert.match(r.text, /DC_TIMEOUT|down/);
    } finally {
      server.close();
      server.closeAllConnections?.();
    }
  });
} finally {
  await client.close();
}


// ---- DC_NETWORK_PROFILE=none: run_command gets the scrubbed environment --------
{
  const netTransport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, 'dist', 'index.js'), '--standalone'],
    cwd: root,
    env: { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', DC_UNMATCHED_COMMAND_POLICY: 'auto', DC_NETWORK_PROFILE: 'none', HTTPS_PROXY: 'http://sentinel-proxy.invalid:1' },
    stderr: 'ignore',
  });
  const netClient = new Client({ name: 'pr12-net', version: '0' }, { capabilities: {} });
  await netClient.connect(netTransport);
  try {
    await test('run_command under DC_NETWORK_PROFILE=none runs with the scrubbed environment', async () => {
      const probe = path.join(root, 'net-probe.cjs');
      fs.writeFileSync(probe, "console.log('proxy=' + (process.env.HTTPS_PROXY ?? 'unset') + ' no_proxy=' + process.env.NO_PROXY)\n");
      const result = await netClient.callTool({ name: 'run_command', arguments: { argv: [process.execPath, probe], cwd: root } });
      const text = (result.content ?? []).map((c) => c.text ?? '').join('\n');
      assert.equal(!!result.isError, false, text);
      assert.doesNotMatch(text, /sentinel-proxy/, 'proxy variables are scrubbed before spawn');
      assert.match(text, /proxy=unset no_proxy=\*/);
    });
  } finally {
    await netClient.close();
  }
}

console.log(`\nPR #12 review fixes: ${passed} passed`);
