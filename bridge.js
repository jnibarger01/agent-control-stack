#!/usr/bin/env node
/**
 * stdio -> Streamable HTTP MCP multiplexer for Desktop Commander.
 *
 * There is exactly one upstream StdioClientTransport (and therefore one
 * Desktop Commander executor). Each downstream HTTP client gets its own
 * StreamableHTTPServerTransport and gateway session record. The gateway
 * rewrites request ids at the shared-upstream boundary so independent clients
 * may reuse JSON-RPC ids without response crossover.
 */
import http from 'node:http';
import { randomUUID, webcrypto, createHmac, timingSafeEqual } from 'node:crypto';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const PORT = parseInt(process.env.BRIDGE_PORT || '8002', 10);
const DC_CMD = process.env.DC_CMD || '/home/linuxbrew/.linuxbrew/bin/node';
const DC_ARGS = (process.env.DC_ARGS || '/home/jacen/projects/desktop-commander/dist/index.js --standalone').split(' ');
const DC_CWD = process.env.DC_CWD || '/home/jacen/projects/desktop-commander';
const EXECUTION_TOKEN = process.env.DC_GATEWAY_EXECUTION_TOKEN || '';
const MAX_BODY = 2 * 1024 * 1024;

let pair = null; // { upstream, sessions, routes, initResponse, initPromise }
let spawnCount = 0;
let lastDebug = { last_headers: null, last_upstream_message: null };
let shuttingDown = false;

function idKey(id) { return `${typeof id}:${JSON.stringify(id)}`; }
function hasId(msg) { return Object.prototype.hasOwnProperty.call(msg, 'id'); }
function isRequest(msg) { return hasId(msg) && typeof msg.method === 'string'; }
function isNotification(msg) { return !hasId(msg) && typeof msg.method === 'string'; }
function isResponse(msg) { return hasId(msg) && !isRequest(msg) && (msg.result !== undefined || msg.error !== undefined); }
function isInitialize(msg) { return msg?.method === 'initialize'; }

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

function injectAttestation(msg, headers) {
  if (!EXECUTION_TOKEN) return msg;
  const att = headers['x-dc-attestation'];
  if (!att) return msg; // local loopback callers retain legacy pass-through behavior
  const payload = verifyAttestation(att, headers['x-dc-agent']);
  if (!payload) return msg; // HTTP layer rejects before this point
  const agent = String(payload.sub || '');
  const meta = { ...(msg.params?._meta || {}) };
  meta.agent = agent.startsWith('chatgpt:') ? agent : `chatgpt:${agent}`;
  meta.gateway = { verified: true, sub: payload.sub, client_id: payload.client_id, jti: payload.jti, ts: Math.floor(Date.now() / 1000) };
  if (!meta.transport) meta.transport = 'oauth-gateway';
  msg.params = { ...(msg.params || {}), _meta: meta };
  return msg;
}

function sendJsonRpcError(res, status, code, message) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

async function readJsonBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}

function failClosed(reason, target = pair) {
  console.error(`bridge: fail-closed upstream routing fault: ${reason}`);
  if (!target) return;
  target.initReject?.(new Error(reason));
  for (const session of target.sessions.values()) { session.closed = true; session.transport.close().catch(() => {}); }
  target.sessions.clear(); target.routes.clear();
}

async function forward(session, msg, headers) {
  if (session.closed || !pair || pair !== session.pair) return;
  const outbound = injectAttestation(structuredClone(msg), headers);
  lastDebug = { last_headers: headers, last_upstream_message: outbound };

  if (isInitialize(msg)) {
    if (pair.initResponse) { await session.transport.send({ ...pair.initResponse, id: msg.id }); return; }
    if (!pair.initPromise) {
      pair.initPromise = new Promise((resolve, reject) => { pair.initResolve = resolve; pair.initReject = reject; });
      pair.initPromise.catch(() => {});
      const upstreamId = `gw-init-${randomUUID()}`;
      pair.routes.set(upstreamId, { session, downstreamId: msg.id, initialize: true });
      outbound.id = upstreamId;
      session.pending.set(idKey(msg.id), upstreamId);
      await pair.upstream.send(outbound);
      return;
    }
    const response = await pair.initPromise;
    if (!session.closed) await session.transport.send({ ...response, id: msg.id });
    return;
  }

  if (isResponse(msg)) { failClosed(`downstream response has no deterministic server-request route (${String(msg.id)})`, session.pair); return; }
  if (!isRequest(msg) && !isNotification(msg)) { failClosed('malformed message after SDK validation', session.pair); return; }
  if (pair.initPromise) await pair.initPromise;
  if (!pair.initResponse || session.closed) return;
  if (isNotification(msg)) { await pair.upstream.send(outbound); return; }

  const key = idKey(msg.id);
  if (session.pending.has(key)) { failClosed(`duplicate downstream request id in session ${session.id}`, session.pair); return; }
  const upstreamId = `gw-${randomUUID()}`;
  session.pending.set(key, upstreamId);
  pair.routes.set(upstreamId, { session, downstreamId: msg.id, initialize: false });
  outbound.id = upstreamId;
  try { await pair.upstream.send(outbound); }
  catch (error) { pair.routes.delete(upstreamId); session.pending.delete(key); throw error; }
}

