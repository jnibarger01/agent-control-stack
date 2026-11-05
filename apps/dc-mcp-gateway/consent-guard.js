import crypto from 'node:crypto';
import net from 'node:net';

// Owner secret that gates the consent form. Strength is checked at startup.
// The guess string is not measured here.
export const CONSENT_PASSPHRASE_MIN_LENGTH = 16;
export const CONSENT_PASSPHRASE_MAX_LENGTH = 256;
export const CONSENT_SOURCE_MAX_FAILURES = 5;
export const CONSENT_CLIENT_MAX_FAILURES = 5;
export const CONSENT_GLOBAL_MAX_FAILURES = 20;
export const CONSENT_LOCKOUT_MS = 15 * 60 * 1000;
export const CONSENT_TRACK_CAP = 1024;
// Minimum shortening allowed under EDGE_TEST_MODE. Zero is not a duration.
export const CONSENT_LOCKOUT_TEST_FLOOR_MS = 50;
// Stamped by the public ingress from the socket it accepted. Not a forwarded header.
export const INGRESS_CLIENT_HEADER = 'x-jc-ingress-client';

function hasWhitespaceOrControl(value) {
  if (/\s/.test(value)) return true;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function passphraseStrengthError(value) {
  if (typeof value !== 'string' || value.length < CONSENT_PASSPHRASE_MIN_LENGTH) {
    return `CONSENT_PASSPHRASE must be at least ${CONSENT_PASSPHRASE_MIN_LENGTH} characters`;
  }
  if (value.length > CONSENT_PASSPHRASE_MAX_LENGTH) {
    return `CONSENT_PASSPHRASE must be at most ${CONSENT_PASSPHRASE_MAX_LENGTH} characters`;
  }
  if (hasWhitespaceOrControl(value)) {
    return 'CONSENT_PASSPHRASE must not contain whitespace or control characters';
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  if (classes < 2) {
    return 'CONSENT_PASSPHRASE must mix at least two of lowercase, uppercase, digits, and symbols';
  }
  if (new Set(value).size < 4) {
    return 'CONSENT_PASSPHRASE must contain at least 4 distinct characters';
  }
  return null;
}

// Test mode may shorten the lock. It cannot disable it, and production ignores the override.
export function resolveConsentLockoutMs({ testMode, raw, fallback = CONSENT_LOCKOUT_MS } = {}) {
  if (!testMode) return fallback;
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < CONSENT_LOCKOUT_TEST_FLOOR_MS) return fallback;
  return Math.min(parsed, fallback);
}

export function normalizeIp(value) {
  if (typeof value !== 'string') return null;
  let ip = value.trim().toLowerCase();
  if (ip.length === 0 || ip.length > 64) return null;
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice('::ffff:'.length);
    if (net.isIP(mapped) === 4) ip = mapped;
  }
  if (net.isIP(ip) === 0) return null;
  return ip;
}

export function isLoopbackAddress(value) {
  const ip = normalizeIp(value);
  return ip === '127.0.0.1' || ip === '::1';
}

