/**
 * Tests for the typed process runner (src/tools/acpx-process.ts).
 *
 * Verifies: exit code preservation, stdout/stderr separation, stdout/stderr
 * truncation reporting, hard timeout termination (including process-group
 * cleanup so no orphaned grandchildren survive), and cooperative
 * AbortSignal-based cancellation.
 */

import assert from 'assert';
import { runTypedProcess } from '../dist/tools/acpx-process.js';

const NODE = process.execPath;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function testExitCodeAndStreamsPreserved() {
  const result = await runTypedProcess({
    executable: NODE,
    argv: ['-e', 'process.stdout.write("out-data"); process.stderr.write("err-data"); process.exit(7);'],
    cwd: process.cwd(),
    timeoutMs: 5000,
    maxStdoutChars: 1000,
    maxStderrChars: 1000,
  });

  assert.strictEqual(result.exitCode, 7, 'exit code must be preserved');
  assert.strictEqual(result.signal, null);
  assert.strictEqual(result.stdout, 'out-data', 'stdout must be captured');
  assert.strictEqual(result.stderr, 'err-data', 'stderr must be kept separate from stdout');
  assert.strictEqual(result.stdoutTruncated, false);
  assert.strictEqual(result.stderrTruncated, false);
  assert.strictEqual(result.timedOut, false);
  assert.strictEqual(result.aborted, false);
  console.log('✓ exit code, stdout/stderr separation preserved');
}

async function testStdoutTruncation() {
  const result = await runTypedProcess({
    executable: NODE,
    argv: ['-e', 'process.stdout.write("x".repeat(1000));'],
    cwd: process.cwd(),
    timeoutMs: 5000,
    maxStdoutChars: 100,
    maxStderrChars: 1000,
  });

  assert.strictEqual(result.stdout.length, 100, 'stdout must be capped at maxStdoutChars');
  assert.strictEqual(result.stdoutTruncated, true, 'truncation must be reported explicitly');
  console.log('✓ stdout truncation reported deterministically');
}

async function testStderrTruncation() {
  const result = await runTypedProcess({
    executable: NODE,
    argv: ['-e', 'process.stderr.write("y".repeat(1000));'],
    cwd: process.cwd(),
    timeoutMs: 5000,
    maxStdoutChars: 1000,
    maxStderrChars: 50,
  });

  assert.strictEqual(result.stderr.length, 50, 'stderr must be capped at maxStderrChars');
  assert.strictEqual(result.stderrTruncated, true);
  assert.strictEqual(result.stdoutTruncated, false);
  console.log('✓ stderr truncation reported independently of stdout');
}

async function testTimeoutTerminatesWrapperAndGrandchild() {
  // The root exits on SIGTERM while its grandchild deliberately ignores it.
  // The SIGKILL escalation must therefore survive the root's close event and
  // terminate the remaining process group rather than being cleared early.
  const script = `
    const { spawn } = require('child_process');
    const gc = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
    process.stdout.write(String(gc.pid));
    process.on('SIGTERM', () => process.exit(2));
    setInterval(() => {}, 1000);
  `;

  const result = await runTypedProcess({
    executable: NODE,
    argv: ['-e', script],
    cwd: process.cwd(),
    timeoutMs: 500,
    maxStdoutChars: 1000,
    maxStderrChars: 1000,
  });

  assert.strictEqual(result.timedOut, true, 'timeout must be reported explicitly');
  assert.notStrictEqual(result.exitCode === 0, true, 'timed-out process must not report a clean exit');

  const grandchildPid = parseInt(result.stdout.trim(), 10);
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, 'expected a grandchild pid in stdout');

  // Give the SIGKILL escalation a moment to land, then confirm no orphan survives.
  await new Promise((r) => setTimeout(r, 3000));
  assert.strictEqual(isAlive(grandchildPid), false, 'grandchild must not be orphaned after timeout kill');
  console.log('✓ timeout terminates the wrapper process and its process group (no orphans)');
}

async function testAbortSignalCancelsProcess() {
  const controller = new AbortController();
  const resultPromise = runTypedProcess({
    executable: NODE,
    argv: ['-e', 'setInterval(() => {}, 1000);'],
    cwd: process.cwd(),
    timeoutMs: 30000,
    maxStdoutChars: 1000,
    maxStderrChars: 1000,
    signal: controller.signal,
  });

  setTimeout(() => controller.abort(), 300);
  const result = await resultPromise;

  assert.strictEqual(result.aborted, true, 'abort must be reported explicitly');
  assert.strictEqual(result.timedOut, false, 'abort must be distinguishable from timeout');
  console.log('✓ AbortSignal cooperatively cancels the process');
}

async function testNoShellInterpretation() {
  // A single argv element containing shell metacharacters must be delivered
  // to the child verbatim — never re-parsed by a shell.
  const dangerousArg = '$(touch /tmp/should-not-exist-acpx-test); rm -rf /tmp/nope; echo hi';
  const result = await runTypedProcess({
    executable: NODE,
    argv: ['-e', 'process.stdout.write(process.argv[1])', dangerousArg],
    cwd: process.cwd(),
    timeoutMs: 5000,
    maxStdoutChars: 1000,
    maxStderrChars: 1000,
  });

  assert.strictEqual(result.stdout, dangerousArg, 'argv element must reach the child unchanged, not shell-expanded');
  console.log('✓ shell metacharacters remain inert in a single argv element');
}

async function runAllTests() {
  const tests = [
    testExitCodeAndStreamsPreserved,
    testStdoutTruncation,
    testStderrTruncation,
    testNoShellInterpretation,
    testAbortSignalCancelsProcess,
    testTimeoutTerminatesWrapperAndGrandchild,
  ];

  let passed = 0;
  let failed = 0;
  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (error) {
      failed++;
      console.error(`❌ ${test.name} FAILED:`, error.message);
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests().catch((error) => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
  });
}

export default runAllTests;
