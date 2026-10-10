/**
 * jc.local.v1 — locally approved, single-use execution token (ADR 0026 D4).
 *
 * Minted ONLY by `approverd` (which owns the Ed25519 signing key) after a human
 * approved one exact invocation. This module is verify-only: like acs.jc.v1 it
 * contains no signing code, so nothing that imports it can mint authority.
 *
 *   payload = { version, tokenId, approvalId, runtimeId, tool, invocationHash,
 *               approverId, issuedAt, expiresAt (<= 30 s), nonce }
 *   signature = Ed25519 over  "jc.local.v1\n" + strictCanonicalJsonV1(payload)
 *
 * The extra domain prefix and the distinct key mean an acs.jc.v1 signature can
 * never validate as a jc.local.v1 token or vice versa, even though the envelope
 * shape ({keyId, payload, signature}) is shared.
 *
 * A token authorizes one invocation, once: it is bound to the runtime, tool and
 * the exact arguments, lives at most 30 s, and its nonce is reserved in a
 * single-use store. The approval it came from is consumed at claim time, so a
 * failed execution needs a NEW approval; nothing here can be retried.
 */
import crypto from 'node:crypto';
import { strictCanonicalJsonV1 } from '../managed-acs.js';
import { FileNonceStore, jcAuthorizationArguments, loadEd25519PublicKey } from './contract.js';

export const JC_LOCAL_TOKEN_VERSION = 'jc.local.v1' as const;
export const JC_LOCAL_SIGN_DOMAIN = 'jc.local.v1\n';
export const JC_LOCAL_INVOCATION_DOMAIN = 'jc:local-invocation:v1';
export const JC_LOCAL_MAX_TTL_MS = 30_000;
export const JC_LOCAL_CLOCK_SKEW_MS = 5_000;

export type JcLocalRejectionCode =
  | 'JC_LOCAL_TOKEN_MISSING'
  | 'JC_LOCAL_TOKEN_MALFORMED'
  | 'JC_LOCAL_TOKEN_KEY_UNKNOWN'
  | 'JC_LOCAL_TOKEN_SIGNATURE_INVALID'
  | 'JC_LOCAL_TOKEN_VERSION_INVALID'
  | 'JC_LOCAL_TOKEN_RUNTIME_MISMATCH'
  | 'JC_LOCAL_TOKEN_TOOL_MISMATCH'
  | 'JC_LOCAL_TOKEN_ARGUMENTS_MISMATCH'
  | 'JC_LOCAL_TOKEN_TIME_INVALID'
  | 'JC_LOCAL_TOKEN_NONCE_INVALID'
  | 'JC_LOCAL_TOKEN_REPLAY';

export class JcLocalTokenError extends Error {
  constructor(public readonly code: JcLocalRejectionCode) {
    super(`jc.local.v1 token rejected (${code})`);
    this.name = 'JcLocalTokenError';
  }
}

function reject(code: JcLocalRejectionCode): never {
  throw new JcLocalTokenError(code);
}

const ENVELOPE_KEYS = Object.freeze(['keyId', 'payload', 'signature']);
const PAYLOAD_KEYS = Object.freeze([
  'approvalId', 'approverId', 'expiresAt', 'invocationHash', 'issuedAt', 'nonce', 'runtimeId', 'tokenId', 'tool', 'version',
]);
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const B64URL_64 = /^[A-Za-z0-9_-]{86}$/;
const RFC3339_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function requireExactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(record);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) reject('JC_LOCAL_TOKEN_MALFORMED');
}

