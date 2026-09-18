/**
 * Enforcement kernel — the "validate -> authorize -> execute -> observe ->
 * attest" middleware for Desktop Commander's execution kernel architecture
 * (item #10). Desktop Commander stays a deterministic enforcement layer;
 * planning/orchestration remain in Hermes/ACS/ChatGPT.
 *
 * Local (non-ACS) enforcement modes via env:
 *   DC_ENFORCEMENT=full|off          classification + approval gating (default: full)
 *   DC_NETWORK_PROFILE=none|restricted|full   default network profile for calls
 *                                             that carry no capability (default: full)
 *   DC_DISABLE_EXECUTOR_LEASE=1      opt-out of the singleton executor lease
 *
 * When an ACS capability is presented in `_meta.capability`, it is always
 * verified regardless of DC_ENFORCEMENT — a presented capability must be
 * valid, and the request must fit inside it (fail closed).
 */
import crypto from 'crypto';
import { canonicalCapabilityPayload, signCapabilityPayload, verifyCapability, LocalCapabilityIssuer, type ExecutionCapability, type CommandClass, type NetworkProfile, type RejectionResult, type VerifyResult } from '../security/capability.js';
import { classifyOperation, buildApprovalRequest, getApprovalPolicy, type ClassifiedOperation, type ApprovalRequest } from '../security/approval.js';
import { checkNetworkBinaries } from '../security/network-guard.js';
import { AuditChain, canonicalJson, sha256Hex } from '../audit/audit-chain.js';

export type EnforcementBlockKind =
  | 'capability-rejected'
  | 'approval-required'
  | 'network-blocked';

export interface EnforcementPass {
  allowed: true;
  classification: ClassifiedOperation;
  capability: ExecutionCapability | undefined;
}

export interface EnforcementBlock {
  allowed: false;
  kind: EnforcementBlockKind;
  code: string;
  message: string;
  classification: ClassifiedOperation;
  /** Present when kind === 'approval-required': the exact mutation scope. */
  approvalRequest?: ApprovalRequest;
  rejection?: RejectionResult;
}

export type EnforcementDecision = EnforcementPass | EnforcementBlock;

export interface PreExecutionContext {
  tool: string;
  args: Record<string, unknown>;
  meta?: unknown;
  /** Transport path for the audit trail, e.g. 'chatgpt->oauth-gateway->mcp'. */
  transport?: string;
  now?: number;
}

export function extractCapability(meta: unknown): ExecutionCapability | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const cap = (meta as Record<string, unknown>).capability;
  if (!cap || typeof cap !== 'object') return undefined;
  return cap as ExecutionCapability;
}

export function agentFromMeta(meta: unknown): string {
  if (!meta || typeof meta !== 'object') return 'unknown';
  const m = meta as Record<string, unknown>;
  return typeof m.agent === 'string' && m.agent ? m.agent : (m.remote ? 'remote-agent' : 'local');
}

let sharedIssuer: LocalCapabilityIssuer | undefined;
function getIssuer(): LocalCapabilityIssuer {
  if (!sharedIssuer) sharedIssuer = new LocalCapabilityIssuer();
  return sharedIssuer;
}

let sharedAudit: AuditChain | undefined;
export function auditChain(): AuditChain {
  if (!sharedAudit) sharedAudit = new AuditChain();
  return sharedAudit;
}

export function requestHash(tool: string, args: Record<string, unknown>): string {
  return sha256Hex(canonicalJson({ tool, args }));
}

/**
 * Fail-closed pre-execution gate. Order: capability verification (when
 * presented) -> network profile enforcement -> classification + approval
 * policy. Broad requests are rejected against the granted capability rather
 * than trusted to the orchestrator.
 */
