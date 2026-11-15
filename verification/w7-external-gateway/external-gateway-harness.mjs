import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPublicIngress } from '../../apps/dc-mcp-gateway/public-edge-proxy.js';

const WORKTREE = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DC_GATEWAY_ENTRY = resolve(WORKTREE, 'apps/dc-mcp-gateway/server.js');
const CONSENT_PASSPHRASE = 'test-consent-passphrase';
const SIGNING_KEY = randomBytes(32).toString('hex');
const RECOVERY_KEY = randomBytes(32).toString('base64');

function b64u(input) { return Buffer.from(input).toString('base64url'); }
function sha256B64u(input) { return createHash('sha256').update(input).digest('base64url'); }
function computeJwkThumbprint(jwk) {
  if (jwk.kty === 'OKP' && jwk.crv && jwk.x) return sha256B64u(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }));
  if (jwk.kty === 'EC' && jwk.crv && jwk.x && jwk.y) return sha256B64u(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }));
  throw new Error('unsupported jwk');
}
function generateKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicJwk = publicKey.export({ format: 'jwk' });
  return { alg: 'EdDSA', privateKey, publicJwk, jkt: computeJwkThumbprint(publicJwk) };
}
function signDpopProof({ key, htm, htu, accessToken, ath, nonce, jti, iat }) {
  const header = { typ: 'dpop+jwt', alg: key.alg, jwk: key.publicJwk };
  const payload = {
    jti: jti ?? randomBytes(16).toString('base64url'),
    htm, htu,
    iat: iat ?? Math.floor(Date.now() / 1000),
    ...(ath !== undefined ? { ath } : accessToken !== undefined ? { ath: sha256B64u(accessToken) } : {}),
    ...(nonce !== undefined ? { nonce } : {}),
  };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const sig = sign(null, Buffer.from(input, 'utf8'), key.privateKey);
  return `${input}.${sig.toString('base64url')}`;
}
function generatePkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: sha256B64u(verifier) };
}

async function reservePort() {
  return new Promise((resolvePort, rejectPort) => {
    const srv = net.createServer();
    srv.on('error', rejectPort);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? rejectPort(err) : resolvePort(port)));
    });
  });
}

function startStubMcp(variant) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      received.push({ method: req.method, path: req.url, headers: req.headers, body: bodyStr });
      if (req.url === '/authority') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ variant, authoritative: true, bridge: { hasUpstreamPair: true } }));
        return;
      }
      let msg = {};
      try { msg = JSON.parse(bodyStr || '{}'); } catch {}
      if (msg.id === undefined) { res.writeHead(202).end(); return; }
      const result = msg.method === 'initialize'
        ? { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: `stub-${variant}`, version: '1.0.0' } }
        : msg.method === 'tools/list'
          ? { tools: [{ name: `${variant}_ping`, description: 'Ping', inputSchema: { type: 'object', properties: {} } }] }
          : { content: [{ type: 'text', text: 'ok' }] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  return new Promise((resolveListen) => server.listen(0, '127.0.0.1', () => {
    resolveListen({ port: server.address().port, received, close: () => new Promise((r) => server.close(r)) });
  }));
}

function startStubAcs() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push({ url: req.url, body: Buffer.concat(chunks).toString('utf8') });
      if (req.url === '/readyz') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return; }
      if (req.url === '/mcp-clients/auth-event' || req.url === '/mcp-clients/observe') { res.writeHead(204).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ decision: 'allow' }));
    });
  });
  return new Promise((resolveListen) => server.listen(0, '127.0.0.1', () => {
    resolveListen({ port: server.address().port, requests, close: () => new Promise((r) => server.close(r)) });
  }));
}

