/**
 * RFC 9449 DPoP (Demonstrating Proof-of-Possession) with Ed25519 / EdDSA
 * and RFC 7638 JWK thumbprints, using Node.js built-in `node:crypto`.
 */
import crypto from 'node:crypto';

export interface Ed25519PublicJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
}

export interface DpopKeyPair {
  privateKey: crypto.KeyObject;
  privateKeyPem: string;
  publicJwk: Ed25519PublicJwk;
  jkt: string;
}

export interface CreateDpopProofOptions {
  privateKey: crypto.KeyObject;
  publicJwk: Ed25519PublicJwk;
  htm: string;
  htu: string;
  accessToken?: string;
  nonce?: string;
  nowMs?: number;
  jti?: string;
}

export interface DpopNonceChallenge {
  useDpopNonce: boolean;
  nonce?: string;
}

function b64uJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function exportPublicEd25519Jwk(privateOrPublicKey: crypto.KeyObject): Ed25519PublicJwk {
  const publicKey =
    privateOrPublicKey.type === 'public'
      ? privateOrPublicKey
      : crypto.createPublicKey(privateOrPublicKey);
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new Error('DPoP key must be an Ed25519 OKP key');
  }
  // Strictly export public fields only; never include `d` or private parameters.
  return { kty: 'OKP', crv: 'Ed25519', x: jwk.x };
}

/** RFC 7638 SHA-256 JWK thumbprint for Ed25519 OKP keys. */
export function computeJwkThumbprint(jwk: Ed25519PublicJwk): string {
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string' || !jwk.x) {
    throw new Error('Invalid Ed25519 public JWK');
  }
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

export function generateDpopKeyPair(): DpopKeyPair {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const publicJwk = exportPublicEd25519Jwk(privateKey);
  const jkt = computeJwkThumbprint(publicJwk);
  return { privateKey, privateKeyPem, publicJwk, jkt };
}

export function loadDpopKeyPairFromPem(privateKeyPem: string): DpopKeyPair {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('DPoP private key must be Ed25519');
  }
  const publicJwk = exportPublicEd25519Jwk(privateKey);
  const jkt = computeJwkThumbprint(publicJwk);
  return { privateKey, privateKeyPem, publicJwk, jkt };
}

/** RFC 9449 §4.2 htu: scheme, authority, and path only (no query or fragment). */
export function normalizeHtu(rawUrl: string): string {
  const url = new URL(rawUrl);
  return `${url.origin}${url.pathname}`;
}

/** RFC 9449 §4.2 ath: base64url(SHA-256(ASCII access_token)). */
export function hashAccessTokenAth(accessToken: string): string {
  return crypto.createHash('sha256').update(accessToken, 'ascii').digest('base64url');
}

export function createDpopProof(options: CreateDpopProofOptions): string {
  const publicJwk: Ed25519PublicJwk = {
    kty: options.publicJwk.kty,
    crv: options.publicJwk.crv,
    x: options.publicJwk.x,
  };
  computeJwkThumbprint(publicJwk);
  const header = {
    typ: 'dpop+jwt',
    alg: 'EdDSA',
    jwk: publicJwk,
  };
  const payload: Record<string, unknown> = {
    jti: options.jti ?? crypto.randomBytes(16).toString('base64url'),
    htm: options.htm.toUpperCase(),
    htu: normalizeHtu(options.htu),
    iat: Math.floor((options.nowMs ?? Date.now()) / 1000),
  };
  if (options.accessToken !== undefined) {
    payload.ath = hashAccessTokenAth(options.accessToken);
  }
  if (options.nonce !== undefined) {
    payload.nonce = options.nonce;
  }
  const signingInput = `${b64uJson(header)}.${b64uJson(payload)}`;
  const signature = crypto.sign(null, Buffer.from(signingInput, 'ascii'), options.privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

export function extractDpopNonceChallenge(
  response: Response,
  jsonBody?: Record<string, unknown>,
): DpopNonceChallenge {
  const nonceHeader = response.headers.get('DPoP-Nonce')?.trim() || undefined;
  if (response.status === 401) {
    const wwwAuth = response.headers.get('WWW-Authenticate') ?? '';
    const isDpopUseNonce = /\bDPoP\b/i.test(wwwAuth) && /\berror\s*=\s*"?use_dpop_nonce"?/i.test(wwwAuth);
    return { useDpopNonce: isDpopUseNonce && Boolean(nonceHeader), nonce: nonceHeader };
  }
  if (response.status === 400 && jsonBody && jsonBody.error === 'use_dpop_nonce') {
    return { useDpopNonce: Boolean(nonceHeader), nonce: nonceHeader };
  }
  return { useDpopNonce: false, nonce: nonceHeader };
}