export async function preExecuteEnforcement(ctx: PreExecutionContext): Promise<EnforcementDecision> {
  const now = ctx.now ?? Date.now();
  const classification = classifyOperation({ tool: ctx.tool, args: ctx.args });
  const cap = extractCapability(ctx.meta);
  const enforcementOff = process.env.DC_ENFORCEMENT === 'off';

  // 1. Capability verification — mandatory whenever one is presented.
  let verified: VerifyResult | undefined;
  if (cap) {
    verified = verifyCapability(cap, {
      tool: ctx.tool,
      paths: classification.paths,
      commandClass: classification.commandClass,
      network: classification.network,
      now,
    }, getIssuer().getKey());
    if (!verified.ok) {
      return {
        allowed: false,
        kind: 'capability-rejected',
        code: verified.code,
        message: `capability rejected: ${verified.reason}`,
        classification,
        rejection: verified,
      };
    }
  }

  if (enforcementOff) {
    return { allowed: true, classification, capability: cap };
  }

  // 2. Network profile enforcement. An explicit 'none' is enforced locally:
  //    blocklisted network binaries are rejected outright for terminal-style
  //    commands. (Sandbox wrapping of spawned processes happens in the
  //    terminal-manager via network-guard; this gate catches tool-level intent.)
  const networkProfile: NetworkProfile = cap ? cap.network
    : (process.env.DC_NETWORK_PROFILE as NetworkProfile | undefined) ?? 'full';
  const argv: string[] = typeof ctx.args.command === 'string'
    ? ctx.args.command.split(/\s+/).filter(Boolean)
    : [];
  if (argv.length > 0) {
    const check = checkNetworkBinaries(argv, networkProfile);
    if (!check.ok) {
      return {
        allowed: false,
        kind: 'network-blocked',
        code: 'NETWORK_BINARY_BLOCKED',
        message: `network profile '${networkProfile}' blocks '${check.binary}': ${check.reason ?? 'egress disabled'}`,
        classification,
      };
    }
  }

  // 3. Risk-aware approval policy. A presented capability with a matching
  //    (non-escalated) command class is itself the authorization for that
  //    class, so no additional approval prompt is needed.
  if (cap && verified?.ok) {
    return { allowed: true, classification, capability: cap };
  }
  const policy = getApprovalPolicy(classification.commandClass);
  if (policy.mode === 'require-approval') {
    const request = buildApprovalRequest(classification, now);
    return {
      allowed: false,
      kind: 'approval-required',
      code: 'APPROVAL_REQUIRED',
      message: `operation classified '${classification.commandClass}' requires approval: ${classification.reason}`,
      classification,
      approvalRequest: request,
    };
  }
  if (policy.mode === 'deny') {
    return {
      allowed: false,
      kind: 'approval-required',
      code: 'POLICY_DENIED',
      message: `policy denies command class '${classification.commandClass}'`,
      classification,
    };
  }
  return { allowed: true, classification, capability: undefined };
}

/**
 * Convenience issuer for local orchestration: create a scoped, signed,
 * short-lived capability (<=5 min TTL) for exactly one tool + roots + class.
 */
export function issueLocalCapability(input: {
  tool: string;
  paths?: string[];
  commandClass?: CommandClass;
  network?: NetworkProfile;
  agent?: string;
  workItemId?: string;
  ttlMs?: number;
}): ExecutionCapability {
  const issuer = getIssuer();
  return issuer.issue({
    tool: input.tool,
    paths: input.paths ?? [],
    commandClass: input.commandClass ?? 'read-only',
    network: input.network ?? 'none',
    agent: input.agent ?? 'local',
    workItemId: input.workItemId ?? crypto.randomUUID(),
    ttlMs: input.ttlMs,
  });
}

export function signCapability(cap: Omit<ExecutionCapability, 'signature'>): string {
  return signCapabilityPayload(canonicalCapabilityPayload(cap), getIssuer().getKey());
}

/**
 * Observe + attest: append the request event before execution and the result
 * event after, hash-linked into the audit chain. Errors are swallowed at the
 * call sites' discretion via the returned boolean (audit failure must never
 * break execution, but the return value lets callers record it).
 */
export function attestRequest(event: {
  requestHash: string;
  tool: string;
  agent: string;
  transport: string;
  capabilityId?: string;
  approvalId?: string;
  commandClass?: CommandClass;
  args?: Record<string, unknown>;
}): boolean {
  try {
    auditChain().append({
      kind: 'request',
      requestHash: event.requestHash,
      capabilityId: event.capabilityId,
      approvalId: event.approvalId,
      tool: event.tool,
      agent: event.agent,
      transport: event.transport,
      sourceAgent: event.agent,
      mutations: [],
      ...(event.args ? { argsPreview: canonicalJson(event.args).slice(0, 4096) } : {}),
    } as Parameters<AuditChain['append']>[0]);
    return true;
  } catch {
    return false;
  }
}

export function attestResult(event: {
  requestHash: string;
  tool: string;
  agent: string;
  transport: string;
  capabilityId?: string;
  approvalId?: string;
  isError: boolean;
  durationMs: number;
  executorPid: number;
  error?: string;
}): boolean {
  try {
    auditChain().append({
      kind: 'result',
      requestHash: event.requestHash,
      capabilityId: event.capabilityId,
      approvalId: event.approvalId,
      tool: event.tool,
      agent: event.agent,
      transport: event.transport,
      sourceAgent: event.agent,
      exitCode: event.isError ? 1 : 0,
      resultHash: sha256Hex(canonicalJson({ tool: event.tool, isError: event.isError, error: event.error ?? null })),
      mutations: [],
      executorPid: event.executorPid,
      durationMs: event.durationMs,
      ...(event.error ? { error: event.error.slice(0, 4096) } : {}),
    });
    return true;
  } catch {
    return false;
  }
}
