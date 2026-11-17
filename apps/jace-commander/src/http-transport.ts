/**
 * Native Streamable HTTP transport for Jace Commander.
 *
 * Exposes the JC MCP server directly over HTTP (Streamable HTTP transport)
 * so ChatGPT or any MCP client can connect without the stdio bridge.
 *
 * Security properties (fail closed):
 *   - When a gateway attestation token is configured, every /mcp request must
 *     carry a valid `x-dc-attestation` for the claimed `x-dc-agent`, and the
 *     verified identity is stamped into the request body as `_meta.gateway`.
 *     Client-supplied `_meta.gateway` is always stripped (spoof-proofing).
 *   - Attestation jti values are tracked until expiry to reject replays.
 *   - JSON-RPC batches that contain any `tools/call` are refused: the server
 *     cannot attribute authority per element and cannot safely stamp each call.
 *   - Client-supplied authority metadata (`_meta.acsCapability`/`capability`,
 *     bootstrap/runtime identity) is stripped before dispatch unless it arrived
 *     through a verified, attested gateway path that stamped identity.
 *   - Sessions are isolated; unknown session ids are rejected.
 *   - Basic request hardening: Host/Origin validation (when present),
 *     Content-Type enforcement for POST, and bounded request bodies.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createJcServer, type JcMode, type JcServerDeps } from './server.js';
import type { JcConfig } from './config.js';
import { toolRegistryJson } from './tool-registry.js';
import { JC_MANIFEST } from './manifest.generated.js';

const MAX_BODY = 2 * 1024 * 1024;

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

export interface JcHttpOptions {
  config: JcConfig;
  mode: JcMode;
  deps?: JcServerDeps;
  host?: string;
  port?: number;
  /** HMAC key for gateway attestation (e.g. DC_GATEWAY_EXECUTION_TOKEN). When set, attestation is required. */
  attestationToken?: string;
  /** When true, managed-mode posture: attestation required if token configured is not enough? caller decides. */
  requireAttestation?: boolean;
  /** Additional allowed Host header values (lowercased, host[:port]). Loopback forms are always allowed. */
  allowedHosts?: string[];
  /** Additional allowed Origin values. Missing Origin is allowed (non-browser clients). */
  allowedOrigins?: string[];
  /** Optional authority/status info for /authority. */
  authority?: () => Record<string, unknown>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: Server;
  createdAt: number;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function sendRpcError(res: http.ServerResponse, status: number, id: unknown, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: id ?? null });
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1'
    || h.startsWith('localhost:') || h.startsWith('127.0.0.1:') || h.startsWith('[::1]:');
}

export function isAllowedHost(hostHeader: string | undefined, extra: readonly string[] = []): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.toLowerCase().trim();
  if (isLoopbackHost(host)) return true;
  return extra.map((v) => v.toLowerCase()).includes(host);
}

export function isAllowedOrigin(originHeader: string | undefined, reqHost: string | undefined, extra: readonly string[] = []): boolean {
  if (!originHeader) return true; // non-browser / server-to-server clients
  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    return false;
  }
  const value = origin.origin.toLowerCase();
  if (extra.map((v) => v.toLowerCase()).includes(value)) return true;
  const host = origin.host.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.startsWith('localhost:') || host.startsWith('127.0.0.1:') || host.startsWith('[::1]:')) return true;
  // allow same-origin as the request Host when Host is explicit
  if (reqHost && host === reqHost.toLowerCase().trim()) return true;
  return false;
}

function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const type = contentType.split(';', 1)[0]!.trim().toLowerCase();
  return type === 'application/json' || type.endsWith('+json');
}

async function readJsonBody(req: http.IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) {
      const err = new Error('body_too_large') as Error & { status?: number };
      err.status = 413;
      throw err;
    }
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as Json;
  } catch {
    const err = new Error('invalid_json') as Error & { status?: number };
    err.status = 400;
    throw err;
  }
}

export interface VerifiedAttestation { sub: string; client_id: string; jti: string; exp: number; iat: number }

export function verifyGatewayAttestation(
  value: string | string[] | undefined,
  agentHeader: string | string[] | undefined,
  token: string,
): VerifiedAttestation | null {
  try {
    const raw = headerString(value);
    const agent = headerString(agentHeader);
    const parts = String(raw ?? '').split('.');
    if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return null;
    const [body, sig] = parts;
    if (!body || !sig) return null;
    const expect = crypto.createHmac('sha256', token).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    const t = Math.floor(Date.now() / 1000);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    if (typeof payload.sub !== 'string' || !payload.sub.trim()) return null;
    if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number') return null;
    if (payload.exp < t || payload.iat > t + 5 || payload.exp - payload.iat > 60 || payload.exp <= payload.iat) return null;
    if (agent && payload.sub !== agent) return null;
    return {
      sub: String(payload.sub),
      client_id: typeof payload.client_id === 'string' ? payload.client_id : '',
      jti: typeof payload.jti === 'string' ? payload.jti : '',
      exp: payload.exp,
      iat: payload.iat,
    };
  } catch {
    return null;
  }
}

