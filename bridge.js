#!/usr/bin/env node
/**
 * bridge.js — stdio → Streamable HTTP bridge for Desktop Commander,
 * replacing Supergateway so the listener binds strictly to 127.0.0.1.
 *
 * Pure JSON-RPC relay between two MCP SDK transports:
 *   StdioClientTransport (spawns Desktop Commander dist/index.js)
 *     <-> StreamableHTTPServerTransport (loopback HTTP for the auth gateway)
 *
 * Session policy: one canonical Desktop Commander executor at a time. A new
 * client initialize (POST /mcp without an Mcp-Session-Id) recycles the
 * executor + transport pair so the latest client always gets a clean session.
 *
 * Serves:  GET /healthz -> "ok"   |   POST/GET/DELETE /mcp -> MCP transport
 */
import http from 'node:http';
import { randomUUID, webcrypto } from 'node:crypto';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { recycleDecision } from './recycle-policy.js';

// SDK transports expect the webcrypto global on some runtimes.
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const PORT = parseInt(process.env.BRIDGE_PORT || '8002', 10);
// MANAGED MODE (ACS_MANAGED_MODE=1, docs/acs-managed-mode.md): Desktop
// Commander is spawned WITHOUT --standalone. Authority comes only from
// ACS-issued acs.dc.v1 capabilities transported by the auth gateway; the
// bridge never mints or injects capabilities. No --standalone fallback.
const MANAGED = process.env.ACS_MANAGED_MODE === '1';
const DC_CMD = process.env.DC_CMD || '/home/linuxbrew/.linuxbrew/bin/node';
const DC_ARGS = MANAGED
  ? (process.env.DC_ARGS || '/home/jacen/projects/desktop-commander/dist/index.js').split(' ').filter((a) => a !== '--standalone')
  : (process.env.DC_ARGS || '/home/jacen/projects/desktop-commander/dist/index.js --standalone').split(' ');
const DC_CWD = process.env.DC_CWD || '/home/jacen/projects/desktop-commander';
const RECYCLE_WAIT_MS = parseInt(process.env.BRIDGE_RECYCLE_WAIT_MS || '15000', 10);

let pair = null; // { upstream, httpTransport }
let inFlight = 0; // tools/call requests currently executing against the pair

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
  httpTransport.onmessage = (msg) => { upstream.send(msg).catch((e) => console.error('bridge: send->stdio failed:', e && e.message)); };
  httpTransport.onerror = (e) => console.error('bridge: http transport error:', e && e.message);
  upstream.start().catch((e) => { console.error('bridge: upstream start failed:', e && e.message); process.exit(1); });
  pair = { upstream, httpTransport };
  console.log('bridge: Desktop Commander stdio executor started');
}

function idleClose(old) {
  setTimeout(() => { try { old.upstream.close(); } catch { /* noop */ } try { old.httpTransport.close?.(); } catch { /* noop */ } }, 1000);
}

/**
 * Lease-safe recycle. While a tools/call is in flight the running session may
 * own an ACS attempt/lease — killing it mid-attempt could strand governed
 * work. The recycle is deferred until inFlight drains; if the bounded wait
 * expires the new session is refused (fail closed), never a mid-attempt kill.
 */
function requestRecycle(waitMs = RECYCLE_WAIT_MS) {
  if (!pair) return spawnPair();
  if (inFlight === 0) {
    console.log('bridge: new client session requested; recycling idle executor');
    const old = pair;
    pair = null;
    spawnPair();
    idleClose(old);
    return { recycled: true };
  }
  console.log('bridge: recycle deferred — tools/call in flight (lease-safe)');
  const deadline = Date.now() + waitMs;
  const poll = setInterval(() => {
    if (!pair) { clearInterval(poll); return; }
    if (inFlight === 0) {
      clearInterval(poll);
      const old = pair;
      pair = null;
      spawnPair();
      idleClose(old);
    } else if (Date.now() > deadline) {
      clearInterval(poll);
      console.log('bridge: recycle wait expired; new session refused (fail closed, lease preserved)');
    }
  }, 100);
  return { recycled: false, deferred: true };
}



spawnPair();
console.log(`bridge: executor mode: ${MANAGED ? 'managed (ACS-authorized capabilities only)' : 'standalone'}`);

const httpServer = http.createServer(async (req, res) => {
  const path = req.url ? req.url.split('?')[0] : '/';
  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (path === '/mcp') {
    // A request without a session id is a brand-new client: recycle when safe.
    if (!req.headers['mcp-session-id']) requestRecycle();
    let isCall = false;
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      let parsed; try { parsed = JSON.parse(body.toString('utf8')); } catch { parsed = null; }
      isCall = Boolean(parsed && typeof parsed.method === 'string' && parsed.method.startsWith('tools/'));
      // Re-body the request for the SDK transport after inspection.
      const headers = { ...req.headers };
      delete headers['content-length'];
      headers['content-length'] = String(body.length);
      Object.defineProperty(req, 'headers', { value: headers });
      req.push(body);
    } catch (e) {
      console.error('bridge: body read error:', e && e.message);
    }
    try {
      if (isCall && pair) {
        inFlight += 1;
        try { await pair.httpTransport.handleRequest(req, res); } finally { inFlight -= 1; }
        return;
      }
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
  console.log(`bridge: Streamable HTTP MCP on http://127.0.0.1:${PORT}/mcp (127.0.0.1 only, ${MANAGED ? 'managed' : 'standalone'})`);
});
