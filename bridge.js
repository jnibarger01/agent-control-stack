#!/usr/bin/env node
/**
 * bridge.js — stdio → Streamable HTTP bridge for Desktop Commander,
 * replacing Supergateway so the listener binds strictly to 127.0.0.1.
 *
 * Pure JSON-RPC relay between two MCP SDK transports:
 *   StdioClientTransport (spawns Desktop Commander dist/index.js)
 *     <-> StreamableHTTPServerTransport (loopback HTTP for the auth gateway)
 *
 * Gateway attestation: the auth gateway mints a short-lived HMAC attestation
 * (x-dc-attestation) for each authenticated request when GATEWAY_EXECUTION_TOKEN
 * is set; the bridge expects the same value in DC_GATEWAY_EXECUTION_TOKEN.
 * A valid attestation is verified and the signer's identity is injected into
 * the forwarded JSON-RPC params._meta (trusted transport attribution).
 * Requests without the header pass through unchanged (local non-gateway use).
 *
 * Serves:  GET /healthz -> "ok"   |   POST/GET/DELETE /mcp -> MCP transport
 *          GET /debug/last-headers -> last forwarded headers/message (test aid)
 */
import http from 'node:http';
import { randomUUID, webcrypto, createHmac, timingSafeEqual } from 'node:crypto';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// SDK transports expect the webcrypto global on some runtimes.
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const PORT = parseInt(process.env.BRIDGE_PORT || '8002', 10);
const DC_CMD = process.env.DC_CMD || '/home/linuxbrew/.linuxbrew/bin/node';
const DC_ARGS = (process.env.DC_ARGS || '/home/jacen/projects/desktop-commander/dist/index.js --standalone').split(' ');
const DC_CWD = process.env.DC_CWD || '/home/jacen/projects/desktop-commander';
const EXECUTION_TOKEN = process.env.DC_GATEWAY_EXECUTION_TOKEN || '';

let pair = null; // { upstream, httpTransport }
let spawnCount = 0;
let lastDebug = { last_headers: null, last_upstream_message: null };

// Verify an x-dc-attestation header: body.sig where sig =
// HMAC-SHA256(EXECUTION_TOKEN, body), body = base64url(JSON payload with exp).
function verifyAttestation(value, agentHeader) {
  try {
    const [body, sig] = String(value).split('.');
    if (!body || !sig) return null;
    const expect = createHmac('sha256', EXECUTION_TOKEN).update(body).digest('base64url');
    const a = Buffer.from(sig); const b = Buffer.from(expect);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const t = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp < t) return null;
    if (typeof payload.iat === 'number' && payload.exp - payload.iat > 60) return null;
    if (agentHeader && payload.sub !== agentHeader) return null;
    return payload;
  } catch { return null; }
}

// Inject verified gateway identity into the outbound JSON-RPC message.
// No attestation header -> pass through unchanged.
function injectAttestation(msg, headers) {
  if (!EXECUTION_TOKEN) return msg;
  const att = headers['x-dc-attestation'];
  if (!att) return msg;
  const payload = verifyAttestation(att, headers['x-dc-agent']);
  if (!payload) return msg; // HTTP layer already rejects invalid ones
  const agent = String(payload.sub || '');
  const agentTag = agent.startsWith('chatgpt:') ? agent : `chatgpt:${agent}`;
  if (!msg.params || typeof msg.params !== 'object') msg.params = {};
  const meta = { ...(msg.params._meta || {}) };
  meta.agent = agentTag;
  meta.gateway = { verified: true, sub: payload.sub, client_id: payload.client_id, jti: payload.jti, ts: Math.floor(Date.now() / 1000) };
  if (!meta.transport) meta.transport = 'oauth-gateway';
  msg.params._meta = meta;
  return msg;
}

function spawnPair() {
  const upstream = new StdioClientTransport({
    command: DC_CMD, args: DC_ARGS, cwd: DC_CWD, stderr: 'inherit',
  });
  const httpTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: false, // preserve SSE streaming semantics end to end
  });
  upstream.onmessage = (msg) => { httpTransport.send(msg).catch((e) => console.error('bridge: send->http failed:', e && e.message)); };
  upstream.onerror = (e) => console.error('bridge: upstream error:', e && e.message);
  upstream.onclose = () => console.error('bridge: upstream closed');
  httpTransport.onmessage = (msg, extra) => {
    try {
      const headers = extra?.requestInfo?.headers || {};
      injectAttestation(msg, headers);
      lastDebug = { last_headers: headers, last_upstream_message: msg };
    } catch (e) { console.error('bridge: attestation injection failed:', e && e.message); }
    upstream.send(msg).catch((e) => console.error('bridge: send->stdio failed:', e && e.message));
  };
  httpTransport.onerror = (e) => console.error('bridge: http transport error:', e && e.message);
  upstream.start().catch((e) => { console.error('bridge: upstream start failed:', e && e.message); process.exit(1); });
  spawnCount++;
  pair = { upstream, httpTransport };
  console.log('bridge: Desktop Commander stdio executor started');
}

function recyclePair() {
  if (!pair) return spawnPair();
  console.log('bridge: new client session requested; recycling executor');
  const old = pair;
  pair = null;
  spawnPair();
  setTimeout(() => { try { old.upstream.close(); } catch { /* noop */ } try { old.httpTransport.close?.(); } catch { /* noop */ } }, 1000);
}

spawnPair();

function sendJsonRpcError(res, status, code, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

const httpServer = http.createServer(async (req, res) => {
  const path = req.url ? req.url.split('?')[0] : '/';
  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (path === '/debug/last-headers') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...lastDebug, spawn_count: spawnCount }));
    return;
  }
  if (path === '/mcp') {
    // Attested identity from the auth gateway: reject forgeries before the
    // message ever reaches the executor.
    if (EXECUTION_TOKEN && req.method === 'POST') {
      const att = req.headers['x-dc-attestation'];
      if (att && !verifyAttestation(att, req.headers['x-dc-agent'])) {
        console.error('bridge: invalid gateway attestation; rejecting without forward');
        return sendJsonRpcError(res, 400, -32001, 'gateway attestation invalid');
      }
    }
    // A request without a session id is a brand-new client: give it a fresh pair.
    if (!req.headers['mcp-session-id']) recyclePair();
    try {
      await pair.httpTransport.handleRequest(req, res);
    } catch (e) {
      console.error('bridge: handleRequest error:', e && e.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'bridge error' }, id: null }));
      } else res.destroy();
    }
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

httpServer.headersTimeout = 30_000;
httpServer.requestTimeout = 0;
httpServer.keepAliveTimeout = 65_000;
httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`bridge: Streamable HTTP MCP on http://127.0.0.1:${PORT}/mcp (127.0.0.1 only)`);
});