// Identity for the attempt budget. Forwarded, X-Forwarded-For, and X-Real-IP
// are ignored. The ingress header counts only from a loopback peer, and only
// when it is a single IP (duplicates and lists fall back to the peer).
export function consentSource(remoteAddress, headers) {
  const peer = normalizeIp(remoteAddress) || 'unknown';
  const header = headers ? headers[INGRESS_CLIENT_HEADER] : undefined;
  if (isLoopbackAddress(peer) && typeof header === 'string') {
    const stamped = normalizeIp(header);
    if (stamped) return { kind: 'ingress', id: stamped };
  }
  return { kind: 'peer', id: peer };
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function consentSourceKey(source) {
  return digest(`${source.kind}:${source.id}`);
}

export function consentSourceLabel(source) {
  return `${source.kind}:${consentSourceKey(source).slice(0, 12)}`;
}

export function consentClientKey(clientId) {
  return digest(String(clientId));
}

export function createConsentLimiter(options = {}) {
  const sourceMax = options.sourceMax ?? CONSENT_SOURCE_MAX_FAILURES;
  const clientMax = options.clientMax ?? CONSENT_CLIENT_MAX_FAILURES;
  const globalMax = options.globalMax ?? CONSENT_GLOBAL_MAX_FAILURES;
  const lockoutMs = options.lockoutMs ?? CONSENT_LOCKOUT_MS;
  const cap = options.cap ?? CONSENT_TRACK_CAP;
  const now = options.now ?? (() => Date.now());
  if (!Number.isFinite(lockoutMs) || lockoutMs < 1) throw new Error('consent lockout duration must be positive');
  for (const budget of [sourceMax, clientMax, globalMax, cap]) {
    if (!Number.isInteger(budget) || budget < 1) throw new Error('consent failure budget must be positive');
  }
  const sources = new Map();
  const clients = new Map();
  let globalBucket = blank(now());

  function blank(t) {
    return { failures: 0, windowStartMs: t, lockedUntilMs: 0 };
  }

  function current(bucket, t) {
    if (bucket.lockedUntilMs > t) return bucket;
    if (bucket.lockedUntilMs > 0 || t - bucket.windowStartMs >= lockoutMs) return blank(t);
    return bucket;
  }

  function retryAfter(bucket, t) {
    return bucket.lockedUntilMs > t ? Math.max(1, Math.ceil((bucket.lockedUntilMs - t) / 1000)) : 0;
  }

  function read(map, key, t) {
    const existing = map.get(key);
    if (!existing) return blank(t);
    const next = current(existing, t);
    if (next !== existing) map.set(key, next);
    return next;
  }

  function sweep() {
    const t = now();
    for (const map of [sources, clients]) {
      for (const [key, bucket] of map) {
        const next = current(bucket, t);
        if (next.failures === 0 && next.lockedUntilMs === 0) map.delete(key);
        else if (next !== bucket) map.set(key, next);
      }
    }
    globalBucket = current(globalBucket, t);
  }

  function snapshot({ sourceKey, clientKey = null }) {
    sweep();
    const t = now();
    const source = read(sources, sourceKey, t);
    const client = clientKey ? read(clients, clientKey, t) : null;
    const saturated = (!sources.has(sourceKey) && sources.size >= cap)
      || Boolean(clientKey && !clients.has(clientKey) && clients.size >= cap);
    const retryAfterSec = Math.max(
      retryAfter(source, t),
      client ? retryAfter(client, t) : 0,
      retryAfter(globalBucket, t),
      saturated ? Math.max(1, Math.ceil(lockoutMs / 1000)) : 0,
    );
    return {
      locked: retryAfterSec > 0,
      retryAfterSec,
      saturated,
      sourceLocked: source.lockedUntilMs > t,
      clientLocked: Boolean(client && client.lockedUntilMs > t),
      globalLocked: globalBucket.lockedUntilMs > t,
    };
  }

  function bump(map, key, max, t) {
    if (!map.has(key)) {
      if (map.size >= cap) return true;
      map.set(key, blank(t));
    }
    const bucket = read(map, key, t);
    bucket.failures += 1;
    if (bucket.failures >= max) bucket.lockedUntilMs = t + lockoutMs;
    return false;
  }

  // Already-locked buckets are not extended. A full tracker fails closed
  // instead of evicting another principal.
  function recordFailure({ sourceKey, clientKey = null }) {
    const before = snapshot({ sourceKey, clientKey });
    if (before.locked) return before;
    const t = now();
    bump(sources, sourceKey, sourceMax, t);
    if (clientKey) bump(clients, clientKey, clientMax, t);
    globalBucket = current(globalBucket, t);
    globalBucket.failures += 1;
    if (globalBucket.failures >= globalMax) globalBucket.lockedUntilMs = t + lockoutMs;
    return snapshot({ sourceKey, clientKey });
  }

  return { snapshot, recordFailure, sweep };
}
