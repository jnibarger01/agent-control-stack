/**
 * RFC 9449 DPoP proof verification, RFC 7638 JWK thumbprints, and rotating HMAC DPoP-Nonces.
 *
 * Zero runtime dependencies (node:crypto only). Fails closed.
 */
import crypto from 'node:crypto';

export const SUPPORTED_DPOP_ALGS = Object.freeze(['EdDSA', 'ES256']);

const PRIVATE_JWK_FIELDS = new Set(['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']);
const B64U_RE = /^[A-Za-z0-9_-]+$/;

function parseB64uJson(segment) {
  if (typeof segment !== 'string' || !segment || !B64U_RE.test(segment)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function extractPublicJwk(jwk) {
  if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) return null;
  for (const key of Object.keys(jwk)) {
    if (PRIVATE_JWK_FIELDS.has(key)) return null;
  }
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') {
    if (typeof jwk.x !== 'string' || !B64U_RE.test(jwk.x)) return null;
    if (Buffer.from(jwk.x, 'base64url').length !== 32) return null;
    return { kty: 'OKP', crv: 'Ed25519', x: jwk.x };
  }
  if (jwk.kty === 'EC' && jwk.crv === 'P-256') {
    if (typeof jwk.x !== 'string' || !B64U_RE.test(jwk.x)) return null;
    if (typeof jwk.y !== 'string' || !B64U_RE.test(jwk.y)) return null;
    if (Buffer.from(jwk.x, 'base64url').length !== 32) return null;
    if (Buffer.from(jwk.y, 'base64url').length !== 32) return null;
    return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  }
  return null;
}

/** RFC 7638 JWK SHA-256 thumbprint (base64url). */
export function computeJwkThumbprint(jwk) {
  const pub = extractPublicJwk(jwk);
  if (!pub) throw new Error('unsupported or invalid public JWK');
  const canonical =
    pub.kty === 'OKP'
      ? JSON.stringify({ crv: pub.crv, kty: pub.kty, x: pub.x })
      : JSON.stringify({ crv: pub.crv, kty: pub.kty, x: pub.x, y: pub.y });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

export function isValidJkt(jkt) {
  return typeof jkt === 'string' && /^[A-Za-z0-9_-]{43}$/.test(jkt);
}

export function canonicalHtu(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.includes('?') || rawUrl.includes('#')) return null;
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.search || u.hash) return null;
  return `${u.origin}${u.pathname}`;
}

export function computeAth(accessToken) {
  return crypto.createHash('sha256').update(accessToken, 'ascii').digest('base64url');
}

function timingSafeStrEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Stateless rotating HMAC-based DPoP-Nonce manager (survives restarts for a persistent signingKey).
 */
export function createNonceManager({ signingKey, windowSec = 60, maxAgeWindows = 2 }) {
  const key = Buffer.from(String(signingKey || ''), 'utf8');
  if (key.length === 0) throw new Error('signingKey required for DPoP nonce manager');

  function macForBucket(bucket) {
    return crypto.createHmac('sha256', key).update(`dpop-nonce-v1:${bucket}`).digest('base64url');
  }

  function issue(nowSec = Math.floor(Date.now() / 1000)) {
    const bucket = Math.floor(nowSec / windowSec);
    return `${bucket}.${macForBucket(bucket)}`;
  }

  function verify(nonce, nowSec = Math.floor(Date.now() / 1000)) {
    if (typeof nonce !== 'string') return false;
    const match = /^(\d+)\.([A-Za-z0-9_-]{43})$/.exec(nonce);
    if (!match) return false;
    const bucket = Number.parseInt(match[1], 10);
    if (!Number.isSafeInteger(bucket)) return false;
    const current = Math.floor(nowSec / windowSec);
    if (bucket > current + 1 || current - bucket > maxAgeWindows) return false;
    return timingSafeStrEqual(match[2], macForBucket(bucket));
  }

  return { issue, verify };
}

/**
 * Verify an RFC 9449 DPoP proof JWT.
 *
 * Replay protection (`consumeJti`) runs ONLY after signature, `htm`, `htu`, `iat`, `ath`, and `nonce`
 * all validate so invalid/unauthenticated/nonce-challenge probes do not pollute the replay table.
 */
