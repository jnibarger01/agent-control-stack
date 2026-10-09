/** Approval request protocol (slice 4 foundation).
 * A TTY, uid or local socket peer credential is NOT proof of a human.
 * No token is minted unless an independently authenticated human verifier
 * supplies a signed, challenge-bound authorization assertion.
 * Real approverd signing and socket isolation are gated on privileged install.
 */
import crypto from 'node:crypto';
import { computeJcInvocationHash } from './contract.js';
export interface JcPendingApproval {
  id: string; tool: string; invocationHash: string; runtimeId: string;
  createdAt: number; expiresAt: number; challenge: string;
}
export interface JcHumanAssertion {
  approvalId: string; challenge: string; invocationHash: string;
  operatorId: string; issuedAt: number; expiresAt: number;
}
export interface JcHumanVerifier {
  verify(assertion: JcHumanAssertion, pending: JcPendingApproval): Promise<boolean>;
}
export class JcApprovalCoordinator {
  private readonly pending = new Map<string, JcPendingApproval>();
  constructor(private readonly verifier: JcHumanVerifier, private readonly now = () => Date.now()) {}
  request(tool: string, args: Record<string, unknown>, runtimeId: string): JcPendingApproval {
    if (!tool || !runtimeId) throw new Error('JC_APPROVAL_REQUEST_INVALID');
    const createdAt = this.now();
    const pending: JcPendingApproval = {
      id: crypto.randomUUID(), tool, runtimeId,
      invocationHash: computeJcInvocationHash(tool, args),
      challenge: crypto.randomBytes(32).toString('base64url'),
      createdAt, expiresAt: createdAt + 30_000,
    };
    this.pending.set(pending.id, pending);
    return { ...pending };
  }
  async approve(assertion: JcHumanAssertion): Promise<JcPendingApproval> {
    const pending = this.pending.get(assertion.approvalId);
    if (!pending) throw new Error('JC_APPROVAL_UNKNOWN');
    // Consume before awaiting verifier to reject parallel replay.
    this.pending.delete(assertion.approvalId);
    const now = this.now();
    if (now > pending.expiresAt || !assertion.operatorId ||
        assertion.challenge !== pending.challenge ||
        assertion.invocationHash !== pending.invocationHash ||
        assertion.issuedAt > now || assertion.expiresAt < now ||
        assertion.expiresAt - assertion.issuedAt > 30_000)
      throw new Error('JC_APPROVAL_DENIED');
    if (!(await this.verifier.verify(assertion, pending))) throw new Error('JC_APPROVAL_DENIED');
    return { ...pending };
  }
  cancel(id: string): void { this.pending.delete(id); }
}
