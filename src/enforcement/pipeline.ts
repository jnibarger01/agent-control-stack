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
 *   DC_GATEWAY_ATTESTATION_KEY=...   shared HMAC secret for trusted gateway
 *                                     transport attribution; when set, requests
 *                                     carrying _meta.gateway must carry a valid
 *                                     bridge HMAC (see the TRUST CHAIN note
 *                                     below) or they are rejected fail-closed.
 *                                     Unset = behavior unchanged (backwards compat).
 *
 * When an ACS capability is presented in `_meta.capability`, it is always
 * verified regardless of DC_ENFORCEMENT — a presented capability must be
 * valid, and the request must fit inside it (fail closed).
 */
import crypto from 'crypto';
import { canonicalCapabilityPayload, signCapabilityPayload, verifyCapability, LocalCapabilityIssuer, type ExecutionCapability, type CommandClass, type NetworkProfile, type RejectionResult, type VerifyResult } from '../security/capability.js';
import { classifyOperation, buildApprovalRequest, getApprovalPolicy, InMemoryApprovalStore, type ClassifiedOperation, type ApprovalRequest, type ApprovalStore } from '../security/approval.js';
import { checkNetworkBinaries, checkNetworkBinariesInRaw, networkGuardSummary, scrubEnvironmentForNoNetwork, type NetworkGuardSummary } from '../security/network-guard.js';
import { AuditChain, canonicalJson, sha256Hex } from '../audit/audit-chain.js';

export type EnforcementBlockKind =
  | 'capability-rejected'
  | 'approval-required'
  | 'network-blocked';

export interface EnforcementPass {
  allowed: true;
  classification: ClassifiedOperation;
  capability: ExecutionCapability | undefined;
  /**
   * Present when the active network profile is 'none': an honest degradation
   * summary — a non-sandboxed 'none' is degraded (blocklist + env scrub
   * only), never silently claimed as enforced.
   */
  networkGuard?: NetworkGuardSummary;
  /**
   * Present (true) when the request carried a TRUSTED gateway attestation
   * (HMAC-verified under DC_GATEWAY_ATTESTATION_KEY). Callers should record
   * the transport as GATEWAY_TRANSPORT_VERIFIED for such requests.
   */
  gatewayTrusted?: true;
  /** Present when gatewayTrusted: the gateway-vetted actor identity. */
  gatewayActor?: GatewayActor;
  /**
   * Present when the active network profile is 'none': a scrubbed copy of the
   * spawn environment (proxy vars removed, NO_PROXY='*'). Consumers that
   * spawn processes should apply it; exporting it keeps the guard honest
   * even before spawn wiring consumes it.
   */
  spawnEnvOverride?: Record<string, string>;
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

/**
 * Trusted transport attribution (gateway attestation).
 *
 * TRUST CHAIN: the OAuth gateway holds GATEWAY_EXECUTION_TOKEN (a shared HMAC
 * secret). It authenticates the caller (x-dc-* headers), then the bridge
 * injects `params._meta.gateway = { sig, sub, client_id, jti, iat }` where
 * `sig = base64url(HMAC-SHA256(GATEWAY_EXECUTION_TOKEN, `${sub}.${client_id}.${jti}.${iat}`))`
 * (iat = epoch milliseconds). The bridge verifies the OAuth claims BEFORE
 * signing, so a valid sig means "gateway-vetted identity", not a client
 * self-report. Desktop Commander verifies that signature with the SAME
 * secret, supplied as DC_GATEWAY_ATTESTATION_KEY. `_meta.gateway.verified`
 * is display-only: a direct client can set verified=true itself, so the
 * boolean alone is NEVER trusted — only the HMAC is.
 *
 * When DC_GATEWAY_ATTESTATION_KEY is unset, gateway attribution is not
 * enforced and behavior is unchanged (backwards compatible).
 */

export interface GatewayActor {
  sub: string;
  client_id: string;
}

/** The verified transport string recorded in audit events for trusted gateway requests. */
export const GATEWAY_TRANSPORT_VERIFIED = 'oauth-gateway->mcp (verified)';

/** How far an attestation's iat may drift from now. */
const GATEWAY_ATTESTATION_WINDOW_MS = 10 * 60 * 1000;

/** The shared HMAC secret DC uses to verify bridge attestations, when configured. */
export function gatewayAttestationKey(): string | undefined {
  const key = process.env.DC_GATEWAY_ATTESTATION_KEY;
  return key && key.length > 0 ? key : undefined;
}

function gatewayFromMeta(meta: unknown): Record<string, unknown> | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const gw = (meta as Record<string, unknown>).gateway;
  return gw && typeof gw === 'object' ? (gw as Record<string, unknown>) : undefined;
}

