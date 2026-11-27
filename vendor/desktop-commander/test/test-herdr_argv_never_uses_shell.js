import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHerdrHandlers } from '../dist/jace-commander/herdr.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'jc-herdr-test-'));
const bin = path.join(tmp, 'bin');
await fs.mkdir(bin);
const script = path.join(bin, 'hc');
async function fake(body, exit = 0, delay = 0, useStderr = false) {
  const stream = useStderr ? 'process.stderr' : 'process.stdout';
  const bodyJson = body;
  await fs.writeFile(script, `#!${process.execPath}\nconst fs=require('fs'); const out=process.argv[2]==='--version'?'hc 1.2.3':${JSON.stringify(bodyJson)}; fs.writeFileSync(${JSON.stringify(path.join(tmp,'argv.json'))}, JSON.stringify(process.argv.slice(2))); fs.writeFileSync(${JSON.stringify(path.join(tmp,'env.json'))}, JSON.stringify({keys:Object.keys(process.env).sort(),hasSecret:Boolean(process.env.HC_SECRET_TOKEN)})); fs.writeFileSync(${JSON.stringify(path.join(tmp,'pid.json'))}, String(process.pid)); setTimeout(()=>{${stream}.end(out,()=>process.exit(${exit}));},${delay});\n`);
  await fs.chmod(script, 0o700);
}
const handlers = createHerdrHandlers({ env: { PATH: bin, HOME: tmp, XDG_CONFIG_HOME: tmp, HC_TEST_OK: 'yes', HC_SECRET_TOKEN: 'never-return-this' }, timeoutMs: 15000 });
try {
  await fake('{"terminals":[{"id":"t1"}]}');
  const happy = await handlers.terminals({});
  assert.equal(happy.ok, true);
  assert.deepEqual(happy.result, { terminals: [{ id: 't1' }] });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(tmp,'argv.json'),'utf8')), ['ls','--json']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(tmp,'env.json'),'utf8')), {
    keys: ['HC_TEST_OK', 'HOME', 'PATH', 'XDG_CONFIG_HOME'], hasSecret: false
  });
  const all = await handlers.terminals({ all: true });
  assert.equal(all.ok, true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(tmp,'argv.json'),'utf8')), ['ls','--all','--json']);

  const missing = await createHerdrHandlers({ env: { PATH: '' } }).terminals({});
  assert.equal(missing.ok, false);
  assert.equal(missing.error.kind, 'hc_missing');

  await fake('{"error":{"kind":"not_found","message":"terminal not found","hint":""}}', 3, 0, true);
  const mapped = await handlers.read({ terminal: 't1' });
  assert.equal(mapped.ok, false);
  assert.equal(mapped.error.kind, 'not_found');

  await fake('{"error":{"kind":"needs_target","message":"choose a terminal"}}', 7, 0, true);
  const needsTarget = await handlers.read({ terminal: 't1' });
  assert.equal(needsTarget.ok, false);
  assert.equal(needsTarget.error.kind, 'needs_target');

  await fake('{"error":{"kind":"core_unreachable","message":"core unavailable"}}', 1, 0, true);
  const unreachable = await handlers.terminals({});
  assert.equal(unreachable.ok, false);
  assert.equal(unreachable.error.kind, 'core_unreachable');

  await fake('{"screen":"sample"}');
  const read = await handlers.read({ terminal: 'machine/t1', lines: 0 });
  assert.equal(read.ok, true);
  assert.deepEqual(read.result, { screen: 'sample' });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(tmp,'argv.json'),'utf8')), ['read','machine/t1','--lines','0','--json']);
  const delivered = { terminal: 't1' };
  const defaulted = await handlers.read(delivered);
  assert.equal(defaulted.ok, true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(tmp,'argv.json'),'utf8')), ['read','t1','--lines','100','--json']);
  assert.deepEqual(delivered, { terminal: 't1' }, 'the handler must not mutate signed arguments');
  const bounded = await handlers.read({ terminal: 't1', lines: 2000 });
  assert.equal(bounded.ok, true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(tmp,'argv.json'),'utf8')), ['read','t1','--lines','2000','--json']);

  await fake('not-json-output');
  const malformedList = await handlers.terminals({});
  assert.equal(malformedList.ok, false);
  assert.equal(malformedList.error.kind, 'invalid_output');
  const textRead = await handlers.read({ terminal: 't1' });
  assert.equal(textRead.ok, true, 'read treats stdout as untrusted text when JSON parsing fails');
  assert.equal(textRead.result, 'not-json-output');

  await fake('', 0, 1000);
  const timed = await createHerdrHandlers({ env: { PATH: bin }, timeoutMs: 40 }).terminals({});
  assert.equal(timed.ok, false);
  assert.equal(timed.error.kind, 'timeout');
  const timedPid = Number(await fs.readFile(path.join(tmp,'pid.json'),'utf8'));
  assert.throws(() => process.kill(timedPid, 0), { code: 'ESRCH' });

  await fake('x'.repeat(300 * 1024));
  const large = await handlers.terminals({});
  assert.equal(large.ok, true);
  assert.equal(large.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(large.result)) <= 256 * 1024 + 100);

  let spawned = false;
  const injected = createHerdrHandlers({ env: { PATH: bin }, onSpawn: () => { spawned = true; } });
  const rejected = await injected.read({ terminal: 't1; rm -rf /' });
  assert.equal(rejected.ok, false);
  assert.equal(spawned, false);
  assert.equal(rejected.error.kind, 'invalid_argument');

  await fake('{"terminals":[]}');
  const status = await handlers.status({});
  assert.equal(status.ok, true);
  assert.equal(status.reachable, true);
  assert.equal(status.version, 'hc 1.2.3');
  assert.equal(status.terminalCount, 0);
  console.log('herdr_argv_never_uses_shell: 11 checks passed');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
