import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AcpxExecArgsSchema, AcpxListSessionsArgsSchema, AcpxPromptArgsSchema } from '../dist/tools/schemas.js';
import {
  ACPX_AGENT_ALLOWLIST,
  acpxExec,
  acpxListSessions,
  acpxGetSession,
  acpxPrompt,
  acpxCancel,
  __resetAcpxSessionRegistryForTests,
} from '../dist/tools/acpx.js';

const repo = process.cwd();
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-commander-acpx-test-'));
const fake = path.join(tmp, 'fake-acpx.cjs');
const log = path.join(tmp, 'argv.jsonl');
await fs.writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_ACPX_LOG, JSON.stringify(argv) + '\\n');
if (argv.includes('sessions') && argv.includes('list')) {
  process.stdout.write(JSON.stringify([{acpSessionId:'named-session', createdAt:'2026-01-01T00:00:00Z', lastUsedAt:'2026-01-02T00:00:00Z', closed:false}]));
} else if (argv.includes('sessions') && argv.includes('history')) {
  process.stdout.write(JSON.stringify([{role:'user', text:'history'}]));
} else if (argv.includes('sessions') && argv.includes('show')) {
  process.stdout.write(JSON.stringify({name:'named-session', status:'idle'}));
} else if (argv.includes('cancel')) {
  process.stdout.write(JSON.stringify({cancelled:true}));
} else {
  process.stdout.write(JSON.stringify({result:{sessionId:'named-session'}}) + '\\n');
}
`, { mode: 0o755 });
process.env.DESKTOP_COMMANDER_ACPX_BIN_FOR_TESTS = fake;
process.env.FAKE_ACPX_LOG = log;

function text(result) { return result.content?.[0]?.text ?? ''; }
function assertError(result, needle) {
  assert.equal(result.isError, true);
  assert.match(text(result), new RegExp(needle));
}
async function calls() {
  return (await fs.readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
}

try {
  // Schema boundary: required, bounded, and typed inputs.
  assert.throws(() => AcpxExecArgsSchema.parse({cwd: repo, agent: 'claude', prompt: ''}));
  assert.throws(() => AcpxExecArgsSchema.parse({cwd: repo, agent: 'claude', prompt: 'x', timeout_ms: 999}));
  assert.throws(() => AcpxExecArgsSchema.parse({cwd: repo, agent: 'claude', prompt: 'x', timeout_ms: 1000, max_output_chars: 2000001}));
  assert.throws(() => AcpxListSessionsArgsSchema.parse({cwd: repo, agent: 'claude', max_results: 0}));
  assert.throws(() => AcpxPromptArgsSchema.parse({session_id: 'x', prompt: 'x', timeout_ms: 900001}));

  // Agent values are application-controlled, not arbitrary ACPX commands.
  assert.ok(ACPX_AGENT_ALLOWLIST.includes('claude'));
  assert.equal(ACPX_AGENT_ALLOWLIST.includes('--approve-all'), false);
  assertError(await acpxExec({cwd: repo, agent: 'not-an-agent', prompt: 'x', timeout_ms: 1000, max_output_chars: 1000}), 'not in the allowed');

  // Path policy: nonexistent, traversal, and symlink escape fail closed.
  assertError(await acpxExec({cwd: path.join(repo, 'does-not-exist'), agent: 'claude', prompt: 'x', timeout_ms: 1000, max_output_chars: 1000}), 'Invalid cwd');
  assertError(await acpxExec({cwd: path.join(repo, '..', '..', '..', '..', 'does-not-exist'), agent: 'claude', prompt: 'x', timeout_ms: 1000, max_output_chars: 1000}), 'Invalid cwd');
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'acpx-outside-'));
  const link = path.join(repo, '.acpx-test-escape-link');
  await fs.symlink(outside, link);
  try {
    const symlinkResult = await acpxExec({cwd: link, agent: 'claude', prompt: 'x', timeout_ms: 1000, max_output_chars: 1000});
    if (symlinkResult.isError) {
      assert.match(text(symlinkResult), /Invalid cwd/);
    } else {
      assert.equal(JSON.parse(text(symlinkResult)).cwd, outside, 'canonical cwd must be used when the configured policy permits the target');
    }
  } finally { await fs.unlink(link); await fs.rm(outside, {recursive: true, force: true}); }

  __resetAcpxSessionRegistryForTests();
  const dangerous = '$(touch /tmp/pwned); rm -rf /; && whoami --approve-all --policy dangerous';
  const execResult = await acpxExec({cwd: repo, agent: 'claude', prompt: dangerous, timeout_ms: 1000, max_output_chars: 1000});
  assert.equal(execResult.isError, undefined);
  const execArgv = (await calls()).at(-1);
  assert.equal(execArgv.at(-1), dangerous);
  assert.equal(execArgv.includes('--approve-all'), false);
  assert.equal(execArgv.includes('--policy'), false);
  assert.equal(execArgv.includes('sh'), false);
  assert.equal(execArgv.includes('bash'), false);
  assert.equal(JSON.parse(text(execResult)).exit_code, 0);

  const listed = await acpxListSessions({cwd: repo, agent: 'claude', max_results: 20});
  const listedPayload = JSON.parse(text(listed));
  assert.equal(listedPayload.sessions.length, 1);
  assert.ok(listedPayload.sessions[0].session_id);
  const sid = listedPayload.sessions[0].session_id;
  const listArgv = (await calls()).at(-1);
  assert.ok(listArgv.includes('sessions') && listArgv.includes('list') && listArgv.includes('--local'));
  assert.equal(listArgv.includes('ensure'), false);

  const got = await acpxGetSession({session_id: sid, include_history: true, history_limit: 5});
  assert.equal(JSON.parse(text(got)).session.name, 'named-session');
  const gotArgv = await calls();
  assert.equal(gotArgv.at(-2).at(-1), 'named-session');
  assert.equal(gotArgv.at(-1).at(-1), 'named-session');

  const prompted = await acpxPrompt({session_id: sid, prompt: dangerous, wait: false, timeout_ms: 1000, max_output_chars: 1000});
  assert.equal(JSON.parse(text(prompted)).exit_code, 0);
  const promptArgv = (await calls()).at(-1);
  assert.equal(promptArgv[promptArgv.indexOf('--session') + 1], 'named-session');
  assert.equal(promptArgv.at(-1), dangerous);
  assert.equal(promptArgv.includes('--no-wait'), true);

  const cancelled = await acpxCancel({session_id: sid});
  assert.equal(JSON.parse(text(cancelled)).status, 'accepted');
  const cancelArgv = (await calls()).at(-1);
  assert.equal(cancelArgv[cancelArgv.indexOf('--session') + 1], 'named-session');

  assertError(await acpxGetSession({session_id: 'unknown', include_history: false, history_limit: 1}), 'Unknown session_id');
  assertError(await acpxPrompt({session_id: 'unknown', prompt: 'x', wait: true, timeout_ms: 1000, max_output_chars: 1000}), 'Unknown session_id');
  assertError(await acpxCancel({session_id: 'unknown'}), 'Unknown session_id');

  console.log('ACPX tool security tests passed');
} finally {
  delete process.env.DESKTOP_COMMANDER_ACPX_BIN_FOR_TESTS;
  delete process.env.FAKE_ACPX_LOG;
  await fs.rm(tmp, { recursive: true, force: true });
}
