#!/usr/bin/env node
/**
 * Optional, read-only Herdr CLI bridge for JC's existing ACS-gated run_command.
 * Must be started inside a real Herdr pane. No session writes are exposed.
 * The Unix socket is limited to the local account; its content is potentially sensitive.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const OPS = new Set(['status','sessions','snapshot','workspaces','panes','agents','pane_read','agent_read']);
const IDS = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,63}$/;
const MAX_REQUEST = 4096;
const MAX_RESULT = 32 * 1024; // Keep the JSON-escaped response within JC's 256 KiB process-output cap.
const MAX_RESPONSE = 256 * 1024;
const SOCKET = path.join(os.homedir(), 'projects', '.jc-herdr-bridge', 'herdr.sock');

export function isInHerdr(env = process.env) {
  return env.HERDR_ENV === '1' &&
    typeof env.HERDR_WORKSPACE_ID === 'string' && IDS.test(env.HERDR_WORKSPACE_ID) &&
    typeof env.HERDR_PANE_ID === 'string' && IDS.test(env.HERDR_PANE_ID);
}

export function parseRequest(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_REQUEST) throw new Error('invalid request length');
  let r;
  try { r = JSON.parse(raw); } catch { throw new Error('invalid request JSON'); }
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('invalid request object');
  if (Object.keys(r).some((key) => !['operation','id','lines'].includes(key))) throw new Error('unsupported request field');
  buildHerdrArgv(r);
  return r;
}

export function buildHerdrArgv(r) {
  if (!r || typeof r !== 'object' || !OPS.has(r.operation)) throw new Error('unsupported or write operation denied: read-only bridge');
  if (Object.keys(r).some((key) => !['operation','id','lines'].includes(key))) throw new Error('unsupported request field');
  const isRead = r.operation === 'pane_read' || r.operation === 'agent_read';
  if (!isRead && (r.id !== undefined || r.lines !== undefined)) throw new Error('invalid arguments for operation');
  if (isRead) {
    if (typeof r.id !== 'string' || !IDS.test(r.id)) throw new Error('invalid pane/agent id');
    const lines = r.lines === undefined ? 120 : r.lines;
    if (!Number.isInteger(lines) || lines < 1 || lines > 200) throw new Error('invalid lines (1-200)');
    return [r.operation === 'pane_read' ? 'pane' : 'agent', 'read', r.id, '--source', 'recent-unwrapped', '--lines', String(lines)];
  }
  return {
    status:['status','--json'], sessions:['session','list'], snapshot:['api','snapshot'],
    workspaces:['workspace','list'], panes:['pane','list'], agents:['agent','list']
  }[r.operation];
}

export function parseHerdrOutput(raw) {
  const text = raw.trim();
  try { return {format:'json',data:JSON.parse(text)}; }
  catch { return {format:'text',data:text}; }
}

async function execute(request) {
  const args = buildHerdrArgv(request);
  const {stdout} = await execFileAsync('herdr', args, {
    env:process.env, timeout:6000, maxBuffer:MAX_RESULT, windowsHide:true
  });
  return {ok:true, operation:request.operation, result:parseHerdrOutput(stdout),
    context:{workspace:process.env.HERDR_WORKSPACE_ID, pane:process.env.HERDR_PANE_ID}};
}

function prepareSocket() {
  const dir = path.dirname(SOCKET);
  fs.mkdirSync(dir, {recursive:true,mode:0o700});
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error('bridge directory must be a private, owner-controlled directory');
  }
  try { fs.lstatSync(SOCKET); throw new Error('bridge socket already exists; refusing to replace it'); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
}

async function serve() {
  if (!isInHerdr()) throw new Error('not in an authenticated Herdr pane; refusing live-session access');
  prepareSocket();
  let active = 0;
  const server = net.createServer((client) => {
    if (++active > 8) { active--; client.destroy(); return; }
    client.setTimeout(7500, () => client.destroy());
    let buffer = '';
    const reply = (value) => {
      if (!client.destroyed) client.end(JSON.stringify(value)+'\n');
    };
    client.on('data', async (chunk) => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > MAX_REQUEST) { reply({ok:false,error:'request too large'}); return; }
      const ix = buffer.indexOf('\n');
      if (ix < 0) return;
      client.pause();
      try { reply(await execute(parseRequest(buffer.slice(0,ix)))); }
      catch (err) { reply({ok:false,error:String(err.message || err).slice(0,250)}); }
    });
    client.on('close', () => { active--; });
    client.on('error', () => {});
  });
  server.listen(SOCKET, () => {
    fs.chmodSync(SOCKET, 0o600);
    process.stdout.write('Herdr read-only bridge ready (local Unix socket; no write operations)\n');
  });
  const cleanup = () => {
    try { if (fs.lstatSync(SOCKET).isSocket()) fs.unlinkSync(SOCKET); } catch { /* absent */ }
  };
  server.on('close', cleanup);
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
}

function requestFromArgs(args) {
  if (args.length < 1 || args.length > 3) throw new Error('usage: request OPERATION [ID] [LINES]');
  const [operation,id,rawLines] = args;
  const r = {operation};
  if (id !== undefined) r.id = id;
  if (rawLines !== undefined) r.lines = Number(rawLines);
  return parseRequest(JSON.stringify(r));
}

async function requestViaSocket(r) {
  return await new Promise((resolve,reject) => {
    const client = net.createConnection(SOCKET);
    let response = '';
    const timer = setTimeout(() => client.destroy(new Error('bridge request timeout')), 9000);
    const done = (err, value) => { clearTimeout(timer); err ? reject(err) : resolve(value); };
    client.once('connect', () => client.write(JSON.stringify(r)+'\n'));
    client.on('data', (b) => {
      response += b.toString('utf8');
      if (Buffer.byteLength(response) > MAX_RESPONSE) client.destroy(new Error('bridge response too large'));
      if (response.includes('\n')) {
        try { done(null, JSON.parse(response.slice(0,response.indexOf('\n')))); }
        catch (err) { done(err); }
        client.end();
      }
    });
    client.once('error', (err) => done(err));
    client.once('close', () => { if (!response.includes('\n')) done(new Error('bridge unavailable or incomplete response')); });
  });
}

async function main(argv) {
  const [mode,...rest] = argv;
  if (mode === 'serve') { if (rest.length) throw new Error('serve accepts no arguments'); await serve(); return; }
  if (mode === 'request') {
    const result = await requestViaSocket(requestFromArgs(rest));
    process.stdout.write(JSON.stringify(result)+'\n');
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (mode === 'direct') {
    const r = requestFromArgs(rest);
    if (!['status','sessions'].includes(r.operation)) throw new Error('only status and session inventory may be queried outside the Herdr bridge');
    const argv = buildHerdrArgv(r);
    const {stdout} = await execFileAsync('herdr',argv,{timeout:6000,maxBuffer:MAX_RESULT});
    process.stdout.write(JSON.stringify({ok:true,operation:r.operation,result:parseHerdrOutput(stdout)})+'\n');
    return;
  }
  throw new Error('usage: herdr-bridge.mjs serve | request OP [ID] [LINES] | direct status|sessions');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((err)=>{process.stderr.write(`Herdr bridge: ${String(err.message || err)}\n`);process.exitCode=1;});
}