/** Recompute the expected base64url HMAC sig over the attestation fields. */
function expectedGatewaySig(key: string, gw: Record<string, unknown>): string {
  const material = `${gw.sub}.${gw.client_id}.${gw.jti}.${gw.iat}`;
  return crypto.createHmac('sha256', key).update(material).digest('base64url');
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Compare a digest of each to keep the comparison constant-time even
    // across length mismatch.
    crypto.timingSafeEqual(sha256Hex(a), sha256Hex(b));
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * True ONLY when DC_GATEWAY_ATTESTATION_KEY is set and the request's
 * _meta.gateway carries a structurally complete attestation whose HMAC
 * verifies under that key, with iat inside the 10-minute window and a
 * non-empty jti. A bare `verified: true` boolean (client-set) never
 * satisfies this — the signature is the trust anchor.
 */
export function isTrustedGatewayMeta(meta: unknown, now: number = Date.now()): boolean {
  const key = gatewayAttestationKey();
  if (!key) return false;
  const gw = gatewayFromMeta(meta);
  if (!gw) return false;
  if (gw.verified !== true) return false;
  if (typeof gw.sub !== 'string' || !gw.sub) return false;
  if (typeof gw.client_id !== 'string' || !gw.client_id) return false;
  if (typeof gw.jti !== 'string' || !gw.jti) return false;
  if (typeof gw.iat !== 'number' || !Number.isFinite(gw.iat)) return false;
  if (Math.abs(now - gw.iat) > GATEWAY_ATTESTATION_WINDOW_MS) return false;
  if (typeof gw.sig !== 'string' || !gw.sig) return false;
  return timingSafeEqualStr(gw.sig, expectedGatewaySig(key, gw));
}

/** Trusted gateway identity for audit events, or undefined when untrusted. */
export function gatewayActorFromMeta(meta: unknown): GatewayActor | undefined {
  if (!isTrustedGatewayMeta(meta)) return undefined;
  const gw = gatewayFromMeta(meta) as Record<string, unknown>;
  return { sub: gw.sub as string, client_id: gw.client_id as string };
}

let sharedIssuer: LocalCapabilityIssuer | undefined;
function getIssuer(): LocalCapabilityIssuer {
  if (!sharedIssuer) sharedIssuer = new LocalCapabilityIssuer();
  return sharedIssuer;
}

// Item: pending approval requests live here until an approver (Telegram hook,
// UI, or the ACS orchestrator) resolves them. The store is owned by the
// enforcement pipeline so the approval re-execution path (fix #6) can consult
// it; server.ts imports getApprovalStore() from here.
let sharedApprovalStore: InMemoryApprovalStore | undefined;
export function getApprovalStore(): ApprovalStore {
  if (!sharedApprovalStore) sharedApprovalStore = new InMemoryApprovalStore();
  return sharedApprovalStore;
}

/** Extract an approvalId presented in _meta.approvalId (approval re-execution). */
export function approvalIdFromMeta(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const id = (meta as Record<string, unknown>).approvalId;
  return typeof id === 'string' && id ? id : undefined;
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

  // 0. Trusted gateway attestation (fail-closed). Only enforced when
  //    DC_GATEWAY_ATTESTATION_KEY is configured — env unset means behavior is
  //    unchanged (no new rejections). When set, any request presenting
  //    _meta.gateway MUST carry a valid bridge HMAC (isTrustedGatewayMeta);
  //    a self-claimed verified:true boolean is not a trust anchor. Like
  //    capability verification, this runs regardless of DC_ENFORCEMENT —
  //    transport trust is not optional where an attestation key exists.
  let gatewayTrusted: true | undefined;
  let gatewayActor: GatewayActor | undefined;
  if (gatewayAttestationKey() && gatewayFromMeta(ctx.meta)) {
    if (!isTrustedGatewayMeta(ctx.meta, now)) {
      return {
        allowed: false,
        kind: 'capability-rejected',
        code: 'GATEWAY_ATTESTATION_INVALID',
        message: 'gateway attestation invalid: _meta.gateway failed HMAC verification (verified flag alone is not trusted; sig/sub/client_id/jti/iat must verify under DC_GATEWAY_ATTESTATION_KEY within 10 minutes)',
        classification,
      };
    }
    gatewayTrusted = true;
    gatewayActor = gatewayActorFromMeta(ctx.meta);
  }

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
    return { allowed: true, classification, capability: cap,
      ...(gatewayTrusted ? { gatewayTrusted, gatewayActor } : {}) };
  }

  // 2. Network profile enforcement. An explicit 'none' is enforced locally:
  //    blocklisted network binaries are rejected outright for terminal-style
  //    commands. The RAW command string is scanned with a word-boundary regex
  //    per blocklisted basename (not argv tokens), so obfuscations like
  //    `"curl`, `(/usr/bin/curl` or `x=curl` cannot bypass the blocklist.
  //    (Sandbox wrapping of spawned processes happens in the terminal-manager
  //    via network-guard; this gate catches tool-level intent.)
  const networkProfile: NetworkProfile = cap ? cap.network
    : (process.env.DC_NETWORK_PROFILE as NetworkProfile | undefined) ?? 'full';
  const rawCommand = typeof ctx.args.command === 'string' ? ctx.args.command : '';
  // Fail closed (round-2 LOW): a non-string command would silently skip the
  // network blocklist; reject it instead of gating an unparseable command.
  if ('command' in ctx.args && ctx.args.command !== undefined && rawCommand === '') {
    return {
      allowed: false,
      kind: 'capability-rejected',
      code: 'COMMAND_MALFORMED',
      message: `args.command must be a string (got ${typeof ctx.args.command}); refusing to gate an unparseable command`,
      classification,
    };
  }
  const argv: string[] = rawCommand.split(/\s+/).filter(Boolean);
  if (rawCommand.length > 0) {
    const check = checkNetworkBinariesInRaw(rawCommand, networkProfile)
      ?? checkNetworkBinaries(argv, networkProfile);
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
  // Surface honesty: when the profile is 'none', attach an explicit guard
  // summary (profile / sandbox availability / degraded) plus the scrubbed
  // spawn env so a non-sandboxed 'none' is visibly degraded and the spawn
  // env override is available to consumers.
  const noneProfileGuard = networkProfile === 'none' ? await networkGuardSummary(networkProfile) : undefined;
  const spawnEnvOverride = networkProfile === 'none'
    ? scrubEnvironmentForNoNetwork().env
    : undefined;

  // 3. Risk-aware approval policy. A presented capability with a matching
  //    (non-escalated) command class is itself the authorization for that
  //    class, so no additional approval prompt is needed.
  if (cap && verified?.ok) {
    return {
      allowed: true,
      classification,
      capability: cap,
      ...(gatewayTrusted ? { gatewayTrusted, gatewayActor } : {}),
      ...(noneProfileGuard ? { networkGuard: noneProfileGuard, spawnEnvOverride } : {}),
    };
  }

  // 3b. Approval re-execution (red-team fix #6): an approved request may be
  //     re-presented with its approvalId in _meta.approvalId. The gate passes
  //     ONLY if the store's recorded decision is 'approved' AND the recorded
  //     request still matches the current tool + command, so an approval
  //     minted for one command can never authorize a different one.
  const presentedApprovalId = approvalIdFromMeta(ctx.meta);
  if (presentedApprovalId) {
    const store = getApprovalStore();
    if (store.decision(presentedApprovalId) === 'approved') {
      const recorded = (store as InMemoryApprovalStore).getRequest(presentedApprovalId);
      const command = classification.command;
      // Match scope: tool + command + resolved paths + network targets. An
      // approval minted for one request can never authorize a different one
      // (round-2 review: command-less tools previously matched on tool alone).
      const samePaths = JSON.stringify(recorded?.resolvedPaths ?? []) === JSON.stringify([...classification.paths].sort());
      const sameTargets = JSON.stringify(recorded?.networkTargets ?? []) === JSON.stringify([...classification.networkTargets].sort());
      const matches = recorded
        && recorded.tool === ctx.tool
        && samePaths
        && sameTargets
        && (recorded.command ?? undefined) === (command ?? undefined);
      if (matches) {
        return {
          allowed: true,
          classification,
          capability: cap,
          ...(gatewayTrusted ? { gatewayTrusted, gatewayActor } : {}),
          ...(noneProfileGuard ? { networkGuard: noneProfileGuard, spawnEnvOverride } : {}),
        };
      }
    }
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
  return {
    allowed: true,
    classification,
    capability: undefined,
    ...(gatewayTrusted ? { gatewayTrusted, gatewayActor } : {}),
    ...(noneProfileGuard ? { networkGuard: noneProfileGuard, spawnEnvOverride } : {}),
  };
}

/**
 * Convenience issuer for local orchestration: create a scoped, signed,
 * short-lived capability (<=5 min TTL) for exactly one tool + roots + class.
 *
 * SECURITY NOTE (red-team finding #10): this mints a capability IN-PROCESS,
 * which is equivalent to already holding execution authority — anyone who can
 * call this function can already sign arbitrary capabilities. It exists for
 * ACS-bound issuing (the orchestrator vending scoped, short-lived grants to
 * agents it drives), NOT as a privilege boundary. The signing key returned by
 * getIssuer() never leaves this process.
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
  networkGuard?: NetworkGuardSummary;
  /**
   * Present when the request carried a TRUSTED gateway attestation: the
   * gateway-vetted identity recorded in the audit event (never taken from a
   * client-supplied verified flag).
   */
  gatewayActor?: GatewayActor;
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
      ...(event.networkGuard ? { networkGuard: event.networkGuard } : {}),
      ...(event.gatewayActor ? { gatewayActor: event.gatewayActor } : {}),
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
