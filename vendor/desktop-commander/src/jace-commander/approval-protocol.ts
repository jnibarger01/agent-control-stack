/**
 * Human-assertion gate for approverd decisions (ported from PR #324, adapted to
 * main's ADR 0026 approverd from #329; hardened per the #355 review F1-F5 and
 * R/V's findings in #356, Jace's decision 2026-10-13).
 *
 * approverd's decide socket proves only that SOME member of the decide group acted
 * (legacy `approverIdAssurance: 'self-asserted'`). A TTY, uid or socket peer
 * credential is not proof of a human. This gate adds the stronger layer: a 32-byte
 * random challenge is issued per pending approval record (bound to the record id,
 * its invocation hash and its expiry), and an approval is accepted only when an
 * independently authenticated human verifier (WebAuthn passkey with UV, see
 * passkey-verifier.ts) vouches for an assertion bound to that challenge and
 * returns the authenticated principal, which must equal the claimed operatorId.
 *
 * Fail closed: every mismatch, expiry, unknown id, replay, verifier error,
 * verifier timeout, backwards clock or non-principal verifier result is a denial.
 *
 *  - F4/#356(c,g): issue() refuses while a live challenge exists for the record; an
 *    assertion is checked structurally (and by the verifier's optional precheck)
 *    BEFORE the challenge is consumed, so garbage cannot burn a human's challenge.
 *    A structurally valid assertion consumes the challenge before the verifier is
 *    awaited, so parallel replays cannot both succeed.
 *  - F5/#356(e): expired challenges are swept on every issue().
 *  - #356(f): the verifier races a deadline; a timeout is a denial. It consumes the
 *    challenge, never the approverd record, which stays pending for a new attempt.
 *  - #356(b): a clock that moved backwards (now < challenge.issuedAt, or the clock
 *    observed after the verifier is earlier than before it) denies and drops the
 *    challenge.
 *  - #356(d): the constructor validates the verifier.
 *  - F1: the gate returns the challenge snapshot; approverd re-checks the LIVE record
 *    (pending, unexpired, same hash and expiry) synchronously after accept()
 *    resolves and before it mutates anything.
 */
import crypto from 'node:crypto';
import type { ApprovalRecord } from './approverd.js';
import { JC_LOCAL_MAX_TTL_MS } from './local-token.js';

/** Protocol version for the two-step decide_begin / decide_complete flow. */
export const JC_DECIDE_PROTOCOL_VERSION = 'jc.decide.v2';
export const JC_DEFAULT_VERIFIER_TIMEOUT_MS = 10_000;
export const JC_MAX_VERIFIER_TIMEOUT_MS = JC_LOCAL_MAX_TTL_MS;
const OPERATOR_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface JcApprovalChallenge {
  approvalId: string;
  runtimeId: string;
  tool: string;
  invocationHash: string;
  /** The approverd record's expiresAt at issue time (bound into the WebAuthn challenge). */
  recordExpiresAt: string;
  /** 32 random bytes, base64url. */
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
  /** Verifier-specific proof, e.g. a WebAuthn AuthenticationResponseJSON. Opaque to the gate. */
  webauthn?: unknown;
}

export interface JcVerifiedPrincipal {
  /** The authenticated principal (for WebAuthn: the operator the credential is registered to). */
  operatorId: string;
  credentialId?: string;
  assurance: 'webauthn-uv';
}

export interface JcHumanVerifier {
  /** Optional cheap structural check run BEFORE the challenge is consumed (F4). Must not throw. */
  precheck?(assertion: JcHumanAssertion): boolean;
  /** Resolves with the authenticated principal, or false. Anything else (or a throw) is a denial. */
  verify(assertion: JcHumanAssertion, challenge: JcApprovalChallenge): Promise<JcVerifiedPrincipal | false>;
}

export interface JcAcceptedAssertion {
  challenge: JcApprovalChallenge;
  operatorId: string;
  credentialId?: string;
  assurance: 'webauthn-uv';
}

