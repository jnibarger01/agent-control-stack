/**
 * jc.local.v1 exact-invocation authorization. The PRIVATE key belongs to a
 * separate approverd identity, never to the MCP server or OAuth edge.
 * A signed token is NOT a human-authentication mechanism. Issuers must first
 * validate a non-agent-accessible, challenge-bound human assertion.
 */
import crypto from 'node:crypto';
import { computeJcInvocationHash, FileNonceStore } from './contract.js';

export const JC_LOCAL_VERSION = 'jc.local.v1' as const;
export const JC_LOCAL_MAX_TTL_MS = 30_000;
export interface JcLocalPayload {
  version: typeof JC_LOCAL_VERSION;
  tokenId: string;
  runtimeId: string;
  tool: string;
  invocationHash: string;
  approverId: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}
export interface JcLocalEnvelope {
  payload: JcLocalPayload;
  signature: string;
}
function plain(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}
const KEYS = ['approverId','expiresAt','invocationHash','issuedAt','nonce','runtimeId','tokenId','tool','version'];
const canon = (p: JcLocalPayload) => JSON.stringify(Object.fromEntries(KEYS.map(k => [k, p[k as keyof JcLocalPayload]])));
const acceptableId = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(v);
const b64url = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_-]{86}$/.test(v);
function validate(payload: unknown, now: number): asserts payload is JcLocalPayload {
  if (!plain(payload) || Object.keys(payload).sort().join() !== KEYS.join()) throw new Error('JC_LOCAL_MALFORMED');
  if (payload.version !== JC_LOCAL_VERSION || ![payload.runtimeId,payload.tool,payload.tokenId,payload.approverId].every(acceptableId))
    throw new Error('JC_LOCAL_MALFORMED');
  if (typeof payload.invocationHash !== 'string' || !/^[a-f0-9]{64}$/.test(payload.invocationHash))
    throw new Error('JC_LOCAL_MALFORMED');
  if (typeof payload.nonce !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(payload.nonce))
    throw new Error('JC_LOCAL_MALFORMED');
  if (!Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt) ||
      payload.expiresAt <= payload.issuedAt || payload.expiresAt - payload.issuedAt > JC_LOCAL_MAX_TTL_MS ||
      payload.issuedAt > now + 5000 || payload.expiresAt < now) throw new Error('JC_LOCAL_EXPIRED');
}
/** Call only from the isolated signer after a verified human decision. */
export function mintJcLocalCapability(
  privateKey: crypto.KeyObject,
  input: { runtimeId: string; tool: string; arguments: Record<string, unknown>; approverId: string },
  now = Date.now(),
): JcLocalEnvelope {
  if (privateKey.asymmetricKeyType !== 'ed25519' || privateKey.type !== 'private') throw new Error('JC_LOCAL_KEY_INVALID');
  const payload: JcLocalPayload = {
    version: JC_LOCAL_VERSION, tokenId: crypto.randomUUID(),
    runtimeId: input.runtimeId, tool: input.tool,
    invocationHash: computeJcInvocationHash(input.tool, input.arguments),
    approverId: input.approverId, issuedAt: now, expiresAt: now + JC_LOCAL_MAX_TTL_MS,
    nonce: crypto.randomBytes(32).toString('base64url'),
  };
  validate(payload, now);
  return { payload, signature: crypto.sign(null, Buffer.from(canon(payload)), privateKey).toString('base64url') };
}
export interface JcLocalNonceStore {
  consume(nonce: string): void;
}
export function verifyJcLocalCapability(
  envelope: unknown,
  publicKey: crypto.KeyObject,
  expected: { runtimeId: string; tool: string; arguments: Record<string, unknown> },
  nonces: JcLocalNonceStore,
  now = Date.now(),
): JcLocalPayload {
  if (publicKey.asymmetricKeyType !== 'ed25519' || publicKey.type !== 'public') throw new Error('JC_LOCAL_KEY_INVALID');
  if (!plain(envelope) || Object.keys(envelope).sort().join() !== 'payload,signature' || !b64url(envelope.signature))
    throw new Error('JC_LOCAL_MALFORMED');
  validate(envelope.payload, now);
  const p = envelope.payload;
  if (p.runtimeId !== expected.runtimeId || p.tool !== expected.tool ||
      p.invocationHash !== computeJcInvocationHash(expected.tool, expected.arguments))
    throw new Error('JC_LOCAL_INVOCATION_MISMATCH');
  if (!crypto.verify(null, Buffer.from(canon(p)), publicKey, Buffer.from(envelope.signature, 'base64url')))
    throw new Error('JC_LOCAL_SIGNATURE_INVALID');
  // Must be a persistent replay store shared across restarts and workers.
  nonces.consume(p.nonce);
  return p;
}
/** Existing file-backed nonce store is suitable for a root/daemon-controlled directory. */
export { FileNonceStore };
