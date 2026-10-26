// OAuth client-metadata (CIMD) fetching and redirect-URI rules.
//
// The gateway fetches client metadata documents on behalf of unauthenticated callers, so the
// fetch is an SSRF surface. The address policy is enforced at CONNECTION time: the socket's
// `lookup` hook validates every address the resolver returned, and the connection can only use
// one of those validated addresses. A separate preliminary DNS check would leave a rebinding gap.
import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';

// Non-global IPv4 ranges (IANA special-purpose registry, RFC 6890 and successors).
const NON_GLOBAL_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
// Non-global IPv6 ranges inside 2000::/3 (the only global unicast space). Everything outside it is refused.
const NON_GLOBAL_V6 = [
  ['2001::', 23],      // IETF protocol assignments (includes Teredo)
  ['2001:db8::', 32],  // documentation
  ['2002::', 16],      // 6to4 (embeds an IPv4 address)
  ['3fff::', 20],      // documentation (RFC 9637)
];
const blockV4 = new net.BlockList();
for (const [a, p] of NON_GLOBAL_V4) blockV4.addSubnet(a, p, 'ipv4');
const blockV6 = new net.BlockList();
for (const [a, p] of NON_GLOBAL_V6) blockV6.addSubnet(a, p, 'ipv6');

/** Expand an IPv6 literal (with optional embedded IPv4 tail) into its eight 16-bit groups. */
function ipv6Groups(ip) {
  let s = ip.toLowerCase();
  const lastColon = s.lastIndexOf(':');
  if (s.includes('.', lastColon)) {
    const [a, b, c, d] = s.slice(lastColon + 1).split('.').map(Number);
    s = `${s.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = 8 - h.length - t.length;
  return [...h, ...Array(fill).fill('0'), ...t].map((g) => parseInt(g, 16));
}

/**
 * True only for addresses that are globally routable unicast. Unknown or malformed input is
 * non-global (fail closed). IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) IPv6 forms are judged by
 * their embedded IPv4 address, so `::ffff:127.0.0.1` and `::ffff:7f00:1` are both refused.
 */
export function isGlobalAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return !blockV4.check(ip, 'ipv4');
  if (family !== 6) return false;
  const g = ipv6Groups(ip);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isGlobalAddress(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  if (g.slice(0, 6).every((x) => x === 0)) return false;     // ::/96 (includes ::1 and ::)
  if ((g[0] & 0xe000) !== 0x2000) return false;               // outside 2000::/3
  return !blockV6.check(ip, 'ipv6');
}

/**
 * DNS `lookup` replacement for the metadata connection. Every address returned is checked; if any is
 * non-global the connection is refused. Only validated addresses can be connected to.
 */
export function publicLookup(resolve = dns.lookup) {
  return (hostname, options, callback) => {
    const wantAll = typeof options === 'object' && options !== null && options.all === true;
    resolve(hostname, { all: true, verbatim: true }).then((addresses) => {
      if (!Array.isArray(addresses) || addresses.length === 0) return callback(new Error('metadata host did not resolve'));
      if (addresses.some((a) => !isGlobalAddress(a.address))) return callback(new Error('metadata host resolves to a non-public address'));
      if (wantAll) return callback(null, addresses.map((a) => ({ address: a.address, family: a.family })));
      callback(null, addresses[0].address, addresses[0].family);
    }, (err) => callback(err));
  };
}

/** Redirect URIs a client may register: https, or http on a loopback literal host (RFC 8252). No fragments or userinfo. */
export function isAllowedRedirectUri(uri) {
  if (typeof uri !== 'string' || uri.length > 2048) return false;
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
}

/** Loopback callbacks (any port) are the only redirect URIs whose port may differ from the registered one. */
export function isLoopbackRedirectUri(uri) {
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch { return false; }
}

/**
 * RFC 8252 section 7.3: a loopback redirect may use any port, but only on the same host and path as a
 * registered loopback redirect, including its query. Fragments and userinfo are forbidden.
 */
export function matchesRegisteredLoopback(redirectUri, registeredUris = []) {
  let u;
  try { u = new URL(redirectUri); } catch { return false; }
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return false;
  if (u.hash || u.username || u.password) return false;
  return registeredUris.some((registered) => {
    try {
      const r = new URL(registered);
      return r.protocol === 'http:' && r.hostname === u.hostname && r.pathname === u.pathname &&
        r.search === u.search && !r.hash && !r.username && !r.password;
    } catch { return false; }
  });
}

/** Validate a CIMD document against the client_id it was fetched for. Public clients only (no secret). */
export function parseClientMetadata(clientId, doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('client metadata must be a JSON object');
  if (doc.client_id !== clientId) throw new Error('client metadata client_id does not match its URL');
  const uris = doc.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 20 || !uris.every(isAllowedRedirectUri)) {
    throw new Error('client metadata redirect_uris must be a non-empty list of allowed URIs');
  }
  const method = doc.token_endpoint_auth_method === undefined ? 'none' : doc.token_endpoint_auth_method;
  if (method !== 'none') throw new Error('client metadata must be a public client (token_endpoint_auth_method none)');
  const grants = doc.grant_types === undefined ? ['authorization_code'] : doc.grant_types;
  if (!Array.isArray(grants) || !grants.every((g) => g === 'authorization_code' || g === 'refresh_token')) {
    throw new Error('client metadata grant_types unsupported');
  }
  return { redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: grants };
}

/** Parse a CIMD URL and reject everything that can be decided without touching the network. */
export function parseMetadataUrl(clientId) {
  let u;
  try { u = new URL(clientId); } catch { throw new Error('client metadata URL is malformed'); }
  if (u.protocol !== 'https:') throw new Error('client metadata must be https');
  if (u.username || u.password) throw new Error('client metadata URL must not carry userinfo');
  if (u.hash) throw new Error('client metadata URL must not carry a fragment');
  if (u.port && u.port !== '443') throw new Error('client metadata must use the default https port');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) throw new Error('client metadata host is not public');
  if (net.isIP(host) && !isGlobalAddress(host)) throw new Error('client metadata host is a non-public address');
  return u;
}

/**
 * Fetch and validate a CIMD document. Never follows redirects, never uses proxies or pooled sockets, and
 * enforces a timeout and a byte cap. `lookup` and `tlsOptions` are injection points for tests only.
 */
export function fetchClientMetadata(clientId, options = {}) {
  // `port` and `tlsOptions` exist only so tests can reach a local TLS server; production always uses 443.
  const { lookup = publicLookup(), timeoutMs = 5000, maxBytes = 64 * 1024, port, tlsOptions = {} } = options;
  return new Promise((resolve, reject) => {
    let u;
    try { u = parseMetadataUrl(clientId); } catch (err) { return reject(err); }
    const req = https.request({
      ...tlsOptions,
      method: 'GET',
      protocol: 'https:',
      hostname: u.hostname,
      port: port ?? (u.port || 443),
      path: `${u.pathname}${u.search}`,
      agent: false,               // no pooled sockets, no global agent
      lookup,                     // the connection-time address policy
      headers: { accept: 'application/json' },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`client metadata HTTP ${res.statusCode}`)); }
      const type = String(res.headers['content-type'] || '');
      if (!/^application\/json(\s*;|$)/i.test(type)) { res.resume(); return reject(new Error('client metadata content-type must be application/json')); }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) { res.resume(); return reject(new Error('client metadata too large')); }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) return req.destroy(new Error('client metadata too large'));
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          resolve(parseClientMetadata(clientId, JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        } catch (err) { reject(err); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('client metadata fetch timed out')));
    req.on('error', reject);
    req.end();
  });
}
