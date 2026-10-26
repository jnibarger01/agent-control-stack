// Guards for OAuth client metadata (CIMD) fetches and loopback redirect matching.
// Kept dependency-free so the rules are unit-testable without starting the gateway.
import dns from 'node:dns/promises';
import net from 'node:net';

// Addresses a server-side fetch must never reach: loopback, private, link-local,
// CGNAT, multicast/reserved, and IPv4-mapped IPv6 (conservatively all blocked).
export function isNonPublicAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    return v === '::' || v === '::1' || v.startsWith('::ffff:') ||
      /^f[cd]/.test(v) ||            // unique local fc00::/7
      /^fe[89ab]/.test(v) ||         // link-local fe80::/10
      v.startsWith('ff');            // multicast
  }
  return true; // not an IP literal we understand: refuse
}

// Throws unless the URL is https, credential-free, and every resolved address is public.
// DNS is resolved here before fetch; a rebinding race between this check and the
// connect is not closed by this function alone.
export async function assertPublicHttpsUrl(rawUrl) {
  const u = new URL(rawUrl);
  if (u.protocol !== 'https:') throw new Error('client metadata must be https');
  if (u.username || u.password) throw new Error('client metadata URL must not carry credentials');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) throw new Error('client metadata host is not public');
  const addresses = net.isIP(host)
    ? [{ address: host }]
    : await dns.lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((a) => isNonPublicAddress(a.address))) {
    throw new Error('client metadata host resolves to a non-public address');
  }
  return u;
}

// RFC 8252 §7.3: a native client may use any port on the loopback host it registered,
// but only on the same host and path. Any other loopback callback is rejected.
export function matchesRegisteredLoopback(redirectUri, registeredUris = []) {
  let u;
  try { u = new URL(redirectUri); } catch { return false; }
  if (u.protocol !== 'http:' || (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost')) return false;
  if (u.search || u.hash || u.username || u.password) return false;
  return registeredUris.some((registered) => {
    try {
      const r = new URL(registered);
      return r.protocol === 'http:' && r.hostname === u.hostname && r.pathname === u.pathname;
    } catch { return false; }
  });
}
