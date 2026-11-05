import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { saveJson } from './atomic-json.js';

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
// Stamped by the authenticated public ingress from the socket it accepted.
export const INGRESS_CLIENT_HEADER = 'x-jc-ingress-client';
export const INGRESS_PROOF_HEADER = 'x-jc-ingress-proof';
export const INGRESS_IDENTITY_PREFIX = 'jc-ingress-v1:';
// A client that presents any of these is claiming an identity the gateway did not accept.
export const SPOOFED_FORWARDED_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip'];
const STORE_MAX_BYTES = 256 * 1024;
const HEX_KEY = /^[0-9a-f]{64}$/;

export class ConsentStoreUnavailable extends Error {
  constructor(reason) {
    super('consent lockout store unavailable');
    this.name = 'ConsentStoreUnavailable';
    this.reason = reason;
  }
}

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

export function assertIngressIdentityKey(value) {
  if (typeof value !== 'string' || value.length < 32 || hasWhitespaceOrControl(value)) {
    throw new Error('JC_INGRESS_IDENTITY_KEY must be at least 32 characters without whitespace or control characters');
  }
}

export function ingressIdentityProof(ip, identityKey) {
  assertIngressIdentityKey(identityKey);
  const normalized = normalizeIp(ip);
  if (!normalized) throw new Error('ingress client address must be one IP');
  return crypto.createHmac('sha256', identityKey).update(`${INGRESS_IDENTITY_PREFIX}${normalized}`).digest('hex');
}

export function stampIngressIdentity(ip, identityKey) {
  const normalized = normalizeIp(ip);
  return {
    [INGRESS_CLIENT_HEADER]: normalized,
    [INGRESS_PROOF_HEADER]: ingressIdentityProof(normalized, identityKey),
  };
}

function headerMap(headers) {
  const out = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) out[String(key).toLowerCase()] = value;
  return out;
}

function singleHeader(map, name) {
  if (!Object.prototype.hasOwnProperty.call(map, name)) return null;
  const value = map[name];
  if (typeof value !== 'string' || value.length === 0 || value.includes(',')) return { spoof: true };
  return { value };
}

function proofMatches(ip, proof, identityKey) {
  try { assertIngressIdentityKey(identityKey); } catch { return false; }
  const given = String(proof).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  const expected = ingressIdentityProof(ip, identityKey);
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(given, 'hex'));
}

