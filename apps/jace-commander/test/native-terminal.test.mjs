import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProcessRegistry } from '../dist/processes.js';
import { sandboxPolicyFromEnv } from '../dist/sandbox.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-native-'));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-native-state-'));
// Workloads always run sandboxed; the registry refuses a policy without one.
const policy = { roots: [root], deniedRoots: [], workload: {
  policy: sandboxPolicyFromEnv({ homeDir: os.homedir(), stateDir, fsRoots: [root], fsDeniedRoots: [], managed: true }, {}),
  homeDir: os.homedir(), stateDir } };
const registry = createProcessRegistry();
try {
  process.env.JC_SECRET_CANARY = 'must-not-leak';
  const result = await registry.run({ command: 'printf hello; printf err >&2; exit 7', cwd: root, waitMs: 2000 }, policy, 'alice');
  assert.equal(result.stdout, 'hello');
  assert.equal(result.stderr, 'err');
  assert.equal(result.exitCode, 7);
  await assert.rejects(registry.run({command:'pwd', cwd:'/etc'}, policy, 'alice'), /root|allowed/i);
  await assert.rejects(registry.run({command:'pwd', cwd:root, env:{NODE_OPTIONS:'--inspect'}}, policy, 'alice'), /environment/i);
  const env = await registry.run({command:'printf "%s" "$JC_SECRET_CANARY"',cwd:root,waitMs:2000},policy,'alice');
  assert.equal(env.stdout, '');
  const interactive = await registry.terminal({cwd:root,timeoutMs:3000},policy,'alice');
  const out = await registry.interact({sessionId:interactive.sessionId,input:'test -t 0 && printf PTY_OK\n',waitMs:300},'alice');
  assert.match(out.stdout, /PTY_OK/);
  assert.throws(() => registry.output({sessionId:interactive.sessionId},'bob'), /session/i);
  assert.throws(() => registry.kill({sessionId:interactive.sessionId},'bob'), /process|session/i);
  assert.equal(registry.list('bob').processes.length, 0);
  await assert.rejects(registry.interact({sessionId:interactive.sessionId,input:'echo hijack\n'},'bob'),/session/i);
  registry.kill({sessionId:interactive.sessionId},'alice');
  const timed = await registry.run({command:'sleep 5',cwd:root,timeoutMs:60,waitMs:1500},policy,'alice');
  assert.equal(timed.running, false);
  const stream = await registry.run({command:'printf one; sleep .1; printf two',cwd:root,waitMs:30},policy,'alice');
  const next = await registry.read({sessionId:stream.sessionId,stdoutOffset:stream.nextStdoutOffset,stderrOffset:0,waitMs:1000},'alice');
  assert.equal(stream.stdout + next.stdout, 'onetwo');
  console.log('native terminal: shell, stderr, exit, boundaries, environment, PTY, ownership, timeout, streaming PASS');
} finally { registry.close(); fs.rmSync(root,{recursive:true,force:true}); fs.rmSync(stateDir,{recursive:true,force:true}); }
