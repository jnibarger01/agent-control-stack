/**
 * Regression test for terminal-manager.ts output buffering (P2.2 —
 * bounded resource consumption for process output).
 *
 * Covers two invariants:
 *  1. Memory stays bounded: a process emitting far more than
 *     MAX_BUFFERED_OUTPUT_CHARS of output gets the oldest lines evicted,
 *     with evictedLines/evictedChars tracked so a reader can tell data
 *     was dropped rather than silently losing it.
 *  2. Eviction is fast: trimming back to the cap must not degrade into
 *     O(evicted-lines x buffer-length) — a subprocess emitting many small
 *     lines fast previously could block the whole (single-threaded) event
 *     loop for many seconds even though memory stayed bounded, because the
 *     old eviction loop called Array.prototype.shift() once per evicted
 *     line. This asserts the whole run completes quickly.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

import { terminalManager, MAX_BUFFERED_OUTPUT_CHARS } from '../dist/terminal-manager.js';

async function waitForCompletedSession(pid, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const completed = terminalManager.listCompletedSessions().find((s) => s.pid === pid);
    if (completed) return completed;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for session ${pid} to complete`);
}

async function testManyLinesEvictedBoundedAndFast() {
  console.log('\n--- Test: many small lines exceeding the cap are evicted, bounded, and fast ---');

  // 100 writes x 6000 lines x 100 bytes/line = 60,000,000 bytes (60MB) of
  // output, well over the 50MB cap, as 600,000 individually small lines —
  // exactly the shape that made the old shift()-per-line eviction slow.
  // Written to a temp script file (rather than inlined via `node -e`) so the
  // script text never has to survive being re-quoted through the configured
  // shell (bash -c "...") — JSON.stringify-style quoting is not shell
  // quoting and mangles embedded newlines/backslashes when nested that way.
  const scriptFile = path.join(os.tmpdir(), `dc-backpressure-test-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.cjs`);
  const script = `
    const line = 'x'.repeat(99) + '\\n';
    const chunk = line.repeat(6000);
    for (let i = 0; i < 100; i++) process.stdout.write(chunk);
  `;
  fs.writeFileSync(scriptFile, script);

  let result;
  let completed;
  let elapsedMs;
  try {
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptFile)}`;

    const start = Date.now();
    result = await terminalManager.executeCommand(command, 20000);
    assert.ok(result.pid > 0, 'expected a real pid from executeCommand');

    completed = await waitForCompletedSession(result.pid, 30000);
    elapsedMs = Date.now() - start;
    assert.strictEqual(completed.exitCode, 0, 'the output-generating script must exit cleanly');
  } finally {
    fs.rmSync(scriptFile, { force: true });
  }

  // Correctness: eviction must have actually happened, and the counters must
  // reflect it (a reader can tell data was dropped, not silently lose it).
  assert.ok(completed.evictedLines > 0, 'expected some lines to be evicted for 60MB of output over a 50MB cap');
  assert.ok(completed.evictedChars > 0, 'expected evictedChars to be tracked alongside evictedLines');
  assert.ok(
    completed.evictedChars >= 60_000_000 - MAX_BUFFERED_OUTPUT_CHARS - 10_000,
    `expected evictedChars (${completed.evictedChars}) to roughly account for the ~10MB over the cap`
  );

  // Memory bound: what's retained must stay close to the cap, not grow with
  // total output produced.
  const retainedChars = completed.outputLines.join('\n').length;
  assert.ok(
    retainedChars <= MAX_BUFFERED_OUTPUT_CHARS + 10_000,
    `retained buffer (${retainedChars} chars) must stay near the ${MAX_BUFFERED_OUTPUT_CHARS} cap, not grow with total output`
  );

  // Performance: this must not degrade into the old O(evicted x length)
  // shift()-per-line behavior (independently measured at ~18s for a
  // comparable shift count/array size). A generous bound well below that
  // catches a regression back to the quadratic path without being flaky
  // about exact timing.
  assert.ok(
    elapsedMs < 10_000,
    `eviction of many small lines took ${elapsedMs}ms — expected well under 10s; a return to O(evicted x length) shift()-based eviction would show up here as ~18s+`
  );

  console.log(`ok: evicted ${completed.evictedLines} lines / ${completed.evictedChars} chars, bounded to ${retainedChars} retained chars, in ${elapsedMs}ms`);
}

export default async function runTests() {
  try {
    await testManyLinesEvictedBoundedAndFast();
    console.log('\nOutput backpressure tests passed.');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Output backpressure test failed:', message);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests()
    .then((success) => {
      process.exit(success ? 0 : 1);
    })
    .catch((error) => {
      console.error('Unhandled error:', error);
      process.exit(1);
    });
}
