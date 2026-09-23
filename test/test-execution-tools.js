/**
 * Execution-plane tools, exercised through the real MCP stdio path
 * (tools/list + tools/call against dist/index.js --standalone) in an isolated
 * HOME with a restrictive allowedDirectories configuration.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-exec-home-')));
const root = path.join(home, 'work');
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-exec-outside-')));
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(path.join(home, '.claude-server-commander'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude-server-commander', 'config.json'), JSON.stringify({
  blockedCommands: ['sudo', 'mkfs', 'forbiddentool'],
  defaultShell: '/bin/bash',
  allowedDirectories: [root],
  telemetryEnabled: false,
  fileReadLineLimit: 1000,
  fileWriteLineLimit: 50,
}));
const eventsFile = path.join(home, 'events', 'execution-events.jsonl');
const FAKE_GITHUB_TOKEN = `ghp_${'A1b2C3d4'.repeat(5)}`;
const FAKE_JWT = [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ sub: '1234567890' })).toString('base64url'),
  Buffer.from('signature-value').toString('base64url'),
].join('.');
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(repo, 'dist', 'index.js'), '--standalone'],
  cwd: root,
  // Documented operator opt-in for the pre-existing standalone execution
  // kernel; the kernel's default (fail-closed) behaviour is tested below.
  env: { PATH: process.env.PATH, HOME: home, DC_EXECUTION_EVENTS_FILE: eventsFile, LANG: 'C.UTF-8', DC_UNMATCHED_COMMAND_POLICY: 'auto' },
  stderr: 'ignore',
});
const client = new Client({ name: 'dc-exec-test', version: '0' }, { capabilities: {} });
await client.connect(transport);

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const texts = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text);
  let json = null;
  for (const t of texts) {
    try { json = JSON.parse(t); break; } catch { /* prose */ }
  }
  return { isError: !!result.isError, json, texts, meta: result._meta ?? {}, raw: result };
}
function expectCode(r, code, label) {
  assert.equal(r.isError, true, `${label}: expected error, got ${r.texts.join('\n').slice(0, 400)}`);
  const body = r.json?.error ?? r.json?.dcError;
  assert.equal(body?.code, code, `${label}: ${r.texts.join('\n').slice(0, 400)}`);
  assert.match(body.requestId, /^dcreq_/, `${label}: requestId`);
  return body;
}
const passed = [];
async function check(label, fn) {
  await fn();
  passed.push(label);
}
const cleanupPids = [];

