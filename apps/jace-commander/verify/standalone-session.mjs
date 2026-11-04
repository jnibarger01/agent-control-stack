#!/usr/bin/env node
/**
 * Standalone runtime verification for an INSTALLED Jace Commander release.
 *
 *   node verify/standalone-session.mjs <evidence.json>
 *
 * Run from the release directory after `npm install --omit=dev`. A real MCP
 * client (the SDK Client over stdio) drives the real `jace-commander serve`
 * process in managed mode: every call carries a per-call acs.jc.v1 capability
 * from a TEST issuer (the key exists only in this process), and the live
 * authority check reads a local stand-in ACS endpoint that requires a bearer
 * credential. Exercises terminal (plain and PTY), interactive sessions,
 * binary/text files, documents, processes, git and diagnostics, plus a denial.
 * Every module the server resolves is recorded and must lie inside the release.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { authorityBody, makeIssuer } from '../test/fixtures/jc-mint.js';

const release = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidencePath = path.resolve(process.argv[2] ?? path.join(release, 'verify-evidence.json'));
const work = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'jc-standalone-work-'));
const stateDir = path.join(work, '.state');
const resolveLog = path.join(work, 'resolved.txt');
const AUTHORITY_TOKEN = `verify-${process.pid}`;
const issuer = makeIssuer();
const checks = [];
const check = async (name, fn) => {
  await fn();
  checks.push(name);
  console.log(`  ✓ ${name}`);
};

// Stand-in for ACS's GET /work-items/:id (authority) and /readyz (doctor).
const acs = http.createServer((req, res) => {
  if (req.url === '/readyz') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"ready":true}');
  if (req.headers.authorization !== `Bearer ${AUTHORITY_TOKEN}`) return res.writeHead(401).end('{}');
  if (req.url?.startsWith('/work-items/')) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(authorityBody(issuer)));
  return res.writeHead(404).end('{}');
});
await new Promise((resolve) => acs.listen(0, '127.0.0.1', resolve));
const acsUrl = `http://127.0.0.1:${acs.address().port}`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', path.join(release, 'verify', 'resolve-hook.mjs'), path.join(release, 'dist', 'cli.js'), 'serve'],
  cwd: release,
  stderr: 'pipe',
  env: {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: os.homedir(),
    LANG: 'C.UTF-8',
    ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
    JC_PRESET: 'managed',
    JC_RUNTIME_ID: 'jc-test-runtime',
    JC_ACS_PUBLIC_KEY: issuer.publicKeyB64,
    JC_ACS_KEY_ID: issuer.keyId,
    JC_ACS_URL: acsUrl,
    JC_ACS_AUTHORITY_TOKEN: AUTHORITY_TOKEN,
    JC_STATE_DIR: stateDir,
    JC_FS_ROOTS: work,
    JC_TRACE_ROOTS: path.join(stateDir, 'traces'),
    JC_VERIFY_RESOLVE_LOG: resolveLog,
  },
});
let stderr = '';
transport.stderr?.on('data', (chunk) => { stderr += chunk; });
const client = new Client({ name: 'jc-release-verifier', version: '1.0.0' });
const sdkVersion = JSON.parse(fs.readFileSync(path.join(release, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), 'utf8')).version;
const call = (name, args) => client.callTool({ name, arguments: args, _meta: { acsCapability: issuer.mint(name, args) } });
const ok = (result) => {
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent ?? result.content));
  return result.structuredContent;
};

let evidence;
try {
  await client.connect(transport);
  const server = client.getServerVersion();

  await check('MCP initialize + tools/list over stdio (40 tools)', async () => {
    assert.equal(server?.name, 'jace-commander');
    const { tools } = await client.listTools();
    assert.equal(tools.length, 40);
    for (const name of ['run_command', 'start_terminal_session', 'interact_with_process', 'delete_file', 'read_file', 'git_status']) {
      assert.ok(tools.some((tool) => tool.name === name), name);
    }
  });

  await check('a call without an ACS capability is refused and nothing runs', async () => {
    const refused = await client.callTool({ name: 'run_command', arguments: { command: `touch ${work}/nope`, cwd: work } });
    assert.equal(refused.isError, true);
    assert.equal(refused.structuredContent.error.code, 'JC_CAPABILITY_MISSING');
    assert.equal(fs.existsSync(path.join(work, 'nope')), false);
  });

  await check('terminal: run_command (bash) with stdout, stderr and exit code', async () => {
    const out = ok(await call('run_command', { command: 'printf out; printf err >&2; exit 3', cwd: work, waitMs: 10000 }));
    assert.deepEqual([out.stdout, out.stderr, out.exitCode], ['out', 'err', 3]);
  });

  await check('terminal: run_command in a PTY', async () => {
    const out = ok(await call('run_command', { command: 'test -t 1 && echo ON_TTY', cwd: work, pty: true, waitMs: 10000 }));
    assert.match(out.stdout, /ON_TTY/);
  });

  await check('terminal: interactive PTY session with streamed input', async () => {
    const session = ok(await call('start_terminal_session', { cwd: work, timeoutMs: 20000 }));
    const reply = ok(await call('interact_with_process', { sessionId: session.sessionId, input: 'echo PTY_$((40+2))\n', waitMs: 5000 }));
    assert.match(reply.stdout, /PTY_42/);
    ok(await call('kill_process', { sessionId: session.sessionId }));
  });

  await check('files: write (utf8 + base64 binary), read, info, list, move, delete', async () => {
    const text = path.join(work, 'note.txt');
    ok(await call('write_file', { path: text, content: 'hello native\n' }));
    assert.match(ok(await call('read_file', { path: text })).content, /hello native/);
    const binary = Buffer.from([0, 1, 2, 250, 251, 252, 0, 10]);
    const bin = path.join(work, 'blob.bin');
    ok(await call('write_file', { path: bin, content: binary.toString('base64'), encoding: 'base64' }));
    assert.deepEqual(fs.readFileSync(bin), binary);
    assert.equal(ok(await call('get_file_info', { path: bin })).size, binary.length);
    assert.ok(ok(await call('list_directory', { path: work })).entries.some((entry) => entry.name === 'blob.bin'));
    ok(await call('move_file', { from: text, to: path.join(work, 'moved.txt') }));
    ok(await call('delete_file', { path: path.join(work, 'moved.txt') }));
    assert.equal(fs.existsSync(path.join(work, 'moved.txt')), false);
    const outside = await call('read_file', { path: '/etc/hostname' });
    assert.equal(outside.isError, true);
  });

  await check('documents: pdf, docx and xlsx parse through the native readers', async () => {
    fs.copyFileSync(path.join(release, 'test', 'samples', '01_sample_simple.pdf'), path.join(work, 'sample.pdf'));
    const pdf = ok(await call('read_file', { path: path.join(work, 'sample.pdf') }));
    assert.equal(pdf.mimeType, 'application/pdf');
    assert.ok(pdf.content.trim().length > 0);
    const { default: PizZip } = await import('pizzip');
    const docx = new PizZip();
    docx.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>docx ok</w:t></w:r></w:p></w:body></w:document>');
    fs.writeFileSync(path.join(work, 'a.docx'), docx.generate({ type: 'nodebuffer' }));
    assert.match(ok(await call('read_file', { path: path.join(work, 'a.docx') })).content, /docx ok/);
    const xlsx = new PizZip();
    xlsx.file('xl/workbook.xml', '<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>');
    xlsx.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
    xlsx.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>xlsx ok</t></is></c></row></sheetData></worksheet>');
    fs.writeFileSync(path.join(work, 'a.xlsx'), xlsx.generate({ type: 'nodebuffer' }));
    assert.match(ok(await call('read_file', { path: path.join(work, 'a.xlsx') })).content, /xlsx ok/);
  });

  await check('processes: start_process, read_process_output, list_processes, kill_process', async () => {
    const started = ok(await call('start_process', { argv: ['/bin/sleep', '30'], cwd: work, timeoutMs: 60000 }));
    assert.ok(ok(await call('list_processes', {})).processes.some((entry) => entry.sessionId === started.sessionId && entry.running));
    ok(await call('kill_process', { sessionId: started.sessionId }));
    const echo = ok(await call('start_process', { argv: ['/bin/echo', 'proc-ok'], cwd: work, timeoutMs: 5000 }));
    const output = ok(await call('read_process_output', { sessionId: echo.sessionId, waitMs: 3000 }));
    assert.match(output.stdout, /proc-ok/);
  });

  await check('git: status on a real repository (sandboxed git)', async () => {
    const repo = path.join(work, 'repo');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    fs.writeFileSync(path.join(repo, 'x.txt'), 'x');
    const status = ok(await call('git_status', { repo }));
    assert.deepEqual(status.untracked, ['x.txt']);
  });

  await check('jc_doctor: runtime path, capability verification and workload isolation healthy', async () => {
    const report = ok(await call('jc_doctor', {}));
    const byName = Object.fromEntries(report.checks.map((entry) => [entry.name, entry]));
    for (const name of ['manifest', 'capability verification', 'runtime path', 'workload isolation']) {
      assert.equal(byName[name]?.ok, true, `${name}: ${byName[name]?.detail}`);
    }
  });

  await client.close();
  const resolved = [...new Set(fs.readFileSync(resolveLog, 'utf8').split('\n').filter(Boolean))];
  const files = resolved.filter((url) => url.startsWith('file:')).map((url) => fileURLToPath(url));
  const outside = files.filter((file) => !file.startsWith(release + path.sep));
  const builtins = resolved.filter((url) => url.startsWith('node:'));
  await check('module resolution: every loaded file is inside the release (no repo, workspace or vendor)', async () => {
    assert.deepEqual(outside, [], `resolved outside the release:\n${outside.join('\n')}`);
    assert.ok(files.some((file) => file.includes(`${path.sep}node_modules${path.sep}unpdf${path.sep}`)), 'lazy pdf reader resolved');
    assert.ok(!files.some((file) => /desktop-commander|agent-control-stack/.test(file)));
  });
  evidence = {
    verdict: 'PASS',
    release,
    node: process.version,
    mcpSdkVersion: sdkVersion,
    server,
    checks,
    resolvedFiles: files.length,
    resolvedPackages: [...new Set(files.map((file) => /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(file)?.[1]).filter(Boolean))].sort(),
    builtins: builtins.length,
    outsideRelease: outside,
  };
} catch (error) {
  evidence = { verdict: 'FAIL', error: String(error?.stack ?? error), checks, serverStderr: stderr.slice(-4000) };
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
  acs.close();
  fs.rmSync(work, { recursive: true, force: true });
}
fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`\nstandalone session: ${evidence.verdict} (${checks.length} checks) -> ${evidencePath}`);