export type JcHumanAssertionError =
  | 'JC_APPROVAL_REQUEST_INVALID'
  | 'JC_APPROVAL_CHALLENGE_LIVE'
  | 'JC_APPROVAL_UNKNOWN'
  | 'JC_APPROVAL_DENIED'
  | 'JC_APPROVAL_VERIFIER_TIMEOUT'
  | 'JC_APPROVAL_CLOCK';

export interface JcHumanAssertionGateOptions {
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  /** Challenge lifetime; capped at the jc.local.v1 max TTL (30 s). */
  challengeTtlMs?: number;
  /** Deadline for verifier.verify(); in [1, 30000] ms, default 10 s. */
  verifierTimeoutMs?: number;
}

function safeEqual(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function lengthPrefixed(parts: Array<Buffer | string>): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const bytes = typeof part === 'string' ? Buffer.from(part, 'utf8') : part;
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length);
    chunks.push(len, bytes);
  }
  return Buffer.concat(chunks);
}

/**
 * The WebAuthn challenge for a gate challenge: SHA-256 over a domain tag and the length-prefixed
 * gate challenge bytes, approval id, runtime, tool, invocation hash, record expiry and challenge
 * window. An assertion signed over it cannot be used for any other approval, invocation or attempt.
 */
export function webauthnChallengeFor(challenge: JcApprovalChallenge): string {
  const raw = Buffer.from(challenge.challenge, 'base64url');
  if (raw.length !== 32) throw new Error('JC_APPROVAL_REQUEST_INVALID');
  return crypto.createHash('sha256').update(lengthPrefixed([
    'jc.approval.webauthn.v1', raw, challenge.approvalId, challenge.runtimeId, challenge.tool,
    challenge.invocationHash, challenge.recordExpiresAt, String(challenge.issuedAt), String(challenge.expiresAt),
  ])).digest().toString('base64url');
}

export class JcHumanAssertionGate {
  private readonly challenges = new Map<string, JcApprovalChallenge>();
  private readonly now: () => number;
  private readonly rand: (size: number) => Buffer;
  private readonly ttlMs: number;
  private readonly verifierTimeoutMs: number;

