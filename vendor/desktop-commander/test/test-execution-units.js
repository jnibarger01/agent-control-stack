/**
 * Unit-level execution-plane tests for behaviour that cannot be forced
 * deterministically through MCP: degraded/failed health subsystems, event
 * sink failure, apply_patch's concurrent-modification commit guard, and
 * redaction internals.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-exec-units-')));
const root = path.join(home, 'work');
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(path.join(home, '.claude-server-commander'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude-server-commander', 'config.json'), JSON.stringify({ allowedDirectories: [root], blockedCommands: [], telemetryEnabled: false }));
process.env.HOME = home;
process.env.DESKTOP_COMMANDER_STATE_DIR = path.join(home, '.desktop-commander');

const { collectHealth } = await import('../dist/execution/health.js');
const { executionEvents } = await import('../dist/execution/events.js');
const { applyPatch, applyHunks, parseUnifiedDiff } = await import('../dist/execution/apply-patch.js');
const { redactValue, redactText, scanText } = await import('../dist/execution/secret-scan.js');
const { sanitizeMessage, recordLastError, lastErrors, clearLastErrors } = await import('../dist/execution/last-error.js');
const { DcToolError, toDcError } = await import('../dist/execution/errors.js');
const { isPrivateOrLoopback } = await import('../dist/execution/service-status.js');
const { parsePorcelainV2 } = await import('../dist/execution/git.js');
const { auditArgsPreview } = await import('../dist/enforcement/pipeline.js');

const sha = (d) => crypto.createHash('sha256').update(d).digest('hex');
const token = `ghp_${'Z9y8X7w6'.repeat(5)}`;
const healthyDeps = {
  getConfig: async () => ({ allowedDirectories: [root], blockedCommands: ['sudo'] }),
  runtimeIdentity: async () => ({ runtime_id: 'rt_1', remote_auth_state: 'none' }),
  processManager: async () => ({ active: 0, completed: 0 }),
  searchEngine: async () => ({ ripgrepPath: process.execPath, activeSearches: 0 }),
  managedTransport: async () => ({ mode: 'standalone', identity: 'standalone' }),
};

try {
  // health: all healthy
  const ok = await collectHealth(healthyDeps);
  assert.equal(ok.status, 'healthy', JSON.stringify(ok.subsystems));

  // health: one degraded subsystem (managed transport awaiting handshake)
  const degraded = await collectHealth({ ...healthyDeps, managedTransport: async () => ({ mode: 'managed', identity: 'not_initialized' }) });
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.subsystems.managed_transport.status, 'degraded');

  // health: config failure cascades only to dependent subsystems, never crashes
  const noConfig = await collectHealth({ ...healthyDeps, getConfig: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } });
  assert.equal(noConfig.status, 'unhealthy');
  assert.equal(noConfig.subsystems.configuration.errorCode, 'EACCES');
  assert.equal(noConfig.subsystems.allowed_directories.status, 'unhealthy');
  assert.equal(noConfig.subsystems.process_manager.status, 'ok');
  assert.equal(noConfig.configHash, null);

  // health: process manager failure and a hanging probe still produce a report
  const started = Date.now();
  const broken = await collectHealth({
    ...healthyDeps,
    processManager: async () => { throw new Error('boom'); },
    runtimeIdentity: () => new Promise(() => {}),
  });
  assert.equal(broken.subsystems.process_manager.status, 'unhealthy');
  assert.equal(broken.subsystems.runtime_identity.errorCode, 'DC_TIMEOUT');
  assert.ok(Date.now() - started < 5_000, 'hanging probe bounded');
  assert.equal(JSON.stringify(broken).includes('boom'), false, 'internal error text not exposed');

  // event sink failure never breaks emission; health reports it degraded
  executionEvents.addSink({ name: 'failing', write() { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } });
  const event = executionEvents.emit({
    requestId: 'dcreq_x', correlationId: null, runtimeId: null, tool: 'run_command', operationClass: 'process.process', outcome: 'success',
    normalizedArgumentsHash: null, origin: null, durationMs: 1, mechanical: { riskClass: 'process', authorization: 'external' },
    results: { note: `leaked ${token}`, apiToken: 'plain-value-123' },
  });
  assert.equal(JSON.stringify(event).includes(token), false, 'event redacted');
  assert.equal(event.results.apiToken, '[REDACTED:field]');
  assert.equal(event.mechanical.authorization, 'external');
  const failing = executionEvents.sinkStatuses().find((s) => s.name === 'failing');
  assert.equal(failing.status, 'degraded');
  assert.equal(failing.lastErrorCode, 'ENOSPC');
  assert.equal(executionEvents.memory.recent(1)[0].eventId, event.eventId, 'memory sink still received it');
  const sinkHealth = await collectHealth(healthyDeps);
  assert.equal(sinkHealth.subsystems.event_sinks.status, 'degraded');
  executionEvents.removeSink('failing');

  // apply_patch: concurrent change between validation and commit
  const f = path.join(root, 'race.txt');
  fs.writeFileSync(f, 'a\nb\nc\n');
  await assert.rejects(
    applyPatch({ path: f, patch: '@@ -2 +2 @@\n-b\n+B\n', expectedSha256: sha('a\nb\nc\n') }, {
      beforeCommit: (target) => fs.writeFileSync(target, 'a\nb\nc\nconcurrent\n'),
    }),
    (e) => e instanceof DcToolError && e.dcCode === 'DC_PATH_CHANGED' && e.stage === 'commit',
  );
  assert.equal(fs.readFileSync(f, 'utf8'), 'a\nb\nc\nconcurrent\n', 'concurrent write is never overwritten');
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.includes('.dc-patch-')), [], 'no temp files left');
  // replaced by a different inode with identical content is also refused
  fs.writeFileSync(f, 'x\n');
  await assert.rejects(
    applyPatch({ path: f, patch: '@@ -1 +1 @@\n-x\n+y\n', expectedSha256: sha('x\n') }, {
      beforeCommit: (target) => { fs.writeFileSync(`${target}.new`, 'x\n'); fs.renameSync(`${target}.new`, target); },
    }),
    (e) => e.dcCode === 'DC_PATH_CHANGED',
  );

  // patch engine edge cases
  assert.equal(applyHunks('a\nb', parseUnifiedDiff('@@ -2 +2 @@\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n')).text, 'a\nc');
  assert.equal(applyHunks('a\nb\n', parseUnifiedDiff('@@ -0,0 +1 @@\n+z\n')).text, 'z\na\nb\n');
  assert.equal(applyHunks('a\nb\nc\nd\n', parseUnifiedDiff('@@ -9,1 +9,1 @@\n-c\n+C\n')).text, 'a\nb\nC\nd\n', 'unique relocation');
  assert.throws(() => parseUnifiedDiff('--- a/x\n+++ b/x\nnew file mode 100644\n'), (e) => e.dcCode === 'DC_PATCH_REJECTED');

  // redaction internals
  assert.equal(redactText(`key ${token} end`), 'key [REDACTED:github_token] end');
  assert.deepEqual(redactValue({ password: 'x', nested: { authorization: 'Bearer abc', ok: 1, flag: true } }), { password: '[REDACTED:field]', nested: { authorization: '[REDACTED:field]', ok: 1, flag: true } });
  assert.equal(scanText('nothing here').length, 0);
  assert.equal(sanitizeMessage(`Error: bad ${token}\n    at foo (/x.js:1:1)\n    at bar`), 'Error: bad [REDACTED:github_token]');

  // last_error records are sanitized and correlated
  clearLastErrors();
  recordLastError({ requestId: 'dcreq_1', correlationId: 'corr-9', tool: 'apply_patch', normalizedArgumentsHash: 'h' }, new DcToolError('DC_HASH_MISMATCH', `mismatch ${token}`, { stage: 'precondition' }));
  recordLastError({ requestId: 'dcreq_2', correlationId: null, tool: 'read_file', normalizedArgumentsHash: null }, Object.assign(new Error('nope'), { code: 'ENOENT' }));
  const [latest] = lastErrors();
  assert.equal(latest.requestId, 'dcreq_2');
  assert.equal(latest.errorCode, 'DC_PATH_NOT_FOUND');
  assert.equal(latest.errno, 'ENOENT');
  const [byCorr] = lastErrors({ correlationId: 'corr-9' });
  assert.equal(byCorr.errorCode, 'DC_HASH_MISMATCH');
  assert.equal(byCorr.stage, 'precondition');
  assert.equal(byCorr.message.includes(token), false);
  assert.equal(toDcError(new Error('Path not allowed: /etc')).dcCode, 'DC_PATH_OUTSIDE_ALLOWED_SCOPE');

  // audit argsPreview: content summarized, secrets redacted, paths kept
  const preview = auditArgsPreview({ path: '/w/a.txt', content: `x ${token}`, patch: '+secret line', command: `curl -H "Authorization: Bearer ${'k'.repeat(24)}"`, api_key: 'abc12345678' });
  assert.equal(preview.path, '/w/a.txt');
  assert.deepEqual(Object.keys(preview.content), ['bytes', 'sha256']);
  assert.equal(preview.patch.sha256, sha('+secret line'));
  assert.equal(JSON.stringify(preview).includes('k'.repeat(24)), false);
  assert.equal(preview.api_key, '[REDACTED:field]');

  // service_status address policy
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '::1', 'fd00::1', '::ffff:127.0.0.1', '100.64.0.1']) assert.equal(isPrivateOrLoopback(a), true, a);
  for (const a of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPrivateOrLoopback(a), false, a);

  // porcelain v2 parser: rename + unmerged + untracked with spaces
  const parsed = parsePorcelainV2([
    '# branch.oid ' + 'a'.repeat(40), '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 ' + 'b'.repeat(40) + ' ' + 'b'.repeat(40) + ' file with space.txt',
    '2 R. N... 100644 100644 100644 ' + 'c'.repeat(40) + ' ' + 'c'.repeat(40) + ' R100 new.txt', 'old.txt',
    'u UU N... 100644 100644 100644 100644 ' + 'd'.repeat(40) + ' ' + 'd'.repeat(40) + ' ' + 'd'.repeat(40) + ' conflict.txt',
    '? untracked dir/x.txt', '',
  ].join('\0'));
  assert.equal(parsed.ahead, 2);
  assert.equal(parsed.behind, 1);
  assert.equal(parsed.entries[0].path, 'file with space.txt');
  assert.deepEqual(parsed.entries[1], { kind: 'renamed', index: 'R', worktree: '.', path: 'new.txt', origPath: 'old.txt' });
  assert.equal(parsed.entries[2].kind, 'unmerged');
  assert.equal(parsed.entries[3].path, 'untracked dir/x.txt');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
console.log('execution unit tests passed');
