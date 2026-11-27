import {
  createHash,
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
  type JsonWebKey as CryptoJsonWebKey
} from "node:crypto";

const ALLOWED_DPOP_ALGS = new Set(["EdDSA", "ES256"]);
const PRIVATE_JWK_FIELDS = new Set(["d", "p", "q", "dp", "dq", "qi", "oth", "k"]);
const DEFAULT_MAX_SKEW_SECONDS = 60;
const MIN_JTI_LENGTH = 16;
const MAX_JTI_LENGTH = 256;
const NONCE_WINDOW_SECONDS = 120;
const NONCE_PREVIOUS_WINDOWS = 1;

export interface DpopVerificationSuccess {
  ok: true;
  jkt: string;
  jti: string;
  iat: number;
  expiresAtIso: string;
}

export interface DpopVerificationFailure {
  ok: false;
  error: "invalid_dpop_proof" | "use_dpop_nonce";
  reason: string;
}

export type DpopVerificationResult = DpopVerificationSuccess | DpopVerificationFailure;

export interface VerifyDpopProofInput {
  proof: string | undefined;
  method: string;
  expectedHtu: string;
  expectedJkt?: string;
  accessToken?: string;
  nonceSecret?: Buffer;
  nonceRequired?: boolean;
  now?: Date;
  maxSkewSeconds?: number;
}

/**
 * Computes the RFC 7638 SHA-256 base64url JWK thumbprint from an Ed25519 SPKI PEM key.
 */
export function computeEd25519JwkThumbprintFromPem(publicKeyPem: string): string {
  const jwk = createPublicKey(publicKeyPem).export({ format: "jwk" }) as Record<string, unknown>;
  const jkt = computeJwkThumbprint(jwk);
  if (!jkt) {
    throw new Error("failed to compute RFC 7638 JWK thumbprint from Ed25519 public key");
  }
  return jkt;
}

/**
 * Computes the RFC 7638 SHA-256 base64url thumbprint for public OKP (Ed25519) or EC (P-256) JWKs.
 * Rejects any JWK containing private key parameters.
 */
export function computeJwkThumbprint(jwk: Record<string, unknown>): string | undefined {
  for (const key of Object.keys(jwk)) {
    if (PRIVATE_JWK_FIELDS.has(key)) return undefined;
  }
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519" && typeof jwk.x === "string" && jwk.x.length > 0) {
    const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
    return createHash("sha256").update(canonical, "utf8").digest("base64url");
  }
  if (
    jwk.kty === "EC" &&
    jwk.crv === "P-256" &&
    typeof jwk.x === "string" &&
    jwk.x.length > 0 &&
    typeof jwk.y === "string" &&
    jwk.y.length > 0
  ) {
    const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
    return createHash("sha256").update(canonical, "utf8").digest("base64url");
  }
  return undefined;
}

export function issueDpopNonce(secret: Buffer, now: Date = new Date()): string {
  const bucket = Math.floor(now.getTime() / 1000 / NONCE_WINDOW_SECONDS);
  const mac = createHmac("sha256", secret).update(`acs-dpop-nonce-v1:${bucket}`).digest("base64url");
  return `${bucket}.${mac}`;
}

export function verifyDpopNonce(secret: Buffer, nonce: string, now: Date = new Date()): boolean {
  const parts = nonce.split(".");
  if (parts.length !== 2) return false;
  const bucket = Number(parts[0]);
  if (!Number.isSafeInteger(bucket) || bucket < 0) return false;
  const currentBucket = Math.floor(now.getTime() / 1000 / NONCE_WINDOW_SECONDS);
  if (bucket > currentBucket || currentBucket - bucket > NONCE_PREVIOUS_WINDOWS) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(`acs-dpop-nonce-v1:${bucket}`).digest("base64url");
  return constantTimeEqualString(parts[1], expected);
}

/**
 * Synchronous RFC 9449 DPoP proof verifier using `node:crypto`.
 * Keeps ACS request authentication synchronous while enforcing EdDSA/ES256, public-only JWK,
 * RFC 7638 `jkt` binding, `htm`/`htu`/`iat`/`jti`/`ath`, and `DPoP-Nonce`.
 */
