// Default-deny route policy for the public HTTPS edge (Jace Commander lane only).
//
// Reviewed design: the original public-edge-policy.js allowlist, with these changes:
//  - the request Host must equal the configured public host (no other virtual host is served);
//  - a known path with the wrong method is 405 (with Allow), an unknown path is 404; both are denials;
//  - /jc/mcp takes no query string, and every route is matched on the raw, unnormalized path;
//  - the consent POST is bounded like every other body-carrying route (enforced by the ingress).
//
// Decisions are pure functions of (method, url, host, body). Nothing here opens a socket.

const DISCOVERY = Object.freeze({
  '/.well-known/oauth-protected-resource/jc/mcp': 'GET',
  '/.well-known/oauth-authorization-server/jc': 'GET',
  '/jc/.well-known/oauth-authorization-server': 'GET',
  '/jc/.well-known/openid-configuration': 'GET',
});

// Each route: the methods it accepts, and whether it requires oauth_lane=jc and resource=<jcResource> in the query.
const OAUTH_LANE_ROUTES = Object.freeze({
  '/authorize': { methods: ['GET'] },
  '/token': { methods: ['POST'] },
  '/register': { methods: ['POST'] },
});

const MCP_METHODS = Object.freeze(['GET', 'POST', 'DELETE']);

function singleParam(params, key) {
  const values = params.getAll(key);
  return values.length === 1 ? values[0] : null;
}

/** Raw-path sanity: ASCII only, no percent-encoding, no dot segments, no duplicate slashes, no fragments or backslashes. */
function rawPathOk(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/')) return false;
  if (/[\x00-\x20\x7f]/.test(rawUrl) || rawUrl.includes('#') || rawUrl.includes('\\')) return false;
  const pathname = rawUrl.split('?')[0];
  if (!/^\/[A-Za-z0-9/._-]+$/.test(pathname)) return false;
  if (pathname.includes('//') || pathname.includes('/./') || pathname.includes('/../')) return false;
  if (pathname.endsWith('/.') || pathname.endsWith('/..')) return false;
  return true;
}

/**
 * Decide whether a request may reach the gateway.
 * @returns {{allow: true, path: string, bodyLimit: number}|{allow: false, status: 404|405, allow_methods?: string}}
 */
export function decideRoute({ method, url, host, publicHost, jcResource, bodyLimitBytes = 64 * 1024 }) {
  const deny = (status, allowMethods) => ({ allow: false, status, ...(allowMethods ? { allow_methods: allowMethods } : {}) });
  if (typeof publicHost !== 'string' || !publicHost) return deny(404);
  if (host !== publicHost) return deny(404);                      // exact Host match, no other vhosts
  if (!rawPathOk(url)) return deny(404);
  const pathname = url.split('?')[0];
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  let params;
  try { params = new URLSearchParams(query); } catch { return deny(404); }
  const hasQuery = url.includes('?');

  if (Object.hasOwn(DISCOVERY, pathname)) {
    if (method !== DISCOVERY[pathname]) return deny(405, DISCOVERY[pathname]);
    return hasQuery ? deny(404) : { allow: true, path: url, bodyLimit: 0 };
  }

  if (pathname === '/jc/mcp') {
    if (!MCP_METHODS.includes(method)) return deny(405, MCP_METHODS.join(', '));
    return hasQuery ? deny(404) : { allow: true, path: url, bodyLimit: bodyLimitBytes };
  }

  if (pathname === '/authorize/consent') {
    if (method !== 'POST') return deny(405, 'POST');
    if (hasQuery) return deny(404);
    // The body is checked by the ingress (size) and by bodyResourceMatches (resource). Here we only admit the route.
    return { allow: true, path: url, bodyLimit: bodyLimitBytes, requiresResourceBody: jcResource };
  }

  if (Object.hasOwn(OAUTH_LANE_ROUTES, pathname)) {
    const route = OAUTH_LANE_ROUTES[pathname];
    if (!route.methods.includes(method)) return deny(405, route.methods.join(', '));
    if (!hasQuery) return deny(404);
    if (singleParam(params, 'oauth_lane') !== 'jc') return deny(404);
    if (singleParam(params, 'resource') !== jcResource) return deny(404);
    return { allow: true, path: url, bodyLimit: pathname === '/authorize' ? 0 : bodyLimitBytes };
  }

  return deny(404);
}

/**
 * For the consent POST: the form body must name the same JC resource as the configured lane, exactly once.
 * The gateway re-validates everything; this only keeps a non-lane request from reaching it.
 */
export function bodyResourceMatches(body, jcResource) {
  if (typeof body !== 'string') return false;
  const values = new URLSearchParams(body).getAll('resource');
  return values.length === 1 && values[0] === jcResource;
}
