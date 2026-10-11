/**
 * Human-authorization assertion verification. The operator's private key MUST
 * live outside every JC/agent-accessible UID (ideally FIDO2 with user presence).
 * This verifies a human authorization credential, NOT an interactive TTY.
 */
import crypto from 'node:crypto';
import type { JcPendingApproval, JcHumanAssertion, JcHumanVerifier } from './approval-protocol.js';

export interface SignedJcHumanAssertion {
  payload: JcHumanAssertion;
  signature: string;
}
const FIELDS = ['approvalId','challenge','expiresAt','invocationHash','issuedAt','operatorId'];
const encode = (a: JcHumanAssertion) => Buffer.from(JSON.stringify(Object.fromEntries(
  FIELDS.map(k => [k, a[k as keyof JcHumanAssertion]]),
)), 'utf8');
export function verifySignedHumanAssertion(
  signed: SignedJcHumanAssertion,
  pending: JcPendingApproval,
  publicKey: crypto.KeyObject,
  now = Date.now(),
): boolean {
  const p = signed?.payload;
  if (!p || Object.keys(p).sort().join() !== FIELDS.join() ||
      !p.operatorId || !p.approvalId || !p.challenge ||
      !Number.isSafeInteger(p.issuedAt) || !Number.isSafeInteger(p.expiresAt) ||
      p.issuedAt > now + 5000 || p.expiresAt < now ||
      p.expiresAt - p.issuedAt > 30_000 ||
      p.approvalId !== pending.id || p.challenge !== pending.challenge ||
      p.invocationHash !== pending.invocationHash ||
      now > pending.expiresAt ||
      typeof signed.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signed.signature))
    return false;
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') return false;
  return crypto.verify(null, encode(p), publicKey, Buffer.from(signed.signature, 'base64url'));
}
/** Can be used only by approverd with its pinned operator trust anchor. */
export function createHumanAssertionVerifier(
  publicKey: crypto.KeyObject,
  getSignature: (assertion: JcHumanAssertion) => string | undefined,
  now = () => Date.now(),
): JcHumanVerifier {
  return {
    verify: async (assertion, pending) => {
      const signature = getSignature(assertion);
      return signature
        ? verifySignedHumanAssertion({ payload: assertion, signature }, pending, publicKey, now())
        : false;
    },
  };
}