/** In-memory jti replay cache (bounded by attestation TTL). */
export class ReplayCache {
  private readonly seen = new Map<string, number>();
  constructor(private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}
  /** Returns true if this (jti, exp) is fresh and records it; false if replay/invalid. */
  accept(jti: string, exp: number): boolean {
    this.sweep();
    if (!jti) return true; // legacy attestations without jti: rely on short TTL/expiry
    if (this.seen.has(jti)) return false;
    if (this.seen.size > 10_000) return false; // fail closed on exhaustion
    this.seen.set(jti, exp);
    return true;
  }
  sweep(): void {
    const t = this.now();
    for (const [jti, exp] of this.seen) {
      if (exp <= t) this.seen.delete(jti);
    }
  }
  get size(): number { return this.seen.size; }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasToolsCall(msg: unknown): boolean {
  if (Array.isArray(msg)) return msg.some((item) => hasToolsCall(item));
  return isPlainRecord(msg) && msg.method === 'tools/call';
}

function isInitialize(msg: unknown): boolean {
  if (Array.isArray(msg)) return msg.some((item) => isPlainRecord(item) && item.method === 'initialize');
  return isPlainRecord(msg) && msg.method === 'initialize';
}

function stripAuthoritySpoof(meta: Record<string, unknown>): void {
  delete meta.gateway;
  delete meta.acsCapability;
  delete meta.capability;
  delete meta.acsRuntimeBootstrap;
  delete meta.acsRuntimeIdentity;
}

/** Stamp verified gateway identity and strip spoofed authority fields. */
export function stampGatewayIdentity(body: Json, payload: VerifiedAttestation, token: string): Json {
  const stamp = (msg: unknown): unknown => {
    if (!isPlainRecord(msg)) return msg;
    const params = isPlainRecord(msg.params) ? { ...msg.params } : undefined;
    if (!params) return msg;
    const meta = isPlainRecord(params._meta) ? { ...params._meta } : {};
    stripAuthoritySpoof(meta);
    const iat = Date.now();
    const material = `${payload.sub}.${payload.client_id}.${payload.jti}.${iat}`;
    const sig = crypto.createHmac('sha256', token).update(material).digest('base64url');
    const agent = payload.sub.startsWith('chatgpt:') ? payload.sub : `chatgpt:${payload.sub}`;
    meta.agent = agent;
    meta.gateway = { verified: true, sub: payload.sub, client_id: payload.client_id, jti: payload.jti, iat, sig };
    meta.transport = 'oauth-gateway';
    params._meta = meta;
    return { ...msg, params };
  };
  if (Array.isArray(body)) return body.map(stamp);
  return stamp(body) as Json;
}

/** When no attestation is required, still strip spoofed gateway/authority meta from direct clients. */
export function stripUntrustedGatewayMeta(body: Json): Json {
  const clean = (msg: unknown): unknown => {
    if (!isPlainRecord(msg)) return msg;
    const params = isPlainRecord(msg.params) ? { ...msg.params } : undefined;
    if (!params || !isPlainRecord(params._meta)) return msg;
    const meta = { ...params._meta };
    stripAuthoritySpoof(meta);
    params._meta = meta;
    return { ...msg, params };
  };
  if (Array.isArray(body)) return body.map(clean);
  return clean(body) as Json;
}

export async function startJcHttpServer(options: JcHttpOptions): Promise<{ server: http.Server; close: () => Promise<void>; url: string }> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8011;
  const sessions = new Map<string, Session>();
  const attestationToken = options.attestationToken ?? '';
  const requireAttestation = options.requireAttestation ?? (options.mode === 'managed' || options.mode === 'local');
  const allowedHosts = options.allowedHosts ?? [];
  const allowedOrigins = options.allowedOrigins ?? [];
  const replay = new ReplayCache();

  function closeSession(id: string): void {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    try { void session.server.close(); } catch { /* ignore */ }
    try { void session.transport.close(); } catch { /* ignore */ }
  }