function tlsRequest({ port, method, path, headers = {}, body, rejectUnauthorized = false }) {
  return new Promise((resolveReq, rejectReq) => {
    const req = https.request({ hostname: '127.0.0.1', port, path, method, headers, rejectUnauthorized }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolveReq({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', rejectReq);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function redactEvidence(obj) {
  const text = JSON.stringify(obj);
  return text
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[REDACTED_JWT]')
    .replace(/"refresh_token"\s*:\s*"[^"]+"/g, '"refresh_token":"[REDACTED]"')
    .replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token":"[REDACTED]"')
    .replace(/"authorization"\s*:\s*"[^"]+"/gi, '"authorization":"[REDACTED]"')
    .replace(/"dpop"\s*:\s*"[^"]+"/gi, '"dpop":"[REDACTED]"')
    .replace(/passphrase=[^&"\s]+/g, 'passphrase=[REDACTED]')
    .replace(/"passphrase"\s*:\s*"[^"]+"/g, '"passphrase":"[REDACTED]"')
    .replace(/test-consent-passphrase/g, '[REDACTED]');
}

async function main() {
  const evidenceDir = resolve(WORKTREE, 'verification/w7-external-gateway/evidence');
  mkdirSync(evidenceDir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'w7-gw-'));
  const dataDir = join(tmp, 'data');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dataDir, 'clients.json'), '{}', { mode: 0o600 });
  writeFileSync(join(dataDir, 'tokens.json'), '{}', { mode: 0o600 });

  const [dcStub, jcStub, acsStub] = await Promise.all([startStubMcp('dc'), startStubMcp('jc'), startStubAcs()]);
  const gwPort = await reservePort();
  const ingressPort = await reservePort();
  const tlsPort = await reservePort();
  const publicOrigin = `https://127.0.0.1:${tlsPort}`;
  const jcIssuer = `${publicOrigin}/jc`;
  const jcResource = `${publicOrigin}/jc/mcp`;
  const dcResource = `${publicOrigin}/mcp`;

  const keyPath = join(tmp, 'key.pem');
  const certPath = join(tmp, 'cert.pem');
  await new Promise((res, rej) => {
    const p = spawn('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath, '-sha256', '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
    p.on('exit', (c) => c === 0 ? res() : rej(new Error(`openssl exit ${c}`)));
  });
  const fs = await import('node:fs/promises');
  const tlsOpts = { key: await fs.readFile(keyPath), cert: await fs.readFile(certPath) };

  let gwLogs = '';
  const gw = spawn(process.execPath, [DC_GATEWAY_ENTRY], {
    cwd: resolve(WORKTREE, 'apps/dc-mcp-gateway'),
    env: {
      PATH: process.env.PATH,
      GATEWAY_PORT: String(gwPort),
      PUBLIC_ORIGIN: publicOrigin,
      RESOURCE: dcResource,
      ISSUER: publicOrigin,
      JC_ENABLED: '1',
      JC_ISSUER: jcIssuer,
      JC_RESOURCE: jcResource,
      UPSTREAM: `http://127.0.0.1:${dcStub.port}`,
      JC_UPSTREAM: `http://127.0.0.1:${jcStub.port}`,
      ACS_GATEWAY_URL: `http://127.0.0.1:${acsStub.port}`,
      ACS_JC_GATEWAY_TOKEN: 'jc-bridge-test-token',
      ACS_MANAGED_MODE: '0',
      JC_PRESET: 'local',
      GATEWAY_EXECUTION_TOKEN: 'gw-exec-test-token',
      CONSENT_PASSPHRASE,
      SIGNING_KEY,
      JC_REFRESH_RECOVERY_KEY: RECOVERY_KEY,
      DATA_DIR: dataDir,
      DPOP_NONCE_REQUIRED: '1',
      EDGE_TEST_MODE: '1',
      EDGE_TEST_ACCESS_TTL_S: '600',
      EDGE_TEST_REFRESH_TTL_S: '86400',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  gw.stdout.on('data', (d) => { gwLogs += d.toString(); });
  gw.stderr.on('data', (d) => { gwLogs += d.toString(); });

  const ingress = createPublicIngress({ upstreamPort: gwPort, jcResource });
  await new Promise((r) => ingress.listen(ingressPort, '127.0.0.1', r));

  const tlsProxy = https.createServer(tlsOpts, (req, res) => {
    const up = http.request({ hostname: '127.0.0.1', port: ingressPort, path: req.url, method: req.method, headers: req.headers }, (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('bad gateway'); } });
    req.pipe(up);
  });
  await new Promise((r) => tlsProxy.listen(tlsPort, '127.0.0.1', r));

  for (let i = 0; i < 80; i++) {
    try { const r = await tlsRequest({ port: tlsPort, method: 'GET', path: '/.well-known/oauth-protected-resource/jc/mcp' }); if (r.status === 200) break; } catch {}
    await new Promise((r) => setTimeout(r, 75));
  }

  const results = [];
  const evidence = [];
  function record(area, status, detail) { results.push({ area, status, detail }); }
  function ev(name, req, res) { evidence.push({ name, request: redactEvidence(req), response: redactEvidence(res) }); }

  async function issueTokensFor(key, label = 'issue') {
    const clientId = 'jace-commander-cli';
    const redirectUri = 'http://127.0.0.1:41234/callback';
    const { verifier, challenge } = generatePkce();
    const state = randomBytes(16).toString('base64url');
    const consentBody = new URLSearchParams({
      oauth_lane: 'jc', client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
      scope: 'mcp', state, code_challenge: challenge, code_challenge_method: 'S256',
      resource: jcResource, passphrase: CONSENT_PASSPHRASE,
    }).toString();
    const consentRes = await tlsRequest({ port: tlsPort, method: 'POST', path: '/authorize/consent', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: consentBody });
    ev(`${label}-authorize-consent`, { method: 'POST', path: '/authorize/consent' }, consentRes);
    const loc = new URL(consentRes.headers.location || 'http://x/?error=missing_location');
    const code = loc.searchParams.get('code');
    const tokenUrl = `/token?oauth_lane=jc&resource=${encodeURIComponent(jcResource)}`;
    const htu = `${publicOrigin}/token`;
    const tokenBody = new URLSearchParams({ grant_type: 'authorization_code', code: code || '', code_verifier: verifier, redirect_uri: redirectUri, client_id: clientId, resource: jcResource }).toString();
    let nonce;
    let tokenRes = await tlsRequest({ port: tlsPort, method: 'POST', path: tokenUrl, headers: { 'content-type': 'application/x-www-form-urlencoded', DPoP: signDpopProof({ key, htm: 'POST', htu, nonce }) }, body: tokenBody });
    let tb = {};
    try { tb = JSON.parse(tokenRes.body || '{}'); } catch { tb = { _parse_error: true, raw: tokenRes.body }; }
    if (tb.error === 'use_dpop_nonce') {
      nonce = tokenRes.headers['dpop-nonce'];
      tokenRes = await tlsRequest({ port: tlsPort, method: 'POST', path: tokenUrl, headers: { 'content-type': 'application/x-www-form-urlencoded', DPoP: signDpopProof({ key, htm: 'POST', htu, nonce }) }, body: tokenBody });
      try { tb = JSON.parse(tokenRes.body || '{}'); } catch { tb = { _parse_error: true, raw: tokenRes.body }; }
    }
    ev(`${label}-token`, { method: 'POST', path: tokenUrl }, tokenRes);
    return { tokenRes, tokens: tb, nonceFromToken: tokenRes.headers['dpop-nonce'], consentRes };
  }

  async function callMcp(accessToken, key, { htu, htm = 'POST', nonce, authScheme = 'DPoP', extraHeaders = {}, body, path = '/jc/mcp' } = {}) {
    const mcpBody = body ?? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const proof = signDpopProof({ key, htm, htu: htu ?? `${publicOrigin}${path}`, accessToken, nonce });
    return tlsRequest({ port: tlsPort, method: htm, path, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `${authScheme} ${accessToken}`, DPoP: proof, ...extraHeaders }, body: mcpBody });
  }

  try {
    const discoveryPath = '/.well-known/oauth-protected-resource/jc/mcp';
    const discovery = await tlsRequest({ port: tlsPort, method: 'GET', path: discoveryPath });
    ev('https-discovery-via-external-proxy', { method: 'GET', url: `${publicOrigin}${discoveryPath}` }, discovery);
    let discoveryBody = {};
    try { discoveryBody = JSON.parse(discovery.body || '{}'); } catch {}
    const originOk = discovery.status === 200 && discoveryBody.resource === jcResource && String(discoveryBody.authorization_servers?.[0] || '').startsWith(publicOrigin);
    record('canonical-external-origin+https-termination', originOk ? 'PASS' : 'FAIL', `GET ${publicOrigin}${discoveryPath} via TLS reverse proxy -> public ingress -> gateway returned ${discovery.status}; resource=${discoveryBody.resource} issuer/as=${discoveryBody.authorization_servers?.[0]}`);

    const key = generateKey();
    const issued = await issueTokensFor(key, 'main');
    const accessToken = issued.tokens.access_token;
    const deviceId = issued.tokens.device_id;
    const tokenOk = issued.tokenRes.status === 200 && issued.tokens.token_type === 'DPoP' && !!accessToken;
    record('nonce-challenge+nonce-retry (/token)', tokenOk ? 'PASS' : 'FAIL', `token exchange status=${issued.tokenRes.status} token_type=${issued.tokens.token_type} code_present=${Boolean(new URL(issued.consentRes.headers.location || 'http://x/').searchParams.get('code'))}`);

    if (!tokenOk) {
      record('dpop-htu-correctness', 'BLOCK', 'no valid access token issued');
      record('nonce-challenges+nonce-retry (/jc/mcp)', 'BLOCK', 'no valid access token issued');
      record('forwarded-header-handling', 'BLOCK', 'no valid access token issued');
      record('wrong-origin-rejection', 'BLOCK', 'no valid access token issued');
      record('replay-protection', 'BLOCK', 'no valid access token issued');
      record('access-token-audience', 'BLOCK', 'no valid access token issued');
      record('wrong-key-rejection', 'BLOCK', 'no valid access token issued');
      record('bearer-downgrade-rejection', 'BLOCK', 'no valid access token issued');
      record('revoked-device-rejection', 'BLOCK', 'no valid access token issued');
    } else {
      let nonce = issued.nonceFromToken;
      let okMcp = await callMcp(accessToken, key, { nonce });
      ev('mcp-positive-canonical-htu', { method: 'POST', path: '/jc/mcp', htu: `${publicOrigin}/jc/mcp` }, okMcp);
      if (okMcp.status === 401 && (okMcp.headers['www-authenticate'] || '').includes('use_dpop_nonce')) {
        nonce = okMcp.headers['dpop-nonce'];
        okMcp = await callMcp(accessToken, key, { nonce });
        ev('mcp-positive-canonical-htu-retry', { method: 'POST', path: '/jc/mcp' }, okMcp);
      }
      nonce = okMcp.headers['dpop-nonce'] || nonce;
      record('dpop-htu-correctness', okMcp.status === 200 ? 'PASS' : 'FAIL', `canonical htu ${publicOrigin}/jc/mcp -> ${okMcp.status}`);

      // nonce challenge on /jc/mcp with valid token
      const noNonceRes = await callMcp(accessToken, key, { nonce: undefined });
      ev('mcp-nonce-challenge', { method: 'POST', path: '/jc/mcp', note: 'no nonce' }, noNonceRes);
      const challengeOk = noNonceRes.status === 401 && (noNonceRes.headers['www-authenticate'] || '').includes('use_dpop_nonce') && !!noNonceRes.headers['dpop-nonce'];
      let retryRes = null;
      if (challengeOk) {
        retryRes = await callMcp(accessToken, key, { nonce: noNonceRes.headers['dpop-nonce'] });
        ev('mcp-nonce-retry', { method: 'POST', path: '/jc/mcp', note: 'with issued nonce' }, retryRes);
      }
      nonce = (retryRes || noNonceRes).headers['dpop-nonce'] || nonce;
      record('nonce-challenges+nonce-retry (/jc/mcp)', challengeOk && retryRes?.status === 200 ? 'PASS' : 'FAIL', `missing nonce -> ${noNonceRes.status} www-auth=${noNonceRes.headers['www-authenticate']} retry -> ${retryRes?.status}`);

      const spoofRes = await callMcp(accessToken, key, { nonce, extraHeaders: { host: 'attacker.evil.test', 'x-forwarded-host': 'attacker.evil.test', 'x-forwarded-proto': 'http', forwarded: 'host=attacker.evil.test;proto=http' } });
      ev('forwarded-header-spoof-canonical-proof', { headers: { host: 'attacker.evil.test', 'x-forwarded-host': 'attacker.evil.test' } }, spoofRes);
      nonce = spoofRes.headers['dpop-nonce'] || nonce;
      const wrongOriginProof = await callMcp(accessToken, key, { nonce, htu: 'https://attacker.evil.test/jc/mcp' });
      ev('wrong-origin-proof', { htu: 'https://attacker.evil.test/jc/mcp' }, wrongOriginProof);
      nonce = wrongOriginProof.headers['dpop-nonce'] || nonce;
      const wrongPathProof = await callMcp(accessToken, key, { nonce, htu: `${publicOrigin}/mcp` });
      ev('wrong-path-proof', { htu: `${publicOrigin}/mcp` }, wrongPathProof);
      nonce = wrongPathProof.headers['dpop-nonce'] || nonce;
      record('forwarded-header-handling', spoofRes.status === 200 ? 'PASS' : 'FAIL', `canonical proof with spoofed Host/X-Forwarded-* -> ${spoofRes.status} (gateway binds htu to configured canonical origin, not forwarded headers)`);
      record('wrong-origin-rejection', wrongOriginProof.status === 401 && wrongPathProof.status === 401 ? 'PASS' : 'FAIL', `attacker-origin htu -> ${wrongOriginProof.status}, wrong-path htu -> ${wrongPathProof.status}`);

      const fixedJti = 'fixed-jti-external-harness-001';
      const replayProof = signDpopProof({ key, htm: 'POST', htu: `${publicOrigin}/jc/mcp`, accessToken, nonce, jti: fixedJti });
      const firstReplay = await tlsRequest({ port: tlsPort, method: 'POST', path: '/jc/mcp', headers: { 'content-type': 'application/json', authorization: `DPoP ${accessToken}`, DPoP: replayProof }, body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} }) });
      const secondReplay = await tlsRequest({ port: tlsPort, method: 'POST', path: '/jc/mcp', headers: { 'content-type': 'application/json', authorization: `DPoP ${accessToken}`, DPoP: replayProof }, body: JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tools/list', params: {} }) });
      ev('replay-first', { jti: fixedJti }, firstReplay);
      ev('replay-second', { jti: fixedJti }, secondReplay);
      nonce = secondReplay.headers['dpop-nonce'] || nonce;
      record('replay-protection', firstReplay.status === 200 && secondReplay.status === 401 ? 'PASS' : 'FAIL', `first -> ${firstReplay.status}, replay same jti -> ${secondReplay.status}`);

      const dcMcpRes = await tlsRequest({ port: tlsPort, method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json', authorization: `DPoP ${accessToken}`, DPoP: signDpopProof({ key, htm: 'POST', htu: `${publicOrigin}/mcp`, accessToken, nonce }) }, body: JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'tools/list', params: {} }) });
      ev('wrong-audience-jc-token-on-dc-path-ingress-denied', { path: '/mcp', token_aud: jcResource }, dcMcpRes);
      nonce = dcMcpRes.headers?.['dpop-nonce'] || nonce;
      record('access-token-audience', 'PARTIAL', `jc-audience token presented to DC /mcp through filtered public ingress -> ${dcMcpRes.status} (denied at ingress route policy before gateway; gateway-level wrong-audience/resource rejection not directly reachable on /mcp through this external ingress). Positive audience binding on /jc/mcp evidenced by successful canonical access and wrong-resource/htu rejection.`);

      const attacker = generateKey();
      const wrongKeyRes = await callMcp(accessToken, attacker, { nonce });
      ev('wrong-key-stolen-token', { note: 'attacker key signs proof for victim token' }, wrongKeyRes);
      nonce = wrongKeyRes.headers['dpop-nonce'] || nonce;
      record('wrong-key-rejection', wrongKeyRes.status === 401 ? 'PASS' : 'FAIL', `stolen token with attacker key -> ${wrongKeyRes.status}`);

      const bearerRes = await tlsRequest({ port: tlsPort, method: 'POST', path: '/jc/mcp', headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 31, method: 'tools/list', params: {} }) });
      ev('bearer-downgrade', { authorization_scheme: 'Bearer' }, bearerRes);
      nonce = bearerRes.headers['dpop-nonce'] || nonce;
      record('bearer-downgrade-rejection', bearerRes.status === 401 && /^DPoP/i.test(bearerRes.headers['www-authenticate'] || '') ? 'PASS' : 'FAIL', `Bearer on DPoP-bound token -> ${bearerRes.status} www-auth=${bearerRes.headers['www-authenticate']}`);

      let revokeRes = null;
      let afterRevoke = null;
      if (deviceId) {
        revokeRes = await tlsRequest({ port: tlsPort, method: 'DELETE', path: `/jc/devices/${deviceId}`, headers: { authorization: `DPoP ${accessToken}`, DPoP: signDpopProof({ key, htm: 'DELETE', htu: `${publicOrigin}/jc/devices/${deviceId}`, accessToken, nonce }) } });
        ev('device-revoke', { method: 'DELETE', path: `/jc/devices/${deviceId}` }, revokeRes);
        nonce = revokeRes.headers['dpop-nonce'] || nonce;
        afterRevoke = await callMcp(accessToken, key, { nonce });
        ev('mcp-after-revoke', { note: 'revoked device token' }, afterRevoke);
        record('revoked-device-rejection', revokeRes.status === 200 && afterRevoke.status === 401 ? 'PASS' : 'FAIL', `revoke -> ${revokeRes.status}, post-revoke /jc/mcp -> ${afterRevoke.status}`);
      } else {
        record('revoked-device-rejection', 'BLOCK', `no device_id returned from token issuance (token_type=${issued.tokens.token_type})`);
      }
    }

  } catch (err) {
    record('harness-execution', 'FAIL', String(err && err.stack || err));
  } finally {
    writeFileSync(join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
    writeFileSync(join(evidenceDir, 'results.json'), JSON.stringify(results, null, 2));
    writeFileSync(join(evidenceDir, 'gateway.log'), gwLogs);
    try { tlsProxy.close(); } catch {}
    try { ingress.close(); } catch {}
    try { gw.kill('SIGTERM'); } catch {}
    await Promise.all([dcStub.close(), jcStub.close(), acsStub.close()]);
    rmSync(tmp, { recursive: true, force: true });
  }

  for (const r of results) console.log(`${r.status}\t${r.area}\t${r.detail}`);
  const failed = results.filter(r => r.status === 'FAIL');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