  constructor(private readonly verifier: JcHumanVerifier, options: JcHumanAssertionGateOptions = {}) {
    if (!verifier || typeof verifier.verify !== 'function' || (verifier.precheck !== undefined && typeof verifier.precheck !== 'function')) {
      throw new TypeError('a human verifier with verify() is required');
    }
    this.now = options.now ?? Date.now;
    this.rand = options.randomBytes ?? ((size) => crypto.randomBytes(size));
    const ttl = options.challengeTtlMs ?? JC_LOCAL_MAX_TTL_MS;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > JC_LOCAL_MAX_TTL_MS) throw new RangeError('challenge ttl must be in [1, 30000] ms');
    this.ttlMs = ttl;
    const timeout = options.verifierTimeoutMs ?? JC_DEFAULT_VERIFIER_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > JC_MAX_VERIFIER_TIMEOUT_MS) throw new RangeError('verifier timeout must be in [1, 30000] ms');
    this.verifierTimeoutMs = timeout;
  }

  /** Number of challenges currently held (live or not yet swept). */
  get size(): number {
    return this.challenges.size;
  }

  /** Drops expired challenges (F5). */
  sweep(now = this.now()): void {
    for (const [id, challenge] of this.challenges) if (now > challenge.expiresAt || now < challenge.issuedAt) this.challenges.delete(id);
  }

  /** Issues the challenge for a PENDING, unexpired approverd record. Refuses while one is live (F4). */
  issue(record: Pick<ApprovalRecord, 'id' | 'runtimeId' | 'tool' | 'invocationHash' | 'status' | 'expiresAt'>): JcApprovalChallenge {
    const now = this.now();
    if (!record || record.status !== 'pending' || !record.id || !record.runtimeId || !record.tool || !/^[0-9a-f]{64}$/.test(record.invocationHash ?? '')
      || typeof record.expiresAt !== 'string' || !(Date.parse(record.expiresAt) > now)) {
      throw new Error('JC_APPROVAL_REQUEST_INVALID');
    }
    this.sweep(now);
    if (this.challenges.has(record.id)) throw new Error('JC_APPROVAL_CHALLENGE_LIVE');
    const raw = this.rand(32);
    if (!Buffer.isBuffer(raw) || raw.length !== 32) throw new Error('JC_APPROVAL_REQUEST_INVALID');
    // Never outlive the record itself.
    const expiresAt = Math.min(now + this.ttlMs, Date.parse(record.expiresAt));
    const challenge: JcApprovalChallenge = {
      approvalId: record.id, runtimeId: record.runtimeId, tool: record.tool, invocationHash: record.invocationHash,
      recordExpiresAt: record.expiresAt, challenge: raw.toString('base64url'), issuedAt: now, expiresAt,
    };
    this.challenges.set(record.id, challenge);
    return { ...challenge };
  }

  /** Resolves when the human assertion is accepted; throws a JcHumanAssertionError otherwise. */
  async accept(assertion: JcHumanAssertion): Promise<JcAcceptedAssertion> {
    const id = assertion && typeof assertion === 'object' && typeof assertion.approvalId === 'string' ? assertion.approvalId : undefined;
    const pending = id === undefined ? undefined : this.challenges.get(id);
    if (!pending || id === undefined) throw new Error('JC_APPROVAL_UNKNOWN');
    const now = this.now();
    if (now < pending.issuedAt) {
      // #356(b): the clock went backwards; nothing about this window can be trusted.
      this.challenges.delete(id);
      throw new Error('JC_APPROVAL_CLOCK');
    }
    if (now > pending.expiresAt) {
      this.challenges.delete(id);
      throw new Error('JC_APPROVAL_DENIED');
    }
    // Structural checks first; a failure leaves the challenge in place (F4).
    const { issuedAt, expiresAt, operatorId } = assertion;
    let precheck = true;
    try {
      precheck = this.verifier.precheck ? this.verifier.precheck({ ...assertion }) === true : true;
    } catch {
      precheck = false;
    }
    if (!precheck
      || typeof operatorId !== 'string' || !OPERATOR_ID.test(operatorId)
      || !safeEqual(assertion.challenge, pending.challenge)
      || !safeEqual(assertion.invocationHash, pending.invocationHash)
      || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)
      || issuedAt < pending.issuedAt || issuedAt > now || expiresAt < now || expiresAt - issuedAt > JC_LOCAL_MAX_TTL_MS) {
      throw new Error('JC_APPROVAL_DENIED');
    }
    // Consume before awaiting the verifier: a parallel replay finds nothing.
    this.challenges.delete(id);
    const snapshot = { ...pending };
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), this.verifierTimeoutMs); });
    let result: unknown;
    try {
      result = await Promise.race([Promise.resolve().then(() => this.verifier.verify({ ...assertion }, { ...snapshot })), deadline]);
    } catch {
      result = false;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (result === 'timeout') throw new Error('JC_APPROVAL_VERIFIER_TIMEOUT');
    const after = this.now();
    if (after < now) throw new Error('JC_APPROVAL_CLOCK');
    if (after > snapshot.expiresAt) throw new Error('JC_APPROVAL_DENIED');
    if (!result || typeof result !== 'object') throw new Error('JC_APPROVAL_DENIED');
    const principal = result as Partial<JcVerifiedPrincipal>;
    // F2: the authenticated principal must be the operator the assertion claims.
    if (principal.assurance !== 'webauthn-uv' || typeof principal.operatorId !== 'string' || !OPERATOR_ID.test(principal.operatorId)
      || !safeEqual(principal.operatorId, operatorId)) {
      throw new Error('JC_APPROVAL_DENIED');
    }
    return {
      challenge: snapshot,
      operatorId: principal.operatorId,
      ...(typeof principal.credentialId === 'string' ? { credentialId: principal.credentialId } : {}),
      assurance: 'webauthn-uv',
    };
  }

  cancel(approvalId: string): void {
    this.challenges.delete(approvalId);
  }
}