// Identity is the TCP peer, unless the loopback peer presents a proof from the
// ingress key. Forwarded headers and an unproven stamp are rejected. They are
// not silently ignored, and they are not used as the identity.
export function consentSource(remoteAddress, headers, options = {}) {
  const peer = normalizeIp(remoteAddress) || 'unknown';
  const map = headerMap(headers);
  const presented = [
    ...SPOOFED_FORWARDED_HEADERS,
    INGRESS_CLIENT_HEADER,
    INGRESS_PROOF_HEADER,
  ].some((name) => Object.prototype.hasOwnProperty.call(map, name));
  if (!presented) return { ok: true, source: { kind: 'peer', id: peer } };

  const forwarded = SPOOFED_FORWARDED_HEADERS.some((name) => Object.prototype.hasOwnProperty.call(map, name));
  const client = singleHeader(map, INGRESS_CLIENT_HEADER);
  const proof = singleHeader(map, INGRESS_PROOF_HEADER);
  const ip = client && !client.spoof ? normalizeIp(client.value) : null;
  const authentic = !forwarded
    && client && !client.spoof
    && proof && !proof.spoof
    && ip
    && isLoopbackAddress(peer)
    && proofMatches(ip, proof.value, options.identityKey);
  if (!authentic) return { ok: false, reason: 'spoofed_identity', peer };
  return { ok: true, source: { kind: 'ingress', id: ip } };
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

function blank(t) {
  return { failures: 0, windowStartMs: t, lockedUntilMs: 0 };
}

function freshState(t) {
  return {
    version: 1,
    global: blank(t),
    sourceOverflow: blank(t),
    clientOverflow: blank(t),
    sources: {},
    clients: {},
  };
}

function isBucket(value) {
  return Boolean(value)
    && Number.isInteger(value.failures) && value.failures >= 0 && value.failures <= 1_000_000
    && Number.isInteger(value.windowStartMs)
    && Number.isInteger(value.lockedUntilMs);
}

function currentBucket(entry, t, lockoutMs) {
  if (entry.lockedUntilMs > t) return entry;
  if (entry.lockedUntilMs > 0 || t - entry.windowStartMs >= lockoutMs) return blank(t);
  return entry;
}

function retryAfter(entry, t) {
  return entry.lockedUntilMs > t ? Math.max(1, Math.ceil((entry.lockedUntilMs - t) / 1000)) : 0;
}

function sweepState(state, t, lockoutMs) {
  for (const name of ['sources', 'clients']) {
    for (const [key, entry] of Object.entries(state[name])) {
      const next = currentBucket(entry, t, lockoutMs);
      if (next.failures === 0 && next.lockedUntilMs === 0) delete state[name][key];
      else state[name][key] = next;
    }
  }
  state.global = currentBucket(state.global, t, lockoutMs);
  state.sourceOverflow = currentBucket(state.sourceOverflow, t, lockoutMs);
  state.clientOverflow = currentBucket(state.clientOverflow, t, lockoutMs);
}

function view(state, { sourceKey, clientKey = null }, t, lockoutMs, cap) {
  sweepState(state, t, lockoutMs);
  const source = state.sources[sourceKey] || null;
  const client = clientKey ? state.clients[clientKey] || null : null;
  const sourceUntracked = !source;
  const clientUntracked = Boolean(clientKey) && !client;
  const sourceFull = sourceUntracked && Object.keys(state.sources).length >= cap;
  const clientFull = clientUntracked && Object.keys(state.clients).length >= cap;
  const overflowLocked = (sourceUntracked && state.sourceOverflow.lockedUntilMs > t)
    || (clientUntracked && state.clientOverflow.lockedUntilMs > t);
  const saturated = sourceFull || clientFull || overflowLocked;
  const sourceLocked = Boolean(source && source.lockedUntilMs > t);
  const clientLocked = Boolean(client && client.lockedUntilMs > t);
  const globalLocked = state.global.lockedUntilMs > t;
  const retryAfterSec = Math.max(
    source ? retryAfter(source, t) : 0,
    client ? retryAfter(client, t) : 0,
    retryAfter(state.global, t),
    sourceUntracked ? retryAfter(state.sourceOverflow, t) : 0,
    clientKey && clientUntracked ? retryAfter(state.clientOverflow, t) : 0,
    saturated ? Math.max(1, Math.ceil(lockoutMs / 1000)) : 0,
  );
  return {
    locked: retryAfterSec > 0,
    retryAfterSec,
    saturated,
    sourceLocked,
    clientLocked,
    globalLocked,
    overflowLocked,
  };
}

function arm(entry, max, t, lockoutMs) {
  entry.failures += 1;
  if (entry.failures >= max && entry.lockedUntilMs <= t) entry.lockedUntilMs = t + lockoutMs;
}

// A new key past the cap counts on the overflow bucket. It is not inserted, so
// it cannot grow the table, and it cannot start a fresh budget of its own.
function bump(map, overflow, key, max, t, lockoutMs, cap) {
  if (!map[key]) {
    if (Object.keys(map).length >= cap) {
      arm(overflow, max, t, lockoutMs);
      return;
    }
    map[key] = blank(t);
  }
  arm(map[key], max, t, lockoutMs);
}

function record(state, { sourceKey, clientKey = null }, t, options) {
  const { sourceMax, clientMax, globalMax, lockoutMs, cap } = options;
  const before = view(state, { sourceKey, clientKey }, t, lockoutMs, cap);
  const durable = before.sourceLocked || before.clientLocked || before.globalLocked || before.overflowLocked;
  if (before.locked && durable) return before;
  bump(state.sources, state.sourceOverflow, sourceKey, sourceMax, t, lockoutMs, cap);
  if (clientKey) bump(state.clients, state.clientOverflow, clientKey, clientMax, t, lockoutMs, cap);
  arm(state.global, globalMax, t, lockoutMs);
  return view(state, { sourceKey, clientKey }, t, lockoutMs, cap);
}

function validateMap(map, cap) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return false;
  const keys = Object.keys(map);
  if (keys.length > cap) return false;
  return keys.every((key) => HEX_KEY.test(key) && isBucket(map[key]));
}

