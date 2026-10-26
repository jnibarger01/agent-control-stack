// Public HTTPS ingress policy. This must run in front of the OAuth gateway,
// not be implemented as a broad "/" Tailscale Funnel reverse proxy.
const discovery = new Set([
  '/.well-known/oauth-protected-resource/jc/mcp',
  '/.well-known/oauth-authorization-server/jc',
  '/jc/.well-known/oauth-authorization-server',
  '/jc/.well-known/openid-configuration'
]);
function unique(params, key) {
  const values = params.getAll(key);
  return values.length === 1 ? values[0] : null;
}
export function allowedPublicRoute(method, rawUrl, body = '', jcResource) {
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/') ||
      rawUrl.includes('#') || rawUrl.includes('\\') ||
      /[\x00-\x20\x7f]/.test(rawUrl) || /%0[ad]/i.test(rawUrl) ||
      /%(?![0-9a-f]{2})/i.test(rawUrl)) return false;
  const pathname = rawUrl.split('?')[0];
  // Compare raw paths, never decoded or normalized equivalents.
  if (!/^\/[A-Za-z0-9/._-]+$/.test(pathname) ||
      pathname.includes('//') || pathname.includes('/./') ||
      pathname.includes('/../') || pathname.endsWith('/.') ||
      pathname.endsWith('/..')) return false;
  let params;
  try { params = new URL(rawUrl, 'http://127.0.0.1').searchParams; }
  catch { return false; }
  if (method === 'GET' && discovery.has(pathname) && params.size === 0) return true;
  if (pathname === '/jc/mcp') return ['GET', 'POST', 'DELETE'].includes(method);
  if (method === 'POST' && pathname === '/authorize/consent') {
    if (params.size !== 0 || typeof body !== 'string' || body.length > 65536) return false;
    const form = new URLSearchParams(body);
    return unique(form, 'resource') === jcResource;
  }
  if (method === 'GET' && pathname === '/authorize' ||
      method === 'POST' && (pathname === '/token' || pathname === '/register')) {
    return unique(params, 'oauth_lane') === 'jc' &&
      unique(params, 'resource') === jcResource;
  }
  return false;
}