export function verifyDpopProof(input: VerifyDpopProofInput): DpopVerificationResult {
  if (!input.proof) {
    return { ok: false, error: "invalid_dpop_proof", reason: "missing_dpop_header" };
  }
  const parts = input.proof.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return { ok: false, error: "invalid_dpop_proof", reason: "malformed_dpop_jwt" };
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as Record<string, unknown>;
    claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "invalid_dpop_proof", reason: "invalid_dpop_json" };
  }
  if (!isPlainObject(header) || !isPlainObject(claims)) {
    return { ok: false, error: "invalid_dpop_proof", reason: "invalid_dpop_structure" };
  }

  if (header.typ !== "dpop+jwt") {
    return { ok: false, error: "invalid_dpop_proof", reason: "invalid_dpop_typ" };
  }
  if (typeof header.alg !== "string" || !ALLOWED_DPOP_ALGS.has(header.alg)) {
    return { ok: false, error: "invalid_dpop_proof", reason: "unsupported_dpop_alg" };
  }
  if (!isPlainObject(header.jwk)) {
    return { ok: false, error: "invalid_dpop_proof", reason: "missing_dpop_jwk" };
  }
  if (!jwkMatchesAlg(header.jwk, header.alg)) {
    return { ok: false, error: "invalid_dpop_proof", reason: "invalid_dpop_jwk" };
  }
  const jkt = computeJwkThumbprint(header.jwk);
  if (!jkt) {
    return { ok: false, error: "invalid_dpop_proof", reason: "invalid_dpop_jwk" };
  }
  if (input.expectedJkt && !constantTimeEqualString(jkt, input.expectedJkt)) {
    return { ok: false, error: "invalid_dpop_proof", reason: "dpop_jkt_mismatch" };
  }

  if (!verifyJwsSignature(`${headerB64}.${payloadB64}`, signatureB64, header.alg, header.jwk)) {
    return { ok: false, error: "invalid_dpop_proof", reason: "invalid_dpop_signature" };
  }

  if (typeof claims.jti !== "string" || claims.jti.length < MIN_JTI_LENGTH || claims.jti.length > MAX_JTI_LENGTH) {
    return { ok: false, error: "invalid_dpop_proof", reason: "invalid_dpop_jti" };
  }
  if (typeof claims.htm !== "string" || claims.htm !== input.method.toUpperCase()) {
    return { ok: false, error: "invalid_dpop_proof", reason: "dpop_htm_mismatch" };
  }
  if (!matchesCanonicalHtu(claims.htu, input.expectedHtu)) {
    return { ok: false, error: "invalid_dpop_proof", reason: "dpop_htu_mismatch" };
  }

  const now = input.now ?? new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const maxSkewSeconds = input.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat) || Math.abs(nowSeconds - claims.iat) > maxSkewSeconds) {
    return { ok: false, error: "invalid_dpop_proof", reason: "dpop_iat_out_of_range" };
  }

  if (input.accessToken !== undefined) {
    if (typeof claims.ath !== "string" || claims.ath.length === 0) {
      return { ok: false, error: "invalid_dpop_proof", reason: "missing_dpop_ath" };
    }
    const expectedAth = createHash("sha256").update(input.accessToken, "ascii").digest("base64url");
    if (!constantTimeEqualString(claims.ath, expectedAth)) {
      return { ok: false, error: "invalid_dpop_proof", reason: "dpop_ath_mismatch" };
    }
  } else if (claims.ath !== undefined) {
    return { ok: false, error: "invalid_dpop_proof", reason: "unexpected_dpop_ath" };
  }

  if (input.nonceRequired) {
    if (typeof claims.nonce !== "string" || !input.nonceSecret || !verifyDpopNonce(input.nonceSecret, claims.nonce, now)) {
      return { ok: false, error: "use_dpop_nonce", reason: "use_dpop_nonce" };
    }
  } else if (claims.nonce !== undefined) {
    if (typeof claims.nonce !== "string" || !input.nonceSecret || !verifyDpopNonce(input.nonceSecret, claims.nonce, now)) {
      return { ok: false, error: "use_dpop_nonce", reason: "use_dpop_nonce" };
    }
  }

  // Keep jti replay record past the entire possible iat acceptance window.
  const expiresAtSeconds = Math.max(nowSeconds, Math.ceil(claims.iat)) + maxSkewSeconds + 60;
  return {
    ok: true,
    jkt,
    jti: claims.jti,
    iat: claims.iat,
    expiresAtIso: new Date(expiresAtSeconds * 1000).toISOString()
  };
}

function jwkMatchesAlg(jwk: Record<string, unknown>, alg: string): boolean {
  for (const key of Object.keys(jwk)) {
    if (PRIVATE_JWK_FIELDS.has(key)) return false;
  }
  if (alg === "EdDSA") {
    return jwk.kty === "OKP" && jwk.crv === "Ed25519";
  }
  if (alg === "ES256") {
    return jwk.kty === "EC" && jwk.crv === "P-256";
  }
  return false;
}

function verifyJwsSignature(
  signingInput: string,
  signatureB64: string,
  alg: string,
  jwk: Record<string, unknown>
): boolean {
  try {
    const publicKey = createPublicKey({ key: jwk as unknown as CryptoJsonWebKey, format: "jwk" });
    const sigBuf = Buffer.from(signatureB64, "base64url");
    if (alg === "EdDSA") {
      if (publicKey.asymmetricKeyType !== "ed25519" || sigBuf.length !== 64) return false;
      return verifySignature(null, Buffer.from(signingInput, "utf8"), publicKey, sigBuf);
    }
    if (alg === "ES256") {
      if (publicKey.asymmetricKeyType !== "ec" || sigBuf.length !== 64) return false;
      return verifySignature("sha256", Buffer.from(signingInput, "utf8"), { key: publicKey, dsaEncoding: "ieee-p1363" }, sigBuf);
    }
    return false;
  } catch {
    return false;
  }
}

function matchesCanonicalHtu(rawHtu: unknown, expectedHtu: string): boolean {
  if (typeof rawHtu !== "string" || rawHtu.length === 0) return false;
  if (rawHtu.includes("?") || rawHtu.includes("#")) return false;
  try {
    const parsed = new URL(rawHtu);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.search || parsed.hash) return false;
    return `${parsed.origin}${parsed.pathname}` === expectedHtu;
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function constantTimeEqualString(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left, "utf8");
  const rightBuf = Buffer.from(right, "utf8");
  return leftBuf.length === rightBuf.length && timingSafeEqual(leftBuf, rightBuf);
}