function loadState(filePath, cap, t) {
  let stat;
  try { stat = fs.lstatSync(filePath); } catch (error) {
    if (error.code === 'ENOENT') return freshState(t);
    throw new ConsentStoreUnavailable('unreadable');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > STORE_MAX_BYTES) {
    throw new ConsentStoreUnavailable('unreadable');
  }
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch {
    throw new ConsentStoreUnavailable('corrupt');
  }
  if (!parsed || parsed.version !== 1
    || !isBucket(parsed.global) || !isBucket(parsed.sourceOverflow) || !isBucket(parsed.clientOverflow)
    || !validateMap(parsed.sources, cap) || !validateMap(parsed.clients, cap)) {
    throw new ConsentStoreUnavailable('corrupt');
  }
  return parsed;
}

function lockAge(lockPath) {
  try { return Date.now() - fs.statSync(lockPath).mtimeMs; } catch { return 0; }
}

function ownerAlive(lockPath) {
  let owner;
  try { owner = Number(fs.readFileSync(path.join(lockPath, 'owner'), 'utf8')); } catch { return false; }
  if (!Number.isInteger(owner) || owner <= 0) return false;
  try {
    process.kill(owner, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function acquireLock(lockPath, timeoutMs) {
  const started = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      const fd = fs.openSync(path.join(lockPath, 'owner'), 'wx', 0o600);
      try { fs.writeFileSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw new ConsentStoreUnavailable('lock');
      const alive = ownerAlive(lockPath);
      const fresh = lockAge(lockPath) < 200;
      if (!alive && !fresh) fs.rmSync(lockPath, { recursive: true, force: true });
      if (Date.now() - started > timeoutMs) throw new ConsentStoreUnavailable('timeout');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

function withStore(filePath, timeoutMs, cap, t, fn) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const lockPath = `${filePath}.lock`;
  acquireLock(lockPath, timeoutMs);
  try {
    const state = loadState(filePath, cap, t);
    const result = fn(state);
    try { saveJson(filePath, state); } catch { throw new ConsentStoreUnavailable('write'); }
    return result;
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

export function createConsentLimiter(options = {}) {
  const sourceMax = options.sourceMax ?? CONSENT_SOURCE_MAX_FAILURES;
  const clientMax = options.clientMax ?? CONSENT_CLIENT_MAX_FAILURES;
  const globalMax = options.globalMax ?? CONSENT_GLOBAL_MAX_FAILURES;
  const lockoutMs = options.lockoutMs ?? CONSENT_LOCKOUT_MS;
  const cap = options.cap ?? CONSENT_TRACK_CAP;
  const now = options.now ?? (() => Date.now());
  const filePath = options.filePath ?? null;
  const lockTimeoutMs = options.lockTimeoutMs ?? 1000;
  if (!Number.isFinite(lockoutMs) || lockoutMs < 1) throw new Error('consent lockout duration must be positive');
  for (const budget of [sourceMax, clientMax, globalMax, cap]) {
    if (!Number.isInteger(budget) || budget < 1) throw new Error('consent failure budget must be positive');
  }
  const limits = { sourceMax, clientMax, globalMax, lockoutMs, cap };
  const memory = freshState(now());

  function mutate(fn) {
    const t = now();
    if (!filePath) return fn(memory, t);
    return withStore(filePath, lockTimeoutMs, cap, t, (state) => fn(state, t));
  }

  function snapshot(query) {
    return mutate((state, t) => view(state, query, t, lockoutMs, cap));
  }

  function recordFailure(query) {
    return mutate((state, t) => record(state, query, t, limits));
  }

  function sweep() {
    try { snapshot({ sourceKey: '0'.repeat(64) }); } catch (error) {
      if (error instanceof ConsentStoreUnavailable) return;
      throw error;
    }
  }

  return { snapshot, recordFailure, sweep };
}
