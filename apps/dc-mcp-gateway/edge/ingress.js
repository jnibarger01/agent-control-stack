// Public HTTPS ingress for the Jace Commander lane. Reviewed design of public-edge-proxy.js, hardened:
//  - every route is decided by edge/policy.js BEFORE any upstream socket is opened (default deny);
//  - request bodies are buffered under a per-route cap (413 when exceeded), for every body-carrying route;
//  - inbound identity and forwarding headers are stripped (x-dc-*, x-acs-*, x-forwarded-*, forwarded, x-real-ip,
//    and hop-by-hop headers), so a client can never present gateway- or ACS-trusted metadata;
//  - header, request and upstream timeouts bound slow clients and hung upstreams.
// Listens on loopback only. A TLS-terminating proxy (Tailscale Serve/Funnel) is the only thing that reaches it.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { bodyResourceMatches, decideRoute } from './policy.js';

const HOP_HEADERS = new Set([
  'connection', 'proxy-connection', 'proxy-authorization', 'keep-alive', 'upgrade', 'transfer-encoding', 'te', 'trailer', 'host',
]);
const STRIP_PREFIXES = ['x-dc-', 'x-acs-', 'x-forwarded-'];
const STRIP_EXACT = new Set(['forwarded', 'x-real-ip', 'via']);

/** Headers the gateway must never receive from the public side. */
export function forwardableHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_HEADERS.has(lower) || STRIP_EXACT.has(lower) || STRIP_PREFIXES.some((p) => lower.startsWith(p))) continue;
    out[lower] = value;
  }
  return out;
}

function reply(res, status, extraHeaders = {}) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders });
  res.end(status === 404 ? 'Not found' : status === 405 ? 'Method not allowed' : status === 413 ? 'Payload too large' : status === 504 ? 'Gateway timeout' : 'Bad gateway');
}

/** Read the whole body up to `limit` bytes. Rejects with status 413 when the limit is exceeded. */
function readBounded(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // Stop buffering (memory stays bounded) but do not destroy the socket: the 413 must reach the client.
        chunks.length = 0;
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(Object.assign(err, { status: 400 })));
  });
}

export function createIngress({
  publicHost,
  jcResource,
  upstreamPort,
  upstreamHost = '127.0.0.1',
  upstreamTimeoutMs = 120_000,
  headersTimeoutMs = 10_000,
  requestTimeoutMs = 60_000,
  keepAliveTimeoutMs = 5_000,
} = {}) {
  if (typeof publicHost !== 'string' || !/^[a-z0-9.-]+$/.test(publicHost)) throw new Error('publicHost must be a bare lowercase hostname');
  if (jcResource !== `https://${publicHost}/jc/mcp`) throw new Error('jcResource must equal https://<publicHost>/jc/mcp');
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) throw new Error('invalid upstream port');
  if (upstreamHost !== '127.0.0.1' && upstreamHost !== 'localhost') throw new Error('upstream must be loopback');

  const server = http.createServer(async (req, res) => {
    const decision = decideRoute({
      method: req.method, url: req.url, host: String(req.headers.host || '').toLowerCase(), publicHost, jcResource,
    });
    if (!decision.allow) {
      // Drain nothing and connect nowhere: a denied request has no upstream side effect.
      req.resume();
      return reply(res, decision.status, decision.allow_methods ? { allow: decision.allow_methods } : {});
    }

    let body;
    try {
      body = decision.bodyLimit > 0 && req.method !== 'GET' && req.method !== 'HEAD'
        ? await readBounded(req, decision.bodyLimit)
        : null;
    } catch (err) {
      return reply(res, err.status || 400, { connection: 'close' });
    }
    if (decision.requiresResourceBody !== undefined && !bodyResourceMatches(body ? body.toString('utf8') : '', jcResource)) {
      return reply(res, 404);
    }

    const headers = forwardableHeaders(req.headers);
    if (body) headers['content-length'] = String(body.length);
    const upstream = http.request({
      hostname: upstreamHost, port: upstreamPort, path: decision.path, method: req.method, headers, timeout: upstreamTimeoutMs,
    }, (upRes) => {
      const outHeaders = forwardableHeaders(upRes.headers);
      res.writeHead(upRes.statusCode || 502, outHeaders);
      upRes.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', () => reply(res, 502));
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    if (body) upstream.end(body);
    else upstream.end();
  });

  server.headersTimeout = headersTimeoutMs;
  server.requestTimeout = requestTimeoutMs;
  server.keepAliveTimeout = keepAliveTimeoutMs;
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const env = process.env;
  const publicHost = env.JC_PUBLIC_HOST || '';
  const server = createIngress({
    publicHost,
    jcResource: env.JC_RESOURCE,
    upstreamPort: Number(env.GATEWAY_PORT || 8010),
  });
  const port = Number(env.PUBLIC_INGRESS_PORT || 8011);
  server.listen(port, '127.0.0.1', () => console.log(`jace-commander edge listening on 127.0.0.1:${port}`));
}
