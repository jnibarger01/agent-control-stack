#!/usr/bin/env node
/**
 * Disposable lab for checking OAuth reauthentication detection against REAL MCP clients (ChatGPT, Claude, ...).
 *
 * Starts, entirely in a throwaway temp directory with freshly generated secrets:
 *   - an ACS gateway on 127.0.0.1 (the Mission Control the lab is about)
 *   - the Commander edge (apps/dc-mcp-gateway/server.js) with SHORT token lifetimes (EDGE_TEST_MODE) and
 *     ACS_MCP_AUTH_EVENTS=1, serving only the Jace Commander lane /jc/mcp
 *   - a stub MCP upstream (initialize, tools/list, ping) so connectors can validate and stay connected
 * It never touches production data, tokens, keys or services, and refuses to run if pointed at them.
 *
 * Usage:  node scripts/oauth-compat-lab.mjs [--access-ttl 120] [--refresh-ttl 900] [--public-origin https://lab.example] [--dir <existing lab dir>]
 *   --dir restarts an earlier lab (same secrets, tokens and audit log) so you can stop it, edit `edge-data/tokens.json`, and start again.
 *   Without --public-origin the edge is only reachable on loopback (fine for Claude Code / local clients).
 *   ChatGPT needs a public HTTPS origin: start your own tunnel to the printed edge port, then pass its URL here.
 *   Exposing the lab edge publicly is your decision; the consent page is gated by the printed one-time passphrase.
 *
 * Evidence: every edge request line (method, path, status; never tokens) and every Mission Control state change is
 * appended to <labdir>/evidence.jsonl with timestamps.
 */
import { spawn } from 'node:child_process';
import { clearInterval, setInterval } from 'node:timers';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const ACCESS_TTL = Number(arg('access-ttl', '120'));
const REFRESH_TTL = Number(arg('refresh-ttl', '900'));
const EDGE_PORT = Number(arg('edge-port', '18010'));
const ACS_PORT = Number(arg('acs-port', '13000'));
const publicOrigin = arg('public-origin', `http://127.0.0.1:${EDGE_PORT}`).replace(/\/$/, '');

for (const [name, v] of Object.entries({ ACS_DB_PATH: process.env.ACS_DB_PATH, DATA_DIR: process.env.DATA_DIR, ACS_GATEWAY_CREDENTIALS_JSON: process.env.ACS_GATEWAY_CREDENTIALS_JSON, SIGNING_KEY: process.env.SIGNING_KEY })) {
  if (v) { console.error(`refusing to run: ${name} is set in this shell. The lab only uses its own generated, disposable values.`); process.exit(2); }
}
if (!(ACCESS_TTL >= 30 && REFRESH_TTL > ACCESS_TTL)) { console.error('need --access-ttl >= 30 and --refresh-ttl > --access-ttl'); process.exit(2); }

const existing = arg('dir', '');
if (existing && !(path.dirname(path.resolve(existing)) === os.tmpdir() && path.basename(existing).startsWith('acs-oauth-lab-'))) {
  console.error('--dir must be an acs-oauth-lab-* directory created by this script under the system temp dir'); process.exit(2);
}
const lab = existing ? path.resolve(existing) : fs.mkdtempSync(path.join(os.tmpdir(), 'acs-oauth-lab-'));
fs.chmodSync(lab, 0o700);
const secret = () => crypto.randomBytes(24).toString('hex');
const secretsFile = path.join(lab, 'lab.json');
const secrets = existing
  ? JSON.parse(fs.readFileSync(secretsFile, 'utf8'))
  : { bridgeToken: `lab-bridge-${secret()}`, operatorToken: `lab-operator-${secret()}`, consentCode: `lab-${crypto.randomBytes(6).toString('hex')}`, signingKey: crypto.randomBytes(32).toString('hex') };
if (!existing) fs.writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
const { bridgeToken, operatorToken, consentCode, signingKey } = secrets;
const evidence = fs.createWriteStream(path.join(lab, 'evidence.jsonl'), { flags: 'a', mode: 0o600 });
const note = (kind, data) => evidence.write(`${JSON.stringify({ at: new Date().toISOString(), kind, ...data })}\n`);

