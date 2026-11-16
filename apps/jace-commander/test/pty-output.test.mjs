import assert from 'node:assert/strict';
import {waitForPtyOutput} from './fixtures/pty-output.mjs';

const echo = "printf 'PTY_%s\\n' OK\r\n";
let cursor = Buffer.byteLength(echo);
let reads = 0;
const chunks = ['PTY_', 'OK\r\n'];
const stdout = await waitForPtyOutput(
  {stdout: echo, nextStdoutOffset: cursor, nextStderrOffset: 0, running: true},
  async ({stdoutOffset, stderrOffset}) => {
    assert.equal(stdoutOffset, cursor, 'the read must resume without repeating echoed bytes');
    assert.equal(stderrOffset, 0);
    const chunk = chunks[reads++];
    cursor += Buffer.byteLength(chunk);
    return {stdout: chunk, nextStdoutOffset: cursor, nextStderrOffset: 0, running: true};
  },
  /PTY_OK/
);
assert.match(stdout, /PTY_OK/, 'the marker must be observed from executed output, not echoed input');
assert.equal(reads, 2, 'must handle a marker split across chunks');

let unexpectedRead = false;
const completed = await waitForPtyOutput(
  {stdout: 'shell exited', nextStdoutOffset: 12, running: false},
  async () => {unexpectedRead = true; throw new Error('should not read a closed session');},
  /MISSING/
);
assert.equal(completed, 'shell exited');
assert.equal(unexpectedRead, false);

console.log('PTY output streaming: echo isolation, split chunks, closed sessions PASS');
