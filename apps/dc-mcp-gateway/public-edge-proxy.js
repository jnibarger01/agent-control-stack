import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { allowedPublicRoute } from './public-edge-policy.js';

const HOP_HEADERS = new Set([
  'connection', 'proxy-connection', 'proxy-authorization', 'keep-alive',
  'upgrade', 'transfer-encoding', 'te', 'trailer', 'host'
]);
const filtered = (headers) => Object.fromEntries(
  Object.entries(headers).filter(([k]) => !HOP_HEADERS.has(k.toLowerCase()) &&
    !k.toLowerCase().startsWith('x-forwarded-'))
);
const failure = (res, status) => {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(status === 404 ? 'Not found' : 'Bad gateway');
};
const consume = (req, maxBytes) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > maxBytes) {
      reject(Object.assign(new Error('body too large'), { status: 413 }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
  req.on('aborted', () => reject(new Error('request aborted')));
});
export function createPublicIngress({ upstreamPort = 8010, jcResource }) {
  if (!/^https:\/\/[^\s]+\/jc\/mcp$/.test(jcResource || '')) throw new Error('JC_RESOURCE required');
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535)
    throw new Error('invalid upstream port');
  return http.createServer(async (req, res) => {
    const consent = req.url?.split('?')[0] === '/authorize/consent' && req.method === 'POST';
    let body = null;
    if (consent) {
      try { body = await consume(req, 65536); }
      catch (err) { if (!res.destroyed) failure(res, err.status || 400); return; }
    }
    if (!allowedPublicRoute(req.method, req.url, consent ? body.toString('utf8') : '', jcResource)) {
      failure(res, 404);
      // Drain non-consent request, so keepalive connections cannot carry unread data.
      if (!consent) req.resume();
      return;
    }
    const headers = filtered(req.headers);
    if (consent) headers['content-length'] = String(body.length);
    const upstream = http.request({
      hostname: '127.0.0.1', port: upstreamPort, path: req.url,
      method: req.method, headers
    }, (upRes) => {
      res.writeHead(upRes.statusCode || 502, filtered(upRes.headers));
      upRes.pipe(res);
    });
    upstream.on('error', () => failure(res, 502));
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    if (consent) upstream.end(body);
    else req.pipe(upstream);
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PUBLIC_INGRESS_PORT || 8011);
  const upstreamPort = Number(process.env.GATEWAY_PORT || 8010);
  const server = createPublicIngress({ upstreamPort, jcResource: process.env.JC_RESOURCE });
  server.listen(port, '127.0.0.1', () => console.log('public JC ingress listening on loopback:' + port));
}
