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

// SDK transports expect the webcrypto global on some runtimes.
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const PORT = parseInt(process.env.BRIDGE_PORT || '8002', 10);
const DC_CMD = process.env.DC_CMD || '/home/linuxbrew/.linuxbrew/bin/node';
const DC_ARGS = (process.env.DC_ARGS || '/home/jacen/projects/desktop-commander/dist/index.js --standalone').split(' ');
const DC_CWD = process.env.DC_CWD || '/home/jacen/projects/desktop-commander';

let pair = null; // { upstream, httpTransport }

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

function recyclePair() {
  if (!pair) return spawnPair();
  console.log('bridge: new client session requested; recycling executor');
  const old = pair;
  pair = null;
  spawnPair();
  setTimeout(() => { try { old.upstream.close(); } catch { /* noop */ } try { old.httpTransport.close?.(); } catch { /* noop */ } }, 1000);
}

spawnPair();

const httpServer = http.createServer(async (req, res) => {
  const path = req.url ? req.url.split('?')[0] : '/';
  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (path === '/mcp') {
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
