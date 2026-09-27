import crypto from 'node:crypto';

/**
 * Server-only pairing secrets. The OAuth `state` is HMAC-signed with
 * PAIRING_STATE_KEY; the Supabase authorization code is held at rest only as
 * AES-256-GCM ciphertext under PAIRING_CODE_KEY with the pairing session_id as AAD.
 */
export interface PairingKeys { stateKey: Buffer; codeKey: Buffer; }

const CODE_FORMAT = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function decodeKey(name: string, value: string | undefined, exact?: number): Buffer {
  if (!value) throw new Error(`Missing ${name}`);
  const key = Buffer.from(value, 'base64');
  if (exact !== undefined ? key.length !== exact : key.length < 32) {
    throw new Error(`${name} must be base64 of ${exact ?? 'at least 32'} bytes`);
  }
  return key;
}

export function pairingKeysFromEnv(env: { PAIRING_STATE_KEY?: string; PAIRING_CODE_KEY?: string }): PairingKeys {
  return {
    stateKey: decodeKey('PAIRING_STATE_KEY', env.PAIRING_STATE_KEY),
    codeKey: decodeKey('PAIRING_CODE_KEY', env.PAIRING_CODE_KEY, 32),
  };
}

export function sha256Base64Url(value: string): string {
  return crypto.createHash('sha256').update(value).digest('base64url');
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Only S256 is accepted: the stored challenge must equal BASE64URL(SHA256(verifier)). */
export function pkceMatches(codeVerifier: string, codeChallenge: string): boolean {
  return constantTimeEqual(sha256Base64Url(codeVerifier), codeChallenge);
}

function stateMac(key: Buffer, sessionId: string, nonce: string): string {
  return crypto.createHmac('sha256', key).update(`${sessionId}.${nonce}`).digest('base64url');
}

export function newStateNonce(): string { return crypto.randomBytes(32).toString('base64url'); }

/** state = b64url("<session_id>.<nonce>.<HMAC(session_id.nonce)>") */
export function signPairingState(key: Buffer, sessionId: string, nonce: string): string {
  return Buffer.from(`${sessionId}.${nonce}.${stateMac(key, sessionId, nonce)}`, 'utf8').toString('base64url');
}

export function verifyPairingState(key: Buffer, state: string | null | undefined): { sessionId: string; nonce: string } | null {
  if (!state || state.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(state)) return null;
  const parts = Buffer.from(state, 'base64url').toString('utf8').split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]{16,512}$/.test(part))) return null;
  const [sessionId, nonce, mac] = parts;
  return constantTimeEqual(stateMac(key, sessionId, nonce), mac) ? { sessionId, nonce } : null;
}

export function encryptPairingCode(key: Buffer, sessionId: string, code: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(sessionId, 'utf8'));
  const body = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
  return `${CODE_FORMAT}.${Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url')}`;
}

/** Returns null on any tamper, wrong key, or AAD (session) mismatch. */
export function decryptPairingCode(key: Buffer, sessionId: string, sealed: string): string | null {
  const [format, payload, extra] = sealed.split('.');
  if (format !== CODE_FORMAT || !payload || extra !== undefined) return null;
  const raw = Buffer.from(payload, 'base64url');
  if (raw.length <= IV_BYTES + TAG_BYTES) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(sessionId, 'utf8'));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