try {
  // ---------------------------------------------------------------- tools/list
  await check('tools/list exposes every new tool with external authorization', async () => {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    for (const t of ['health', 'last_error', 'run_command', 'wait_for_process', 'terminate_process', 'apply_patch', 'git_state', 'verify_head',
      'snapshot_path', 'restore_snapshot', 'capability_manifest', 'operation_preview', 'secret_scan', 'service_status']) {
      assert.ok(names.has(t), `missing ${t}`);
      assert.match(tools.find((x) => x.name === t).description, /authorization is external/, t);
    }
    assert.match(tools.find((t) => t.name === 'kill_process').description, /LEGACY/);
  });

  // ------------------------------------------------------------------- health
  await check('health reports structured subsystems', async () => {
    const r = await call('health', {});
    assert.equal(r.isError, false);
    assert.ok(['healthy', 'degraded'].includes(r.json.status), r.json.status);
    for (const k of ['configuration', 'runtime_identity', 'allowed_directories', 'process_manager', 'search', 'managed_transport', 'event_sinks']) {
      assert.ok(r.json.subsystems[k]?.status, k);
    }
    assert.match(r.json.configHash, /^[a-f0-9]{64}$/);
    assert.match(r.json.allowlistHash, /^[a-f0-9]{64}$/);
    assert.equal(r.json.pid > 0, true);
    assert.equal(r.json.subsystems.allowed_directories.unrestricted, false);
    assert.match(r.meta.dcExecution.requestId, /^dcreq_/);
  });

  // -------------------------------------------------------------- run_command
  await check('run_command executes argv and returns structured results', async () => {
    const r = await call('run_command', { argv: ['node', '-e', "console.log('hi'); console.error('warn')"], cwd: root });
    assert.equal(r.isError, false, r.texts.join());
    assert.equal(r.json.exitCode, 0);
    assert.equal(r.json.stdout, 'hi\n');
    assert.equal(r.json.stderr, 'warn\n');
    assert.equal(r.json.signal, null);
    assert.equal(r.json.timedOut, false);
    assert.equal(r.json.cwd, root);
    assert.equal(r.json.requestId, r.meta.dcExecution.requestId);
  });
  await check('run_command reports real exit codes', async () => {
    const r = await call('run_command', { argv: ['node', '-e', 'process.exit(7)'], cwd: root });
    assert.equal(r.json.exitCode, 7);
  });
  await check('run_command never interprets shell metacharacters', async () => {
    const hostile = '$(touch pwned); `touch pwned2` | tee pwned3 > pwned4 && echo x ; *';
    const r = await call('run_command', { argv: ['node', '-e', 'process.stdout.write(process.argv[1])', hostile], cwd: root });
    assert.equal(r.json.stdout, hostile);
    for (const f of ['pwned', 'pwned2', 'pwned3', 'pwned4']) assert.equal(fs.existsSync(path.join(root, f)), false, f);
  });
  await check('run_command hard timeout', async () => {
    const started = Date.now();
    const r = await call('run_command', { argv: ['node', '-e', 'setTimeout(()=>{}, 60000)'], cwd: root, timeoutMs: 300 });
    assert.equal(r.json.timedOut, true);
    assert.equal(r.json.exitCode, null);
    assert.equal(r.json.signal, 'SIGTERM');
    assert.ok(Date.now() - started < 10_000);
  });
  await check('run_command stdout/stderr caps with truncation metadata', async () => {
    const r = await call('run_command', { argv: ['node', '-e', "process.stdout.write('x'.repeat(100000)); process.stderr.write('y'.repeat(5000))"], cwd: root, maxStdoutBytes: 1000, maxStderrBytes: 10 });
    assert.equal(r.json.stdout.length, 1000);
    assert.equal(r.json.stdoutBytes, 100000);
    assert.equal(r.json.stderr, 'y'.repeat(10));
    assert.deepEqual(r.json.truncated, { stdout: true, stderr: true });
  });
  await check('run_command refuses cwd outside allowed directories (incl. via symlink)', async () => {
    expectCode(await call('run_command', { argv: ['node', '-v'], cwd: outside }), 'DC_PATH_OUTSIDE_ALLOWED_SCOPE', 'outside');
    fs.symlinkSync(outside, path.join(root, 'escape-link'));
    expectCode(await call('run_command', { argv: ['node', '-v'], cwd: path.join(root, 'escape-link') }), 'DC_PATH_OUTSIDE_ALLOWED_SCOPE', 'symlink');
  });
  await check('run_command command restrictions (blocked name, blocked alias path, missing executable)', async () => {
    expectCode(await call('run_command', { argv: ['forbiddentool', 'x'], cwd: root }), 'DC_COMMAND_FORBIDDEN', 'blocked name');
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'bin', 'forbiddentool'), '#!/bin/sh\necho should-not-run > ran\n', { mode: 0o755 });
    expectCode(await call('run_command', { argv: ['./bin/forbiddentool'], cwd: root }), 'DC_COMMAND_FORBIDDEN', 'alias path');
    assert.equal(fs.existsSync(path.join(root, 'ran')), false);
    expectCode(await call('run_command', { argv: ['definitely-not-a-real-binary-xyz'], cwd: root }), 'DC_COMMAND_NOT_FOUND', 'missing');
  });
  await check('run_command argument validation', async () => {
    expectCode(await call('run_command', { argv: [], cwd: root }), 'DC_INVALID_ARGUMENT', 'empty argv');
    expectCode(await call('run_command', { argv: ['node'], cwd: root, shell: '/bin/bash' }), 'DC_INVALID_ARGUMENT', 'unknown key');
    expectCode(await call('run_command', { argv: ['node', '-v'] }), 'DC_INVALID_ARGUMENT', 'missing cwd');
  });

  // ------------------------------------------------------- process lifecycle
  const startProcess = async (script) => {
    const r = await call('start_process', { command: `node -e "${script}"`, timeout_ms: 1500, cwd: root });
    const pid = Number(/PID (\d+)/.exec(r.texts[0])?.[1]);
    assert.ok(pid > 0, r.texts[0]);
    cleanupPids.push(pid);
    return pid;
  };
  await check('wait_for_process stdout pattern', async () => {
    const pid = await startProcess("setTimeout(()=>console.log('server ready on 4000'),400); setTimeout(()=>{},20000)");
    const r = await call('wait_for_process', { pid, until: { type: 'stdout_pattern', pattern: 'ready on \\d+' }, timeoutMs: 10000 });
    assert.equal(r.isError, false, r.texts.join());
    assert.equal(r.json.matched.stream, 'stdout');
    assert.equal(r.json.matched.text, 'ready on 4000');
    assert.equal(r.json.state, 'running');
    assert.equal(r.json.timedOut, false);
    const t = await call('terminate_process', { pid, graceMs: 2000 });
    assert.equal(t.json.exited, true);
    assert.deepEqual(t.json.signalsSent, ['SIGTERM']);
  });
  await check('wait_for_process stderr pattern and stream separation', async () => {
    const pid = await startProcess("console.error('boom-on-stderr'); setTimeout(()=>{},20000)");
    const wrongStream = await call('wait_for_process', { pid, until: { type: 'stdout_pattern', pattern: 'boom' }, timeoutMs: 300 });
    assert.equal(wrongStream.json.matched, null);
    assert.equal(wrongStream.json.timedOut, true);
    const r = await call('wait_for_process', { pid, until: { type: 'stderr_pattern', pattern: 'boom' }, timeoutMs: 5000 });
    assert.equal(r.json.matched.stream, 'stderr');
    await call('terminate_process', { pid });
  });
  await check('wait_for_process until exit with real exit code', async () => {
    const pid = await startProcess('setTimeout(()=>process.exit(3),500)');
    const r = await call('wait_for_process', { pid, until: { type: 'exit' }, timeoutMs: 10000 });
    assert.equal(r.json.state, 'exited');
    assert.equal(r.json.exitCode, 3);
    assert.equal(r.json.timedOut, false);
  });
  await check('wait_for_process timeout', async () => {
    const pid = await startProcess('setTimeout(()=>{},20000)');
    const r = await call('wait_for_process', { pid, timeoutMs: 200 });
    assert.equal(r.json.timedOut, true);
    assert.equal(r.json.state, 'running');
    await call('terminate_process', { pid });
  });
  await check('terminate_process escalates when SIGTERM is ignored', async () => {
    const pid = await startProcess("process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); console.log('armed')");
    await call('wait_for_process', { pid, until: { type: 'stdout_pattern', pattern: 'armed' }, timeoutMs: 5000 });
    const r = await call('terminate_process', { pid, graceMs: 300 });
    assert.equal(r.json.escalated, true);
    assert.deepEqual(r.json.signalsSent, ['SIGTERM', 'SIGKILL']);
    assert.equal(r.json.exited, true);
  });
  await check('process tools refuse unowned pids', async () => {
    for (const pid of [process.pid, 1]) {
      expectCode(await call('terminate_process', { pid }), 'DC_PROCESS_NOT_OWNED', `terminate ${pid}`);
      expectCode(await call('wait_for_process', { pid, timeoutMs: 10 }), 'DC_PROCESS_NOT_OWNED', `wait ${pid}`);
    }
    process.kill(process.pid, 0); // still alive: nothing was signalled
  });

  // ------------------------------------------------------------- apply_patch
  const target = path.join(root, 'notes.txt');
  const original = 'alpha\nbeta\ngamma\n';
  fs.writeFileSync(target, original, { mode: 0o640 });
  fs.chmodSync(target, 0o640);
  const patch = '--- a/notes.txt\n+++ b/notes.txt\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n';
  await check('apply_patch hash mismatch fails closed without writing', async () => {
    const body = expectCode(await call('apply_patch', { path: target, patch, expectedSha256: sha('other') }), 'DC_HASH_MISMATCH', 'mismatch');
    assert.equal(body.stage, 'precondition');
    assert.equal(fs.readFileSync(target, 'utf8'), original);
  });
  await check('apply_patch malformed / non-matching / multi-file patches are rejected', async () => {
    const h = sha(original);
    expectCode(await call('apply_patch', { path: target, patch: 'not a diff', expectedSha256: h }), 'DC_PATCH_REJECTED', 'malformed');
    expectCode(await call('apply_patch', { path: target, patch: '@@ -1,2 +1,2 @@\n alpha\n-nope\n+x\n', expectedSha256: h }), 'DC_PATCH_REJECTED', 'context');
    expectCode(await call('apply_patch', { path: target, patch: '@@ -1,3 +1,2 @@\n alpha\n-beta\n', expectedSha256: h }), 'DC_PATCH_REJECTED', 'counts');
    expectCode(await call('apply_patch', { path: target, patch: `${patch}--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n`, expectedSha256: h }), 'DC_PATCH_REJECTED', 'multi');
    assert.equal(fs.readFileSync(target, 'utf8'), original);
  });
  await check('apply_patch refuses ambiguous hunks', async () => {
    const dup = path.join(root, 'dup.txt');
    fs.writeFileSync(dup, 'x\ny\nx\ny\n');
    expectCode(await call('apply_patch', { path: dup, patch: '@@ -7,2 +7,2 @@\n x\n-y\n+Y\n', expectedSha256: sha('x\ny\nx\ny\n') }), 'DC_PATCH_REJECTED', 'ambiguous');
  });
  await check('apply_patch applies atomically, preserves mode, returns post-image hash', async () => {
    const r = await call('apply_patch', { path: target, patch, expectedSha256: sha(original) });
    assert.equal(r.isError, false, r.texts.join());
    const after = fs.readFileSync(target, 'utf8');
    assert.equal(after, 'alpha\nBETA\ngamma\n');
    assert.equal(r.json.preSha256, sha(original));
    assert.equal(r.json.postSha256, sha(after));
    assert.equal(fs.statSync(target).mode & 0o777, 0o640);
    assert.deepEqual(fs.readdirSync(root).filter((f) => f.includes('.dc-patch-')), []);
  });
  await check('apply_patch refuses symlink escapes', async () => {
    const victim = path.join(outside, 'victim.txt');
    fs.writeFileSync(victim, 'alpha\nbeta\ngamma\n');
    fs.symlinkSync(victim, path.join(root, 'victim-link.txt'));
    expectCode(await call('apply_patch', { path: path.join(root, 'victim-link.txt'), patch, expectedSha256: sha(original) }), 'DC_PATH_OUTSIDE_ALLOWED_SCOPE', 'symlink');
    assert.equal(fs.readFileSync(victim, 'utf8'), 'alpha\nbeta\ngamma\n');
  });

  // --------------------------------------------------------------------- git
  const gitRepo = path.join(root, 'repo');
  fs.mkdirSync(gitRepo);
  const g = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd: gitRepo, encoding: 'utf8' }).trim();
  g('init', '-q');
  fs.writeFileSync(path.join(gitRepo, 'a.txt'), 'a\n');
  g('add', 'a.txt');
  g('commit', '-q', '-m', 'init');
  const head = g('rev-parse', 'HEAD');
  await check('git_state clean repo', async () => {
    const r = await call('git_state', { repoPath: gitRepo });
    assert.equal(r.json.headSha, head);
    assert.equal(r.json.branch, 'main');
    assert.equal(r.json.branchIsInformationalOnly, true);
    assert.equal(r.json.detached, false);
    assert.equal(r.json.dirty, false);
    assert.deepEqual(r.json.counts, { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 });
  });
  await check('git_state dirty / staged / untracked / stash', async () => {
    fs.writeFileSync(path.join(gitRepo, 'a.txt'), 'a2\n');
    fs.writeFileSync(path.join(gitRepo, 'staged.txt'), 's\n');
    g('add', 'staged.txt');
    fs.writeFileSync(path.join(gitRepo, 'untracked file.txt'), 'u\n');
    const r = await call('git_state', { repoPath: gitRepo });
    assert.equal(r.json.dirty, true);
    assert.deepEqual(r.json.counts, { staged: 1, unstaged: 1, untracked: 1, conflicts: 0 });
    assert.ok(r.json.entries.some((e) => e.path === 'untracked file.txt' && e.kind === 'untracked'));
    g('stash', 'push', '-q', '-m', 'wip');
    const s = await call('git_state', { repoPath: gitRepo });
    assert.equal(s.json.stashes.length, 1);
    assert.match(s.json.stashes[0].subject, /wip/);
  });
  await check('verify_head match, explicit mismatch, invalid input, non-repo', async () => {
    const ok = await call('verify_head', { repoPath: gitRepo, expectedSha: head });
    assert.equal(ok.json.match, true);
    assert.equal(ok.json.actualSha, head);
    const bad = await call('verify_head', { repoPath: gitRepo, expectedSha: 'f'.repeat(40) });
    assert.equal(bad.isError, false);
    assert.equal(bad.json.match, false);
    assert.equal(bad.json.code, 'DC_HEAD_MISMATCH');
    expectCode(await call('verify_head', { repoPath: gitRepo, expectedSha: head.slice(0, 7) }), 'DC_INVALID_ARGUMENT', 'short sha');
    expectCode(await call('verify_head', { repoPath: path.join(root, 'bin'), expectedSha: head }), 'DC_NOT_A_GIT_REPOSITORY', 'non-repo');
  });
  await check('git_state detached HEAD', async () => {
    g('checkout', '-q', '--detach');
    const r = await call('git_state', { repoPath: gitRepo });
    assert.equal(r.json.detached, true);
    assert.equal(r.json.branch, null);
    assert.equal(r.json.headSha, head);
  });
  await check('expectedHeadSha preconditions fail closed on mutating tools', async () => {
    const f = path.join(gitRepo, 'a.txt');
    const before = fs.readFileSync(f, 'utf8');
    expectCode(await call('apply_patch', { path: f, patch: '@@ -1 +1 @@\n-a\n+b\n', expectedSha256: sha(before), expectedHeadSha: 'e'.repeat(40) }), 'DC_HEAD_MISMATCH', 'patch');
    assert.equal(fs.readFileSync(f, 'utf8'), before);
    expectCode(await call('run_command', { argv: ['node', '-v'], cwd: gitRepo, expectedHeadSha: 'e'.repeat(40) }), 'DC_HEAD_MISMATCH', 'run');
    const ok = await call('run_command', { argv: ['node', '-v'], cwd: gitRepo, expectedHeadSha: head });
    assert.equal(ok.json.headSha, head);
  });

  // ---------------------------------------------------------------- snapshot
  await check('file snapshot / restore with before/after hashes', async () => {
    const f = path.join(root, 'snap-me.txt');
    fs.writeFileSync(f, 'v1\n');
    const s = await call('snapshot_path', { path: f, reason: `before edit ${FAKE_GITHUB_TOKEN}` });
    assert.equal(s.isError, false, s.texts.join());
    assert.match(s.json.snapshotId, /^snap_\d{8}T\d{6}Z_[a-f0-9]{16}$/);
    assert.equal(s.json.contentSha256, sha('v1\n'));
    fs.writeFileSync(f, 'v2\n');
    expectCode(await call('restore_snapshot', { snapshotId: s.json.snapshotId, expectedCurrentSha256: sha('v1\n') }), 'DC_HASH_MISMATCH', 'expected current');
    assert.equal(fs.readFileSync(f, 'utf8'), 'v2\n');
    const r = await call('restore_snapshot', { snapshotId: s.json.snapshotId, expectedCurrentSha256: sha('v2\n') });
    assert.equal(r.isError, false, r.texts.join());
    assert.equal(fs.readFileSync(f, 'utf8'), 'v1\n');
    assert.equal(r.json.beforeSha256, sha('v2\n'));
    assert.equal(r.json.afterSha256, sha('v1\n'));
    assert.match(r.json.preRestoreSnapshotId, /^snap_/);
    const manifest = fs.readFileSync(path.join(home, '.desktop-commander', 'snapshots', s.json.snapshotId, 'manifest.json'), 'utf8');
    assert.equal(manifest.includes(FAKE_GITHUB_TOKEN), false, 'reason is redacted in the manifest');
  });
  let dirSnapshot;
  const tree = path.join(root, 'tree');
  await check('directory snapshot / restore (nested files, symlink recorded not followed)', async () => {
    fs.mkdirSync(path.join(tree, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'one.txt'), '1');
    fs.writeFileSync(path.join(tree, 'sub', 'two.txt'), '2');
    fs.symlinkSync(outside, path.join(tree, 'out-link'));
    const s = await call('snapshot_path', { path: tree });
    dirSnapshot = s.json;
    assert.equal(s.json.kind, 'directory');
    assert.equal(s.json.entryCount, 4);
    fs.rmSync(path.join(tree, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'extra.txt'), 'x');
    const r = await call('restore_snapshot', { snapshotId: s.json.snapshotId });
    assert.equal(r.isError, false, r.texts.join());
    assert.equal(fs.readFileSync(path.join(tree, 'sub', 'two.txt'), 'utf8'), '2');
    assert.equal(fs.existsSync(path.join(tree, 'extra.txt')), false);
    assert.equal(fs.lstatSync(path.join(tree, 'out-link')).isSymbolicLink(), true);
    assert.equal(r.json.afterSha256, s.json.contentSha256);
  });
  await check('restore rejects corrupted objects, tampered manifests, traversal', async () => {
    const dir = path.join(home, '.desktop-commander', 'snapshots', dirSnapshot.snapshotId);
    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const obj = path.join(dir, 'objects', manifest.entries.find((e) => e.type === 'file').sha256);
    fs.chmodSync(obj, 0o600);
    fs.writeFileSync(obj, 'tampered');
    expectCode(await call('restore_snapshot', { snapshotId: dirSnapshot.snapshotId }), 'DC_SNAPSHOT_INVALID', 'object');
    // Re-sealed manifest with a traversal entry is still refused.
    manifest.entries.push({ relPath: '../escape', type: 'file', mode: 420, size: 1, mtimeMs: 0, sha256: 'a'.repeat(64) });
    fs.chmodSync(manifestPath, 0o600);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.chmodSync(path.join(dir, 'manifest.sha256'), 0o600);
    fs.writeFileSync(path.join(dir, 'manifest.sha256'), sha(JSON.stringify(manifest)));
    expectCode(await call('restore_snapshot', { snapshotId: dirSnapshot.snapshotId }), 'DC_SNAPSHOT_INVALID', 'traversal');
    fs.writeFileSync(manifestPath, '{}');
    expectCode(await call('restore_snapshot', { snapshotId: dirSnapshot.snapshotId }), 'DC_SNAPSHOT_INVALID', 'seal');
    expectCode(await call('restore_snapshot', { snapshotId: '../../../etc/passwd' }), 'DC_INVALID_ARGUMENT', 'id traversal');
    expectCode(await call('restore_snapshot', { snapshotId: 'snap_20260101T000000Z_0000000000000000' }), 'DC_SNAPSHOT_INVALID', 'unknown id');
    assert.equal(fs.existsSync(path.join(tree, 'one.txt')), true, 'target untouched');
  });
  await check('unbounded snapshots are refused', async () => {
    const big = path.join(root, 'big');
    fs.mkdirSync(big);
    for (let i = 0; i < 5_001; i += 1) fs.writeFileSync(path.join(big, `f${i}`), '');
    expectCode(await call('snapshot_path', { path: big }), 'DC_SNAPSHOT_TOO_LARGE', 'too large');
    expectCode(await call('snapshot_path', { path: outside }), 'DC_PATH_OUTSIDE_ALLOWED_SCOPE', 'outside');
  });

  // ------------------------------------------------------------------ search
  const corpus = path.join(root, 'corpus');
  fs.mkdirSync(corpus);
  for (let i = 0; i < 40; i += 1) fs.writeFileSync(path.join(corpus, `file${i}.txt`), 'needle foobar\nfo(o needle\n'.repeat(3));
  fs.writeFileSync(path.join(outside, 'secret-outside.txt'), 'needle-outside-only\n');
  fs.symlinkSync(outside, path.join(corpus, 'linked-outside'));
  const drain = async (sessionId) => {
    for (let i = 0; i < 100; i += 1) {
      const r = await call('get_more_search_results', { sessionId, structured: true });
      if (r.isError || r.json.status === 'completed') return r;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error('search did not complete');
  };
  await check('search: global result cap is enforced and reported', async () => {
    const s = await call('start_search', { path: corpus, pattern: 'needle', searchType: 'content', maxResults: 5, structured: true });
    assert.equal(s.isError, false, s.texts.join());
    const r = await drain(s.json.sessionId);
    assert.ok(r.json.totalResults <= 5, String(r.json.totalResults));
    assert.equal(r.json.resultsTruncated, true);
  });
  await check('search: regex vs literal, invalid regex is a deterministic error', async () => {
    const regex = await drain((await call('start_search', { path: corpus, pattern: 'fo+bar', searchType: 'content', structured: true })).json.sessionId);
    assert.ok(regex.json.totalMatches > 0);
    const literal = await drain((await call('start_search', { path: corpus, pattern: 'fo(o', searchType: 'content', literalSearch: true, structured: true })).json.sessionId);
    assert.ok(literal.json.totalMatches > 0);
    const bad = await drain((await call('start_search', { path: corpus, pattern: 'fo(o', searchType: 'content', structured: true })).json.sessionId);
    expectCode(bad, 'DC_INVALID_ARGUMENT', 'invalid regex');
  });
  await check('search: symlinks are not followed and scope is enforced', async () => {
    const r = await drain((await call('start_search', { path: corpus, pattern: 'needle-outside-only', searchType: 'content', structured: true })).json.sessionId);
    assert.equal(r.json.totalMatches, 0);
    const out = await call('start_search', { path: outside, pattern: 'needle', structured: true });
    expectCode(out, 'DC_PATH_OUTSIDE_ALLOWED_SCOPE', 'outside root');
  });
  await check('search: timeout is reported; cancellation works', async () => {
    const s = await call('start_search', { path: root, pattern: 'zzz-no-match', searchType: 'content', timeout_ms: 1, structured: true });
    const r = await drain(s.json.sessionId);
    assert.equal(r.json.timedOut, true);
    const s2 = await call('start_search', { path: root, pattern: 'x', searchType: 'content', timeout_ms: 60000, structured: true });
    const stop = await call('stop_search', { sessionId: s2.json.sessionId });
    assert.equal(stop.isError, false);
  });

  // ------------------------------------------------------------- secret_scan
  const secrets = [
    FAKE_GITHUB_TOKEN,
    'AKIAABCDEFGHIJKLMNOP',
    FAKE_JWT,
    '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----',
  ];
  await check('secret_scan detects common classes and never returns raw values', async () => {
    const text = `token=${secrets[0]}\naws=${secrets[1]}\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz123456\nDB_PASSWORD=hunter2hunter2\njwt ${secrets[2]}\n${secrets[3]}\n`;
    const r = await call('secret_scan', { target: 'text', text });
    const categories = new Set(r.json.findings.map((f) => f.category));
    for (const c of ['token', 'cloud_credential', 'jwt', 'private_key', 'env_secret']) assert.ok(categories.has(c), c);
    const out = r.texts.join('\n');
    for (const s of [...secrets, 'hunter2hunter2', 'abcdefghijklmnopqrstuvwxyz123456']) assert.equal(out.includes(s), false, 'raw secret leaked');
    const clean = await call('secret_scan', { target: 'text', text: 'nothing to see here' });
    assert.equal(clean.json.clean, true);
  });
  await check('secret_scan file (scoped) and diff (added lines only)', async () => {
    const f = path.join(root, '.env');
    fs.writeFileSync(f, `API_KEY=${'z'.repeat(24)}\n`);
    const r = await call('secret_scan', { target: 'file', path: f });
    assert.equal(r.json.findingCount, 1);
    expectCode(await call('secret_scan', { target: 'file', path: path.join(outside, 'secret-outside.txt') }), 'DC_PATH_OUTSIDE_ALLOWED_SCOPE', 'outside');
    const d = await call('secret_scan', { target: 'diff', patch: `@@ -1 +1 @@\n-${secrets[0]}\n+safe\n` });
    assert.equal(d.json.clean, true, 'removed lines are not findings');
    const d2 = await call('secret_scan', { target: 'diff', patch: `@@ -1 +1 @@\n-safe\n+${secrets[0]}\n` });
    assert.equal(d2.json.findingCount, 1);
    assert.equal(d2.json.findings[0].line, 3);
  });

  // ------------------------------------------------- manifest + preview
  await check('capability_manifest is mechanical and never claims authorization', async () => {
    const r = await call('capability_manifest', {});
    assert.equal(JSON.stringify(r.json).includes('"authorized"'), false);
    const byName = Object.fromEntries(r.json.tools.map((t) => [t.tool, t]));
    assert.equal(byName.apply_patch.authorization, 'external');
    assert.deepEqual(byName.apply_patch.supportedPreconditions, ['expectedSha256', 'expectedHeadSha']);
    assert.equal(byName.run_command.shellExecution, false);
    assert.equal(byName.start_process.shellExecution, true);
    assert.match(byName.kill_process.legacy, /LEGACY/);
    assert.equal(byName.service_status.managedDisposition, 'unsupported');
    expectCode(await call('capability_manifest', { tool: 'nope' }), 'DC_INVALID_ARGUMENT', 'unknown tool');
  });
  await check('operation_preview resolves mechanically and never authorizes', async () => {
    const r = await call('operation_preview', { tool: 'run_command', arguments: { argv: ['node', '-v'], cwd: path.join(root, '.'), origin: 'llm' } });
    assert.equal(r.json.mechanically_valid, true, JSON.stringify(r.json.problems));
    assert.equal(r.json.authorization, 'external');
    assert.equal(JSON.stringify(r.json).includes('"authorized"'), false);
    assert.equal(r.json.command.usesShell, false);
    assert.equal(r.json.cwd.resolved, root);
    assert.equal(r.json.normalizedArguments.origin, undefined);
    const shell = await call('operation_preview', { tool: 'start_process', arguments: { command: 'sudo ls', timeout_ms: 1 } });
    assert.equal(shell.json.usesShell, true);
    assert.equal(shell.json.mechanically_valid, false);
    assert.ok(shell.json.problems.some((p) => p.startsWith('DC_COMMAND_FORBIDDEN')));
    const out = await call('operation_preview', { tool: 'read_file', arguments: { path: path.join(outside, 'secret-outside.txt') } });
    assert.equal(out.json.mechanically_valid, false);
    assert.equal(out.json.paths[0].insideAllowedDirectories, false);
    assert.equal(out.json.paths[0].resolved, null);
  });

  // ---------------------------------------------------------- service_status
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/health' ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: req.url === '/health', token: FAKE_GITHUB_TOKEN }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await check('service_status generic probes, private-only, redacted bodies', async () => {
    const r = await call('service_status', {
      checks: [
        { type: 'http', url: `http://127.0.0.1:${port}/health` },
        { type: 'http', url: `http://127.0.0.1:${port}/down` },
        { type: 'port', host: '127.0.0.1', port },
        { type: 'port', host: '127.0.0.1', port: 1 },
        { type: 'executable', name: 'node' },
        { type: 'process', pid: process.pid },
        { type: 'http', url: 'http://8.8.8.8/' },
        { type: 'http', url: `http://user:pw@127.0.0.1:${port}/health` },
        { type: 'systemd_user', name: 'dc-test-unit-that-does-not-exist' },
      ],
      timeoutMs: 2000,
    });
    const [up, down, portUp, portDown, exe, proc, pub, creds, unit] = r.json.results;
    assert.equal(up.status, 'up');
    assert.equal(up.detail.statusCode, 200);
    assert.equal(down.status, 'down');
    assert.equal(portUp.status, 'up');
    assert.equal(portDown.status, 'down');
    assert.equal(exe.status, 'up');
    assert.equal(proc.status, 'up');
    assert.equal(proc.detail.ownedByCurrentUser, true);
    assert.equal(pub.status, 'error');
    assert.equal(pub.errorCode, 'DC_INVALID_ARGUMENT');
    assert.equal(creds.errorCode, 'DC_INVALID_ARGUMENT');
    assert.ok(['unknown', 'down'].includes(unit.status));
    assert.equal(r.texts.join('').includes(FAKE_GITHUB_TOKEN), false, 'probe body secrets redacted');
    expectCode(await call('service_status', { checks: [{ type: 'http', url: `http://127.0.0.1:${port}/`, headers: { authorization: 'x' } }] }), 'DC_INVALID_ARGUMENT', 'no headers');
  });
  server.close();

  // ------------------------------------------------ last_error + regressions
  await check('last_error correlates by requestId and redacts secrets', async () => {
    const failed = await call('run_command', { argv: [FAKE_GITHUB_TOKEN], cwd: root });
    const body = expectCode(failed, 'DC_COMMAND_NOT_FOUND', 'secret argv');
    assert.equal(failed.texts.join('').includes(FAKE_GITHUB_TOKEN), false, 'error body redacted');
    const r = await call('last_error', { requestId: body.requestId });
    assert.equal(r.json.count, 1);
    const rec = r.json.errors[0];
    assert.equal(rec.tool, 'run_command');
    assert.equal(rec.errorCode, 'DC_COMMAND_NOT_FOUND');
    assert.equal(rec.stage, 'resolve');
    assert.equal(rec.retryable, false);
    assert.match(rec.normalizedArgumentsHash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(r.json).includes(FAKE_GITHUB_TOKEN), false);
    const legacy = await call('read_file', { path: path.join(outside, 'secret-outside.txt') });
    assert.equal(legacy.isError, true);
    assert.equal(legacy.json?.dcError?.code, 'DC_PATH_OUTSIDE_ALLOWED_SCOPE', 'legacy tool errors gain a structured code');
    const latest = await call('last_error', {});
    assert.equal(latest.json.errors[0].tool, 'read_file');
  });
  await check('regression: get_config / list_directory / get_runtime_identity with origin', async () => {
    for (const [name, args] of [['get_config', { origin: 'llm' }], ['list_directory', { path: root, origin: 'ui' }], ['get_runtime_identity', {}]]) {
      const r = await call(name, args);
      assert.equal(r.isError, false, `${name}: ${r.texts.join()}`);
    }
  });

  // ----------------------------------------------------------------- events
  await check('execution events: correlation, hashes, outcomes, redaction', async () => {
    const ok = await call('run_command', { argv: ['node', '-e', '0', FAKE_GITHUB_TOKEN], cwd: root, origin: 'llm' });
    const text = fs.readFileSync(eventsFile, 'utf8');
    assert.equal(text.includes(FAKE_GITHUB_TOKEN), false, 'no raw secret in events');
    const events = text.trim().split('\n').map((l) => JSON.parse(l));
    const ev = events.find((e) => e.requestId === ok.meta.dcExecution.requestId);
    assert.ok(ev, 'event for request');
    assert.equal(ev.schema, 'dc.execution-event.v1');
    assert.equal(ev.outcome, 'success');
    assert.equal(ev.exitCode, 0);
    assert.equal(ev.origin, 'llm');
    assert.equal(ev.cwd, root);
    assert.equal(ev.operationClass, 'process.process');
    assert.deepEqual(ev.mechanical, { riskClass: 'process', authorization: 'external' });
    const { authorizationArguments, strictCanonicalJsonV1 } = await import(path.join(repo, 'dist', 'managed-acs.js'));
    assert.equal(ev.normalizedArgumentsHash, sha(strictCanonicalJsonV1(authorizationArguments({ argv: ['node', '-e', '0', FAKE_GITHUB_TOKEN], cwd: root, origin: 'llm' }))));
    assert.match(ev.results.stdoutSha256, /^[a-f0-9]{64}$/);
    const err = events.filter((e) => e.outcome === 'error' && e.errorCode === 'DC_COMMAND_NOT_FOUND');
    assert.ok(err.length > 0, 'error events carry errorCode');
    for (const e of events) assert.equal(/"std(out|err)":"/.test(JSON.stringify(e)), false, 'events carry hashes, not output text');
  });
  // ------------------------- no bypass of the pre-existing execution kernel
  await check('run_command is subject to the same standalone kernel gates as start_process', async () => {
    const strict = new Client({ name: 'dc-exec-kernel', version: '0' }, { capabilities: {} });
    await strict.connect(new StdioClientTransport({
      command: process.execPath,
      args: [path.join(repo, 'dist', 'index.js'), '--standalone'],
      cwd: root,
      env: { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', DC_NETWORK_PROFILE: 'none', DC_DISABLE_EXECUTOR_LEASE: '1' },
      stderr: 'ignore',
    }));
    try {
      const run = async (argv) => {
        const r = await strict.callTool({ name: 'run_command', arguments: { argv, cwd: root } });
        return { isError: !!r.isError, text: r.content.map((c) => c.text).join('\n') };
      };
      const marker = path.join(root, 'kernel-marker');
      const unmatched = await run(['node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`]);
      assert.equal(unmatched.isError, true);
      assert.match(unmatched.text, /APPROVAL_REQUIRED/);
      assert.equal(fs.existsSync(marker), false, 'unmatched command must not run without approval');
      const net = await run(['curl', 'http://127.0.0.1:9/']);
      assert.match(net.text, /NETWORK_BINARY_BLOCKED/);
      const destructive = await run(['rm', '-rf', path.join(root, 'notes.txt')]);
      assert.match(destructive.text, /APPROVAL_REQUIRED/);
      assert.equal(fs.existsSync(path.join(root, 'notes.txt')), true);
      const probes = await strict.callTool({ name: 'service_status', arguments: { checks: [{ type: 'port', port: 22 }, { type: 'executable', name: 'node' }] } });
      const probeJson = JSON.parse(probes.content[0].text);
      assert.equal(probeJson.results[0].errorCode, 'DC_COMMAND_FORBIDDEN', 'network probes honour DC_NETWORK_PROFILE=none');
      assert.equal(probeJson.results[1].status, 'up');
      const scan = await strict.callTool({ name: 'secret_scan', arguments: { target: 'text', text: 'nothing' } });
      assert.equal(scan.isError, undefined, 'secret_scan is detection-only, not gated as a credential read');
    } finally {
      await strict.close().catch(() => {});
    }
  });
  // ------------------------------------------------ audit-log redaction
  await check('audit chain stores no raw secrets or content-bearing arguments', async () => {
    const auditDir = path.join(home, '.desktop-commander', 'audit');
    const audit = fs.readdirSync(auditDir).filter((f) => f.endsWith('.jsonl')).map((f) => fs.readFileSync(path.join(auditDir, f), 'utf8')).join('');
    assert.ok(audit.includes('"tool":"secret_scan"'), 'secret_scan calls were audited');
    assert.equal(audit.includes(FAKE_GITHUB_TOKEN), false, 'no raw token in the audit chain');
    assert.equal(audit.includes('hunter2hunter2'), false, 'no scanned text in the audit chain');
    assert.equal(audit.includes('+BETA'), false, 'no raw patch text in the audit chain');
    // argsPreview is a JSON string nested in the JSONL line (quotes escaped).
    assert.match(audit, /\\"patch\\":\{\\"bytes\\":\d+,\\"sha256\\":\\"[a-f0-9]{64}\\"\}/, 'patch summarized as bytes+sha256');
  });
} finally {
  for (const pid of cleanupPids) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  await client.close().catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}
console.log(`execution tools (MCP stdio): ${passed.length} checks passed`);