  function makeSession(): Session {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    const server = createJcServer(options.config, options.mode, options.deps);
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
      try { void server.close(); } catch { /* ignore */ }
    };
    void server.connect(transport);
    const session: Session = { transport, server, createdAt: Date.now() };
    return session;
  }

  async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reqHost = headerString(req.headers.host);
    if (!isAllowedHost(reqHost, allowedHosts)) {
      return sendRpcError(res, 403, null, -32000, 'forbidden host');
    }
    if (!isAllowedOrigin(headerString(req.headers.origin), reqHost, allowedOrigins)) {
      return sendRpcError(res, 403, null, -32000, 'forbidden origin');
    }

    const mustAttest = requireAttestation && !!attestationToken;
    let attested: VerifiedAttestation | null = null;
    if (attestationToken) {
      attested = verifyGatewayAttestation(req.headers['x-dc-attestation'], req.headers['x-dc-agent'], attestationToken);
      if (mustAttest && !attested) {
        return sendRpcError(res, 401, null, -32001, 'gateway attestation required');
      }
      if (req.headers['x-dc-attestation'] && !attested) {
        return sendRpcError(res, 400, null, -32001, 'gateway attestation invalid');
      }
      if (attested && !replay.accept(attested.jti, attested.exp)) {
        return sendRpcError(res, 401, null, -32001, 'gateway attestation replayed');
      }
    } else if (requireAttestation) {
      return sendRpcError(res, 401, null, -32001, 'gateway attestation required');
    }

    let body: Json | undefined;
    if (req.method === 'POST') {
      if (!isJsonContentType(headerString(req.headers['content-type']))) {
        return sendRpcError(res, 415, null, -32600, 'Content-Type must be application/json');
      }
      try {
        body = await readJsonBody(req);
      } catch (error) {
        const status = (error as { status?: number }).status ?? 400;
        if (status === 413) return sendRpcError(res, 413, null, -32000, 'Request body too large');
        return sendRpcError(res, 400, null, -32700, 'Parse error');
      }
      if (Array.isArray(body) && hasToolsCall(body)) {
        return sendRpcError(res, 400, null, -32600, 'batched_tools_call_rejected');
      }
      body = attested ? stampGatewayIdentity(body, attested, attestationToken) : stripUntrustedGatewayMeta(body);
    }

    const sid = headerString(req.headers['mcp-session-id']);
    let session = sid ? sessions.get(sid) : undefined;
    if (sid && !session) {
      return sendRpcError(res, 400, null, -32001, 'session unknown; reconnect and re-initialize');
    }
    if (!session) {
      if (req.method === 'POST' && isInitialize(body)) {
        session = makeSession();
      } else {
        return sendRpcError(res, 400, null, -32000, 'Mcp-Session-Id header is required');
      }
    }

    try {
      await session.transport.handleRequest(req, res, body as any);
      if (session.transport.sessionId && !sessions.has(session.transport.sessionId)) {
        sessions.set(session.transport.sessionId, session);
      }
    } catch {
      if (!res.headersSent) {
        sendRpcError(res, 500, null, -32603, 'internal error');
      }
    }
  }

  const httpServer = http.createServer(async (req, res) => {
    const urlPath = req.url ? req.url.split('?')[0] : '/';
    if (urlPath === '/health' || urlPath === '/healthz') {
      return sendJson(res, 200, { ok: true, service: 'jace-commander', transport: 'http', version: JC_MANIFEST.version, manifestHash: JC_MANIFEST.manifestHash });
    }
    if (urlPath === '/authority') {
      const extra = options.authority ? options.authority() : {};
      return sendJson(res, 200, { variant: 'jc-native-http', mode: options.mode, manifestHash: JC_MANIFEST.manifestHash, ...extra });
    }
    if (urlPath === '/ready') {
      return sendJson(res, 200, { ready: true, variant: 'jc-native-http', sessions: sessions.size });
    }
    if (urlPath === '/tools' && req.method === 'GET') {
      return sendJson(res, 200, toolRegistryJson());
    }
    if (urlPath !== '/mcp') {
      return sendJson(res, 404, { error: 'not_found' });
    }
    if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') {
      res.writeHead(405, { Allow: 'GET,POST,DELETE' });
      res.end();
      return;
    }
    await handleMcp(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const close = async () => {
    for (const id of [...sessions.keys()]) closeSession(id);
    const anyServer = httpServer as http.Server & { closeAllConnections?: () => void; closeIdleConnections?: () => void };
    anyServer.closeIdleConnections?.();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    anyServer.closeAllConnections?.();
  };

  const address = httpServer.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return { server: httpServer, close, url: `http://${host}:${actualPort}/mcp` };
}