export function verifyDpopProof(
  headerValue,
  {
    htm,
    htu,
    accessToken,
    nowSec = Math.floor(Date.now() / 1000),
    clockSkewSec = 60,
    nonceManager = null,
    nonceRequired = false,
    consumeJti = null,
  },
) {
  const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });
  if (typeof headerValue !== 'string' || headerValue.length === 0 || headerValue.length > 8192) {
    return fail('invalid_dpop_proof');
  }
  const parts = headerValue.split('.');
  if (parts.length !== 3 || parts.some((p) => !p || !B64U_RE.test(p))) {
    return fail('invalid_dpop_proof');
  }
  const [hB64, pB64, sB64] = parts;
  const hdr = parseB64uJson(hB64);
  const payload = parseB64uJson(pB64);
  if (!hdr || !payload) return fail('invalid_dpop_proof');

  if (typeof hdr.typ !== 'string' || hdr.typ.toLowerCase() !== 'dpop+jwt') {
    return fail('invalid_dpop_proof');
  }
  if (!SUPPORTED_DPOP_ALGS.includes(hdr.alg)) {
    return fail('invalid_dpop_proof');
  }
  const pubJwk = extractPublicJwk(hdr.jwk);
  if (!pubJwk) return fail('invalid_dpop_proof');
  if (hdr.alg === 'EdDSA' && pubJwk.kty !== 'OKP') return fail('invalid_dpop_proof');
  if (hdr.alg === 'ES256' && pubJwk.kty !== 'EC') return fail('invalid_dpop_proof');

  let sigOk;
  try {
    const pubKey = crypto.createPublicKey({ key: pubJwk, format: 'jwk' });
    const signingInput = Buffer.from(`${hB64}.${pB64}`, 'ascii');
    const sigBuf = Buffer.from(sB64, 'base64url');
    if (hdr.alg === 'EdDSA') {
      sigOk = sigBuf.length === 64 && crypto.verify(null, signingInput, pubKey, sigBuf);
    } else {
      sigOk =
        sigBuf.length === 64 &&
        crypto.verify('sha256', signingInput, { key: pubKey, dsaEncoding: 'ieee-p1363' }, sigBuf);
    }
  } catch {
    sigOk = false;
  }
  if (!sigOk) return fail('invalid_dpop_proof');

  let jkt;
  try {
    jkt = computeJwkThumbprint(pubJwk);
  } catch {
    return fail('invalid_dpop_proof');
  }

  if (typeof payload.jti !== 'string' || !/^[\x21-\x7e]{16,256}$/.test(payload.jti)) {
    return fail('invalid_dpop_proof', { jkt });
  }
  if (typeof payload.htm !== 'string' || payload.htm !== String(htm || '').toUpperCase()) {
    return fail('invalid_dpop_proof', { jkt });
  }
  const expectedHtu = canonicalHtu(htu);
  const presentedHtu = canonicalHtu(payload.htu);
  if (!expectedHtu || !presentedHtu || presentedHtu !== expectedHtu) {
    return fail('invalid_dpop_proof', { jkt });
  }
  if (
    typeof payload.iat !== 'number' ||
    !Number.isFinite(payload.iat) ||
    Math.abs(nowSec - payload.iat) > clockSkewSec
  ) {
    return fail('invalid_dpop_proof', { jkt });
  }

  if (accessToken !== undefined) {
    if (typeof payload.ath !== 'string' || !timingSafeStrEqual(payload.ath, computeAth(accessToken))) {
      return fail('invalid_dpop_proof', { jkt });
    }
  }

  const freshNonce = nonceManager ? nonceManager.issue(nowSec) : undefined;
  if (nonceManager) {
    if (payload.nonce !== undefined) {
      if (typeof payload.nonce !== 'string' || !nonceManager.verify(payload.nonce, nowSec)) {
        return fail('use_dpop_nonce', { jkt, freshNonce });
      }
    } else if (nonceRequired) {
      return fail('use_dpop_nonce', { jkt, freshNonce });
    }
  }

  if (consumeJti) {
    const exp = Math.floor(payload.iat) + clockSkewSec + 60;
    const accepted = consumeJti(payload.jti, jkt, exp);
    if (!accepted) {
      return fail('replayed_jti', { jkt, freshNonce });
    }
  }

  return { ok: true, jkt, jti: payload.jti, alg: hdr.alg, iat: payload.iat, freshNonce };
}