// Stub upstream: just enough MCP for a connector to validate and stay connected.
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/authority') return res.end(JSON.stringify({ variant: 'jc', authoritative: true }));
    let msg = {};
    try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* ignore */ }
    if (msg.id === undefined) { res.statusCode = 202; return res.end(); }
    const result = msg.method === 'initialize'
      ? { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'acs-oauth-lab', version: '0.0.0' } }
      : msg.method === 'tools/list'
        ? { tools: [{ name: 'lab_ping', description: 'Lab connectivity check', inputSchema: { type: 'object', properties: {} } }] }
        : {};
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

const children = [];
const start = (name, cmd, args, env, onLine) => {
  const child = spawn(cmd, args, { cwd: root, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const pump = (stream) => { let buf = ''; stream.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); onLine?.(line); } }); };
  pump(child.stdout); pump(child.stderr);
  child.on('exit', (code) => console.log(`${name} exited (${code})`));
  children.push(child);
  return child;
};

start('acs', process.execPath, ['apps/gateway/dist/cli.js'], {
  HOST: '127.0.0.1', PORT: String(ACS_PORT), ACS_DB_PATH: path.join(lab, 'control.db'),
  ACS_GATEWAY_CREDENTIALS_JSON: JSON.stringify([
    { id: 'jc-bridge', token: bridgeToken, actor: 'agent', actorId: 'acs-jc-bridge', roles: ['service', 'worker'], scopes: ['acs:read', 'acs:write', 'acs:worker'] },
    { id: 'operator', token: operatorToken, actor: 'user', actorId: 'lab-operator', roles: ['operator'], scopes: ['acs:read', 'acs:write', 'acs:approve'] }
  ])
});
start('edge', process.execPath, ['apps/dc-mcp-gateway/server.js'], {
  GATEWAY_PORT: String(EDGE_PORT), PUBLIC_ORIGIN: publicOrigin, CONSENT_PASSPHRASE: consentCode, SIGNING_KEY: signingKey,
  DATA_DIR: path.join(lab, 'edge-data'), UPSTREAM: upstreamUrl, JC_ENABLED: '1', JC_UPSTREAM: upstreamUrl,
  ACS_GATEWAY_URL: `http://127.0.0.1:${ACS_PORT}`, ACS_JC_GATEWAY_TOKEN: bridgeToken,
  EDGE_TEST_MODE: '1', EDGE_TEST_ACCESS_TTL_S: String(ACCESS_TTL), EDGE_TEST_REFRESH_TTL_S: String(REFRESH_TTL), ACS_MCP_AUTH_EVENTS: '1'
}, (line) => { if (line.trim()) note('edge', { line: line.slice(0, 300) }); });

// Record every Mission Control state change for the evidence file.
const last = new Map();
const poll = setInterval(async () => {
  try {
    const view = await (await fetch(`http://127.0.0.1:${ACS_PORT}/api/mcp-clients`, { headers: { authorization: `Bearer ${operatorToken}` } })).json();
    for (const c of view.clients ?? []) {
      const sig = JSON.stringify({ s: c.auth?.state, r: c.auth?.failureReason, ok: c.auth?.lastSuccessAt });
      if (last.get(c.clientId) !== sig) { last.set(c.clientId, sig); note('mission_control', { clientId: c.clientId, kinds: c.suggestedKind, name: c.claims?.[0]?.name, auth: c.auth, live: c.live }); }
    }
  } catch { /* gateway still starting */ }
}, 2000);

const stop = () => { clearInterval(poll); for (const c of children) c.kill('SIGTERM'); upstream.close(); evidence.end(); setTimeout(() => process.exit(0), 300); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);

console.log(`
OAuth reauthentication lab (DISPOSABLE - delete ${lab} when done)
  MCP URL for the connector : ${publicOrigin}/jc/mcp
  Consent passphrase        : ${consentCode}
  Token lifetimes           : access ${ACCESS_TTL}s, refresh ${REFRESH_TTL}s
  Mission Control           : http://127.0.0.1:${ACS_PORT}/   (sign in with token: ${operatorToken})
  Evidence file             : ${path.join(lab, 'evidence.jsonl')}
  Edge on loopback port     : ${EDGE_PORT}  (tunnel this yourself if the client needs a public HTTPS URL)
Ctrl-C stops everything.`);