function decodeB64Url(value: unknown, pattern: RegExp, bytes: number): Buffer | undefined {
  if (typeof value !== 'string' || !pattern.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === bytes && decoded.toString('base64url') === value ? decoded : undefined;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && RFC3339_MS.test(value) && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

/** Binds a token to the runtime, the tool and the exact delivered arguments. */
export function computeLocalInvocationHash(runtimeId: string, tool: string, args: Record<string, unknown>): string {
  const canonical = strictCanonicalJsonV1({ runtimeId, tool, arguments: args });
  return crypto.createHash('sha256').update(`${JC_LOCAL_INVOCATION_DOMAIN}\n${canonical}`, 'utf8').digest('hex');
}

/** The bytes approverd signs and the verifier checks. */
export function localTokenSigningBytes(payload: Record<string, unknown>): Buffer {
  return Buffer.from(`${JC_LOCAL_SIGN_DOMAIN}${strictCanonicalJsonV1(payload)}`, 'utf8');
}

export interface JcLocalAuthorization {
  version: typeof JC_LOCAL_TOKEN_VERSION;
  keyId: string;
  tokenId: string;
  approvalId: string;
  runtimeId: string;
  tool: string;
  invocationHash: string;
  approverId: string;
  authorizedAt: string;
  nonceHash: string;
}

export interface JcLocalVerifierOptions {
  publicKey: string | undefined;
  keyId: string | undefined;
  runtimeId: string;
  nonceStore: FileNonceStore;
  now?: () => number;
}

export class JcLocalTokenVerifier {
  private readonly now: () => number;
  private publicKey: crypto.KeyObject | undefined;

  constructor(private readonly options: JcLocalVerifierOptions) {
    this.now = options.now ?? Date.now;
    if (!ID_PATTERN.test(options.runtimeId)) throw new TypeError('runtimeId must match the ID grammar');
  }

  /** Verifies `envelope` for exactly (tool, deliveredArguments); reserves the nonce on success. */
  verify(tool: string, deliveredArguments: unknown, envelope: unknown): JcLocalAuthorization {
    if (envelope === undefined) reject('JC_LOCAL_TOKEN_MISSING');
    if (!isPlainObject(envelope)) reject('JC_LOCAL_TOKEN_MALFORMED');
    requireExactKeys(envelope, ENVELOPE_KEYS);
    if (typeof envelope.keyId !== 'string' || !KEY_ID_PATTERN.test(envelope.keyId)) reject('JC_LOCAL_TOKEN_MALFORMED');
    if (!this.options.keyId || envelope.keyId !== this.options.keyId) reject('JC_LOCAL_TOKEN_KEY_UNKNOWN');
    const signature = decodeB64Url(envelope.signature, B64URL_64, 64);
    if (!signature || !isPlainObject(envelope.payload)) reject('JC_LOCAL_TOKEN_MALFORMED');
    const payload = envelope.payload;
    requireExactKeys(payload, PAYLOAD_KEYS);

    let signed: Buffer;
    try {
      signed = localTokenSigningBytes(payload);
    } catch {
      reject('JC_LOCAL_TOKEN_MALFORMED');
    }
    try {
      this.publicKey ??= loadEd25519PublicKey(this.options.publicKey);
    } catch {
      reject('JC_LOCAL_TOKEN_KEY_UNKNOWN');
    }
    if (!crypto.verify(null, signed, this.publicKey as crypto.KeyObject, signature)) reject('JC_LOCAL_TOKEN_SIGNATURE_INVALID');

    // Signature is valid from here on: the rest binds it to THIS call.
    if (payload.version !== JC_LOCAL_TOKEN_VERSION) reject('JC_LOCAL_TOKEN_VERSION_INVALID');
    for (const field of ['tokenId', 'approvalId', 'approverId'] as const) {
      if (typeof payload[field] !== 'string' || !ID_PATTERN.test(payload[field] as string)) reject('JC_LOCAL_TOKEN_MALFORMED');
    }
    if (payload.runtimeId !== this.options.runtimeId) reject('JC_LOCAL_TOKEN_RUNTIME_MISMATCH');
    if (payload.tool !== tool) reject('JC_LOCAL_TOKEN_TOOL_MISMATCH');
    let bound: Record<string, unknown>;
    try {
      bound = jcAuthorizationArguments(deliveredArguments);
    } catch {
      return reject('JC_LOCAL_TOKEN_ARGUMENTS_MISMATCH');
    }
    if (typeof payload.invocationHash !== 'string' || !HASH_PATTERN.test(payload.invocationHash)) reject('JC_LOCAL_TOKEN_MALFORMED');
    let expected: string;
    try {
      expected = computeLocalInvocationHash(this.options.runtimeId, tool, bound);
    } catch {
      return reject('JC_LOCAL_TOKEN_ARGUMENTS_MISMATCH');
    }
    if (payload.invocationHash !== expected) reject('JC_LOCAL_TOKEN_ARGUMENTS_MISMATCH');

    if (!validTimestamp(payload.issuedAt) || !validTimestamp(payload.expiresAt)) reject('JC_LOCAL_TOKEN_TIME_INVALID');
    const issuedAt = Date.parse(payload.issuedAt);
    const expiresAt = Date.parse(payload.expiresAt);
    const now = this.now();
    if (
      issuedAt > now + JC_LOCAL_CLOCK_SKEW_MS
      || expiresAt <= now - JC_LOCAL_CLOCK_SKEW_MS
      || expiresAt <= issuedAt
      || expiresAt - issuedAt > JC_LOCAL_MAX_TTL_MS
    ) reject('JC_LOCAL_TOKEN_TIME_INVALID');

    if (!decodeB64Url(payload.nonce, B64URL_32, 32)) reject('JC_LOCAL_TOKEN_NONCE_INVALID');
    const nonceKey = `local:${envelope.keyId}:${payload.nonce}`;
    try {
      this.options.nonceStore.reserve(nonceKey, expiresAt + JC_LOCAL_CLOCK_SKEW_MS, now);
    } catch {
      reject('JC_LOCAL_TOKEN_REPLAY');
    }
    return Object.freeze({
      version: JC_LOCAL_TOKEN_VERSION,
      keyId: envelope.keyId,
      tokenId: payload.tokenId as string,
      approvalId: payload.approvalId as string,
      runtimeId: payload.runtimeId as string,
      tool,
      invocationHash: payload.invocationHash,
      approverId: payload.approverId as string,
      authorizedAt: new Date(now).toISOString(),
      // One-way only: raw nonces are never logged or persisted.
      nonceHash: crypto.createHash('sha256').update(nonceKey, 'utf8').digest('hex'),
    });
  }
}
