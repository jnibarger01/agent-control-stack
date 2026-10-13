/**
 * Human-assertion gate for approverd decisions (ported from PR #324, adapted to
 * main's ADR 0026 approverd from #329).
 *
 * approverd's decide socket proves only that SOME member of the decide group acted
 * (it records `approverIdAssurance: 'self-asserted'`). A TTY, uid or socket peer
 * credential is not proof of a human. This gate adds an optional, stronger layer:
 * a challenge is issued per pending approval record, and an approval is accepted
 * only when an independently authenticated human verifier vouches for an assertion
 * bound to that challenge, the record id and the record's runtime-bound
 * invocation hash (computeLocalInvocationHash).
 *
 * Fail closed: every mismatch, expiry, unknown id, replay, verifier error or
 * verifier `false` is a denial. A challenge is consumed BEFORE the verifier is
 * awaited so parallel replays cannot both succeed. This module does not mint
 * tokens and is not yet wired into approverd (see PR description).
 */
import crypto from 'node:crypto';
import type { ApprovalRecord } from './approverd.js';
import { JC_LOCAL_MAX_TTL_MS } from './local-token.js';

export interface JcApprovalChallenge {
  approvalId: string;
  runtimeId: string;
  tool: string;
  invocationHash: string;
  challenge: string;
  issuedAt: number;
  expiresAt: number;
}

export interface JcHumanAssertion {
  approvalId: string;
  challenge: string;
  invocationHash: string;
  operatorId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface JcHumanVerifier {
  verify(assertion: JcHumanAssertion, challenge: JcApprovalChallenge): Promise<boolean>;
}

export type JcHumanAssertionError = 'JC_APPROVAL_REQUEST_INVALID' | 'JC_APPROVAL_UNKNOWN' | 'JC_APPROVAL_DENIED';

export interface JcHumanAssertionGateOptions {
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  /** Challenge lifetime; capped at the jc.local.v1 max TTL (30 s). */
  challengeTtlMs?: number;
}

function safeEqual(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export class JcHumanAssertionGate {
  private readonly challenges = new Map<string, JcApprovalChallenge>();
  private readonly now: () => number;
  private readonly rand: (size: number) => Buffer;
  private readonly ttlMs: number;

  constructor(private readonly verifier: JcHumanVerifier, options: JcHumanAssertionGateOptions = {}) {
    this.now = options.now ?? Date.now;
    this.rand = options.randomBytes ?? ((size) => crypto.randomBytes(size));
    const ttl = options.challengeTtlMs ?? JC_LOCAL_MAX_TTL_MS;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > JC_LOCAL_MAX_TTL_MS) throw new RangeError('challenge ttl must be in [1, 30000] ms');
    this.ttlMs = ttl;
  }

  /** Issues (or replaces) the challenge for a PENDING approverd record. */
  issue(record: Pick<ApprovalRecord, 'id' | 'runtimeId' | 'tool' | 'invocationHash' | 'status'>): JcApprovalChallenge {
    if (!record || record.status !== 'pending' || !record.id || !record.runtimeId || !record.tool || !/^[0-9a-f]{64}$/.test(record.invocationHash ?? '')) {
      throw new Error('JC_APPROVAL_REQUEST_INVALID');
    }
    const issuedAt = this.now();
    const challenge: JcApprovalChallenge = {
      approvalId: record.id, runtimeId: record.runtimeId, tool: record.tool, invocationHash: record.invocationHash,
      challenge: this.rand(32).toString('base64url'), issuedAt, expiresAt: issuedAt + this.ttlMs,
    };
    this.challenges.set(record.id, challenge);
    return { ...challenge };
  }

  /** Resolves with the challenge when the human assertion is accepted; throws otherwise. */
  async accept(assertion: JcHumanAssertion): Promise<JcApprovalChallenge> {
    const id = assertion && typeof assertion.approvalId === 'string' ? assertion.approvalId : undefined;
    const pending = id === undefined ? undefined : this.challenges.get(id);
    if (!pending || id === undefined) throw new Error('JC_APPROVAL_UNKNOWN');
    // Consume before awaiting the verifier: a parallel replay finds nothing.
    this.challenges.delete(id);
    const now = this.now();
    const { issuedAt, expiresAt, operatorId } = assertion;
    if (now > pending.expiresAt
      || typeof operatorId !== 'string' || operatorId.length === 0
      || !safeEqual(assertion.challenge, pending.challenge)
      || !safeEqual(assertion.invocationHash, pending.invocationHash)
      || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)
      || issuedAt > now || expiresAt < now || expiresAt - issuedAt > JC_LOCAL_MAX_TTL_MS) {
      throw new Error('JC_APPROVAL_DENIED');
    }
    let ok: boolean;
    try {
      ok = (await this.verifier.verify({ ...assertion }, { ...pending })) === true;
    } catch {
      ok = false;
    }
    if (!ok) throw new Error('JC_APPROVAL_DENIED');
    return { ...pending };
  }

  cancel(approvalId: string): void {
    this.challenges.delete(approvalId);
  }
}
