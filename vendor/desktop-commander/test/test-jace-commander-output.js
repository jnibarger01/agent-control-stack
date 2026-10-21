#!/usr/bin/env node
/**
 * Process session output: absolute cursors across trimming, multibyte chunk splits,
 * long-poll reads, and spawn-failure handling. Exercises the registry directly; the MCP
 * surface is covered by test-jace-commander-ops.js.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProcessRegistry, OutputBuffer } from '../dist/jace-commander/processes.js';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-output-')));
const policy = { roots: [tmp], deniedRoots: [] };
const registry = createProcessRegistry();
const MAX_OUTPUT = 256 * 1024;
let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}
const exe = (name) => {
  for (const dir of ['/usr/bin', '/bin']) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`${name} not found`);
};
// output() returns at once when the cursor is behind, so the loop must yield to let child I/O run.
const waitForExit = async (sessionId) => {
  for (;;) {
    const out = await registry.output({ sessionId, waitMs: 1000 });
    if (!out.running) return out;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

await test('OutputBuffer keeps absolute offsets after the front is trimmed', () => {
  const buffer = new OutputBuffer();
  buffer.write(Buffer.from('a'.repeat(MAX_OUTPUT + 1000)));
  assert.equal(buffer.end, MAX_OUTPUT + 1000);
  const fromStart = buffer.read(0);
  assert.equal(fromStart.skipped, 1000, '1000 characters were dropped before the retained tail');
  assert.equal(fromStart.text.length, MAX_OUTPUT);
  assert.equal(fromStart.nextOffset, MAX_OUTPUT + 1000);
  const caughtUp = buffer.read(fromStart.nextOffset);
  assert.equal(caughtUp.text, '');
  assert.equal(caughtUp.skipped, 0);
  buffer.write(Buffer.from('tail'));
  assert.equal(buffer.read(fromStart.nextOffset).text, 'tail', 'a cursor reads only what arrived after it');
});

await test('OutputBuffer holds a multibyte character split across chunks until it completes', () => {
  const buffer = new OutputBuffer();
  const euro = Buffer.from('€');
  buffer.write(euro.subarray(0, 1));
  assert.equal(buffer.read(0).text, '', 'an incomplete sequence is not emitted as replacement characters');
  buffer.write(euro.subarray(1));
  assert.equal(buffer.read(0).text, '€');
  assert.equal(buffer.end, 1);
});

await test('OutputBuffer clamps a cursor beyond the end instead of inventing text', () => {
  const buffer = new OutputBuffer();
  buffer.write(Buffer.from('abc'));
  const read = buffer.read(99);
  assert.equal(read.text, '');
  assert.equal(read.offset, 3);
  assert.equal(read.nextOffset, 3);
});

await test('start_process refuses a file that is not executable, instead of crashing the server', async () => {
  const file = path.join(tmp, 'not-executable.sh');
  fs.writeFileSync(file, '#!/bin/sh\necho hi\n', { mode: 0o644 });
  assert.throws(
    () => registry.start({ argv: [file], cwd: tmp }, policy),
    (error) => error.code === 'not_executable',
  );
});

await test('a long stream keeps the newest output; the cursor shows how much was lost', async () => {
  const started = registry.start({ argv: [exe('head'), '-c', String(MAX_OUTPUT + 20_000), '/dev/zero'], cwd: tmp, timeoutMs: 20_000 }, policy);
  const done = await waitForExit(started.sessionId);
  assert.equal(done.exitCode, 0);
  assert.equal(done.stdoutNextOffset, MAX_OUTPUT + 20_000);
  assert.equal(done.stdoutSkipped, 20_000);
  assert.equal(done.truncated, true);
  assert.equal(done.stdout.length, MAX_OUTPUT);
  const caughtUp = await registry.output({ sessionId: started.sessionId, offset: done.stdoutNextOffset });
  assert.equal(caughtUp.stdout, '');
  assert.equal(caughtUp.stdoutSkipped, 0);
});

await test('a reader resumes from its stored cursor and sees only new output', async () => {
  const started = registry.start({ argv: [exe('printf'), 'first\\n'], cwd: tmp, timeoutMs: 5000 }, policy);
  const first = await waitForExit(started.sessionId);
  assert.equal(first.stdout, 'first\n');
  const again = await registry.output({ sessionId: started.sessionId, offset: first.stdoutNextOffset });
  assert.equal(again.stdout, '');
  assert.equal(again.stdoutNextOffset, first.stdoutNextOffset);
});

await test('waitMs long-polls a running session and returns early once it exits', async () => {
  const started = registry.start({ argv: [exe('sleep'), '0.3'], cwd: tmp, timeoutMs: 5000 }, policy);
  const begun = Date.now();
  const out = await registry.output({ sessionId: started.sessionId, waitMs: 10_000 });
  const elapsed = Date.now() - begun;
  assert.equal(out.running, false, 'the wait ended because the process exited');
  assert.ok(elapsed < 5000, `wait took ${elapsed} ms; it should return at exit, not at waitMs`);
});

await test('waitMs returns after the timeout when the session stays silent', async () => {
  const started = registry.start({ argv: [exe('sleep'), '5'], cwd: tmp, timeoutMs: 10_000 }, policy);
  const begun = Date.now();
  const out = await registry.output({ sessionId: started.sessionId, waitMs: 200 });
  assert.equal(out.running, true);
  assert.ok(Date.now() - begun >= 150);
  registry.kill({ sessionId: started.sessionId });
  await waitForExit(started.sessionId);
});

await test('timeouts kill the child and mark the session timedOut', async () => {
  const started = registry.start({ argv: [exe('sleep'), '30'], cwd: tmp, timeoutMs: 200 }, policy);
  const out = await waitForExit(started.sessionId);
  assert.equal(out.timedOut, true);
  assert.equal(out.signal, 'SIGTERM');
  assert.equal(out.running, false);
});

await test('invalid cursors and waits are refused', async () => {
  const started = registry.start({ argv: [exe('true')], cwd: tmp }, policy);
  await assert.rejects(() => registry.output({ sessionId: started.sessionId, offset: -1 }), (error) => error.code === 'invalid_argument');
  await assert.rejects(() => registry.output({ sessionId: started.sessionId, waitMs: 60_000 }), (error) => error.code === 'invalid_argument');
  await assert.rejects(() => registry.output({ sessionId: 'proc_missing' }), (error) => error.code === 'not_found');
  await waitForExit(started.sessionId);
});

await test('a trim never leaves a lone low surrogate at the head of the retained output', () => {
  const buffer = new OutputBuffer();
  // Put an astral character so the cut lands between its two UTF-16 code units.
  const head = 'a'.repeat(5) + '\u{1F600}';
  const total = MAX_OUTPUT + 6;
  buffer.write(Buffer.from(head + 'b'.repeat(total - head.length), 'utf8'));
  const read = buffer.read(0);
  const first = read.text.charCodeAt(0);
  assert.ok(!(first >= 0xdc00 && first <= 0xdfff), `head must not be a lone low surrogate, got ${first.toString(16)}`);
  assert.ok(read.text.length <= MAX_OUTPUT);
});

await test('SIGKILL escalation reaches a descendant that ignores SIGTERM after its leader exits', async () => {
  // The leader exits on SIGTERM; its child ignores SIGTERM and stays in the group. The grace-period
  // SIGKILL must still reach the child (the escalation timer must not be cancelled by the leader's exit).
  const leaderScript = [
    "const { spawn } = require('child_process');",
    "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"], { stdio: 'ignore' });",
    "console.log('child=' + child.pid);",
    "process.on('SIGTERM', () => process.exit(0));",
    "setInterval(() => {}, 1000);",
  ].join('\n');
  const started = registry.start({ argv: [process.execPath, '-e', leaderScript], cwd: tmp, timeoutMs: 60_000 }, policy);
  let childPid;
  for (let attempt = 0; attempt < 100 && childPid === undefined; attempt += 1) {
    const out = await registry.output({ sessionId: started.sessionId, waitMs: 200 });
    const match = /child=(\d+)/u.exec(out.stdout);
    if (match) childPid = Number(match[1]);
  }
  assert.ok(childPid, 'leader reported its child pid');
  registry.kill({ sessionId: started.sessionId });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const deadline = Date.now() + 15_000;
  while (alive(childPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(alive(childPid), false, 'the SIGTERM-ignoring descendant was killed by the group escalation');
  await waitForExit(started.sessionId);
});

await test('a timeout still reaps a descendant after its leader has already exited', async () => {
  // The leader exits at once, leaving a SIGTERM-ignoring child in its group. The deadline must
  // survive the leader's exit so the timeout still signals the surviving group.
  const leaderScript = [
    "const { spawn } = require('child_process');",
    "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"], { stdio: 'ignore' });",
    "console.log('child=' + child.pid);",
  ].join('\n');
  const started = registry.start({ argv: [process.execPath, '-e', leaderScript], cwd: tmp, timeoutMs: 1_500 }, policy);
  let childPid;
  for (let attempt = 0; attempt < 100 && childPid === undefined; attempt += 1) {
    const out = await registry.output({ sessionId: started.sessionId, waitMs: 200 });
    const match = /child=(\d+)/u.exec(out.stdout);
    if (match) childPid = Number(match[1]);
  }
  assert.ok(childPid, 'leader reported its child pid');
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const deadline = Date.now() + 15_000;
  while (alive(childPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(alive(childPid), false, 'the deadline reached the descendant after the leader exited');
  await waitForExit(started.sessionId);
});

await test('a session stays running while a descendant keeps its process group alive after the leader exits', async () => {
  // The leader spawns a detached-from-stdio child, unrefs it, and exits. The group is still alive,
  // so the session must not report itself as exited, and the deadline must still be armed.
  const leaderScript = [
    "const { spawn } = require('child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });",
    "child.unref();",
    "console.log('child=' + child.pid);",
  ].join('\n');
  const started = registry.start({ argv: [process.execPath, '-e', leaderScript], cwd: tmp, timeoutMs: 60_000 }, policy);
  let childPid;
  for (let attempt = 0; attempt < 100 && childPid === undefined; attempt += 1) {
    const out = await registry.output({ sessionId: started.sessionId, waitMs: 200 });
    const match = /child=(\d+)/u.exec(out.stdout);
    if (match) childPid = Number(match[1]);
  }
  assert.ok(childPid, 'leader reported its child pid');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const before = await registry.output({ sessionId: started.sessionId });
  assert.equal(before.running, true, 'a live descendant keeps the session running');
  registry.kill({ sessionId: started.sessionId });
  await waitForExit(started.sessionId);
});

await test('a deadline does not mark a session timed out after it completes normally', async () => {
  const started = registry.start({ argv: [process.execPath, '-e', "console.log('done')"], cwd: tmp, timeoutMs: 1_000 }, policy);
  await waitForExit(started.sessionId);
  await new Promise((resolve) => setTimeout(resolve, 1_300));
  const out = await registry.output({ sessionId: started.sessionId });
  assert.equal(out.running, false);
  assert.equal(out.timedOut, false, 'the deadline was cleared when the group completed');
});

await test('read_process_output omits argv, so arguments never reach the reply', async () => {
  const started = registry.start({ argv: [process.execPath, '-e', "console.log('ok')", 'ARGV-MARKER-VALUE'], cwd: tmp, timeoutMs: 60_000 }, policy);
  const out = await waitForExit(started.sessionId);
  assert.equal('argv' in out, false);
  assert.doesNotMatch(JSON.stringify(out), /ARGV-MARKER-VALUE/u);
});

console.log(`output: ${passed} passed`);
fs.rmSync(tmp, { recursive: true, force: true });