function spawnPair() {
  const upstream = new StdioClientTransport({ command: DC_CMD, args: DC_ARGS, cwd: DC_CWD, stderr: 'inherit' });
  const next = { upstream, sessions: new Map(), routes: new Map(), initResponse: null, initPromise: null };
  upstream.onmessage = async (msg) => {
    if (isResponse(msg)) {
      const route = next.routes.get(String(msg.id));
      if (!route || !route.session || route.session.closed) return failClosed(`orphan upstream response ${String(msg.id)}`, next);
      next.routes.delete(String(msg.id)); route.session.pending.delete(idKey(route.downstreamId));
      const response = { ...msg, id: route.downstreamId };
      if (route.initialize) { next.initResponse = response; next.initResolve?.(response); }
      try { await route.session.transport.send(response); }
      catch (error) { failClosed(`downstream response delivery failed: ${error.message}`, next); }
      return;
    }
    if (hasId(msg) && typeof msg.method === 'string') return failClosed(`unsupported upstream server request ${String(msg.method)}`, next);
    for (const session of next.sessions.values()) if (!session.closed) session.transport.send(msg).catch(() => {});
  };
  upstream.onerror = (e) => console.error('bridge: upstream error:', e?.message);
  upstream.onclose = () => {
    console.error('bridge: upstream closed');
    if (pair === next) {
      failClosed('upstream closed', next);
      if (!shuttingDown) spawnPair();
    }
  };
  upstream.start().catch((e) => { console.error('bridge: upstream start failed:', e?.message); process.exit(1); });
  spawnCount++; pair = next;
  console.log(`bridge: Desktop Commander stdio executor started (spawn_count=${spawnCount})`);
}

function createSession(headers) {
  const session = {
    id: null,
    pair,
    transport: null,
    pending: new Map(),
    closed: false,
    initialized: false,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    metadata: { client: headers['user-agent'] || null },
  };
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(), enableJsonResponse: false,
    onsessioninitialized: (sid) => {
      if (pair !== session.pair || session.pair.sessions.has(sid)) throw new Error('ambiguous downstream session ownership');
      session.id = sid; session.initialized = true; session.lastActivityAt = Date.now(); session.pair.sessions.set(sid, session);
    },
    onsessionclosed: (sid) => {
      if (session.pair.sessions.get(sid) === session) session.pair.sessions.delete(sid);
      session.closed = true;
      for (const upstreamId of session.pending.values()) session.pair.routes.delete(upstreamId);
      session.pending.clear();
    },
  });
  session.transport = transport;
  transport.onmessage = (msg, extra) => {
    session.lastActivityAt = Date.now();
    const requestHeaders = extra?.requestInfo?.headers || headers;
    session.metadata.protocolVersion = msg.params?.protocolVersion || session.metadata.protocolVersion;
    forward(session, msg, requestHeaders).catch((error) => { console.error('bridge: send->stdio failed:', error?.message); failClosed('upstream forwarding failure'); });
  };
  transport.onerror = (e) => console.error('bridge: downstream transport error:', e?.message);
  return session;
}

spawnPair();

const httpServer = http.createServer(async (req, res) => {
  const path = req.url ? req.url.split('?')[0] : '/';
  if (path === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (path === '/debug/last-headers') {
    const pendingCount = pair ? [...pair.sessions.values()].reduce((count, session) => count + session.pending.size, 0) : 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...lastDebug, spawn_count: spawnCount, session_count: pair?.sessions.size || 0, pending_count: pendingCount }));
    return;
  }
  if (path !== '/mcp') { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' })); return; }

  if (EXECUTION_TOKEN && req.method === 'POST') {
    const att = req.headers['x-dc-attestation'];
    if (att && !verifyAttestation(att, req.headers['x-dc-agent'])) { console.error('bridge: invalid gateway attestation; rejecting without forward'); return sendJsonRpcError(res, 400, -32001, 'gateway attestation invalid'); }
  }

  const sid = req.headers['mcp-session-id'];
  let session = sid ? pair.sessions.get(sid) : null;
  if (sid && (!session || session.closed)) return sendJsonRpcError(res, 400, -32001, 'session unknown; reconnect and re-initialize');
  try {
    let body;
    if (req.method === 'POST') body = await readJsonBody(req);
    if (req.method === 'POST') {
      const messages = Array.isArray(body) ? body : [body];
      const initialization = messages.some(isInitialize);
      if (!session && !initialization) return sendJsonRpcError(res, 400, -32000, 'Mcp-Session-Id header is required');
      if (!session) session = createSession(req.headers);
    } else if (!session) return sendJsonRpcError(res, 400, -32001, 'session unknown; reconnect and re-initialize');
    lastDebug.last_headers = req.headers;
    await session.transport.handleRequest(req, res, body);
  } catch (e) {
    console.error('bridge: handleRequest error:', e?.message);
    if (!res.headersSent) {
      const parseFailure = e.status === 400;
      sendJsonRpcError(res, e.status || 500, parseFailure ? -32700 : -32603, parseFailure ? 'Parse error' : 'bridge error');
    } else res.destroy();
  }
});

httpServer.headersTimeout = 30_000;
httpServer.requestTimeout = 0;
httpServer.keepAliveTimeout = 65_000;
httpServer.listen(PORT, '127.0.0.1', () => console.log(`bridge: Streamable HTTP MCP on http://127.0.0.1:${PORT}/mcp (127.0.0.1 only)`));

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`bridge: ${signal} received; shutting down cleanly`);
  const activePair = pair;
  const closeListener = new Promise((resolve) => httpServer.close(() => resolve()));
  if (activePair) {
    const transports = [...activePair.sessions.values()].map((session) => session.transport);
    failClosed('gateway shutdown', activePair);
    await Promise.allSettled(transports.map((transport) => transport.close()));
    await activePair.upstream.close().catch((error) => console.error('bridge: upstream close failed:', error?.message));
  }
  await closeListener;
  console.log('bridge: shutdown complete; canonical executor transport closed');
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    shutdown(signal).then(() => process.exit(0)).catch((error) => {
      console.error('bridge: shutdown failed:', error?.message);
      process.exit(1);
    });
  });
}
