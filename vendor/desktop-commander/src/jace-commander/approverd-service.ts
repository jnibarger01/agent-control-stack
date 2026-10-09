/**
 * Isolated approverd authority. Instantiate ONLY within the dedicated signer
 * service identity, with a private key inaccessible to the MCP server.
 *
 * Transport must authenticate a local JC client and deliver the independently
 * signed human assertion; this class does not trust a TTY or peer UID as human.
 */
import crypto from 'node:crypto';
import { JcApprovalCoordinator, type JcHumanAssertion, type JcPendingApproval } from './approval-protocol.js';
import { verifySignedHumanAssertion, type SignedJcHumanAssertion } from './human-assertion.js';
import { mintJcLocalCapability, type JcLocalEnvelope } from './local-capability.js';
import { JsonlTraceChain } from './looptrace.js';

export class JcApproverdService {
  private readonly coordinator: JcApprovalCoordinator;
  private readonly invocations = new Map<string, { tool: string; arguments: Record<string, unknown>; runtimeId: string }>();
  private assertion: SignedJcHumanAssertion | undefined;
  constructor(
    private readonly signerPrivateKey: crypto.KeyObject,
    private readonly operatorPublicKey: crypto.KeyObject,
    private readonly trace: JsonlTraceChain,
    private readonly now = () => Date.now(),
  ) {
    if (signerPrivateKey.type !== 'private' || signerPrivateKey.asymmetricKeyType !== 'ed25519') throw new Error('JC_SIGNER_KEY_INVALID');
    if (operatorPublicKey.type !== 'public' || operatorPublicKey.asymmetricKeyType !== 'ed25519') throw new Error('JC_OPERATOR_KEY_INVALID');
    this.coordinator = new JcApprovalCoordinator({
      verify: async (assertion, pending) => {
        const signed = this.assertion;
        return !!signed && verifySignedHumanAssertion(signed, pending, this.operatorPublicKey, this.now()) &&
          JSON.stringify(signed.payload) === JSON.stringify(assertion);
      },
    }, now);
  }
  request(tool: string, args: Record<string, unknown>, runtimeId: string): JcPendingApproval {
    if (this.invocations.size >= 1000 || !args || typeof args !== 'object' || Array.isArray(args))
      throw new Error('JC_APPROVAL_UNAVAILABLE');
    const pending = this.coordinator.request(tool, args, runtimeId);
    this.trace.append('tool_call_started', {
      tool, approvalId: pending.id, invocationHash: pending.invocationHash, pending: true,
    });
    this.invocations.set(pending.id, { tool, arguments: structuredClone(args), runtimeId });
    return pending;
  }
  async approveAndIssue(signed: SignedJcHumanAssertion): Promise<JcLocalEnvelope> {
    const id = signed?.payload?.approvalId;
    const invocation = this.invocations.get(id);
    const requiredOperatorId = crypto.createHash('sha256').update(this.operatorPublicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    if (signed?.payload?.operatorId !== requiredOperatorId) throw new Error('JC_APPROVAL_OPERATOR_MISMATCH');
    if (!invocation) throw new Error('JC_APPROVAL_UNKNOWN');
    this.invocations.delete(id);
    if (this.assertion) throw new Error('JC_APPROVAL_BUSY');
    this.assertion = signed;
    try {
      const approved = await this.coordinator.approve(signed.payload);
      // Fail closed if the durable audit append is not possible.
      this.trace.append('tool_call_finished', {
        tool: invocation.tool, approvalId: approved.id, authorized: true,
        invocationHash: approved.invocationHash, approverId: signed.payload.operatorId,
      });
      return mintJcLocalCapability(this.signerPrivateKey, {
        runtimeId: invocation.runtimeId, tool: invocation.tool,
        arguments: invocation.arguments, approverId: signed.payload.operatorId,
      }, this.now());
    } finally { this.assertion = undefined; }
  }
}
