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
 *   DC_ACS_CAPABILITY_PUBLIC_KEY=... base64url SPKI Ed25519 public key of the
 *                                     ACS capability issuer. With (optionally)
 *                                     DC_ACS_CAPABILITY_KEY_ID, any request
 *                                     presenting _meta.capability is verified
 *                                     as an ACS-issued acs.dc.v1 capability
 *                                     (see ACS CAPABILITY note below); a
 *                                     presented capability that fails
 *                                     verification is rejected fail-closed.
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
import { ACS_CAPABILITY_VERSION, FIXED_ACS_SCOPES, computeDesktopCommanderInvocationHash, getManagedAcsToolPolicy, strictCanonicalJsonV1 } from '../managed-acs.js';

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
   * Present when the request carried an ACS capability that VERIFIED under
   * DC_ACS_CAPABILITY_PUBLIC_KEY: the envelope-derived attestation recorded
   * in the audit trail (capabilityId/workItemId/attemptId/leaseId/leaseEpoch).
   */
  acsCapability?: AcsCapabilityAttestation;
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
    crypto.timingSafeEqual(Buffer.from(sha256Hex(a), 'hex'), Buffer.from(sha256Hex(b), 'hex'));
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

/**
 * ACS-issued capability verification (acs.dc.v1, Ed25519, fail-closed).
 *
 * TRUST CHAIN: ACS mints a capability envelope { payload, signature, keyId }
 * where signature = base64url(Ed25519.sign(null, strictCanonicalJsonV1(payload)))
 * under a PKCS#8 key held ONLY in ACS process memory. A standalone Desktop
 * Commander deployment opts in by configuring the matching public key as
 * DC_ACS_CAPABILITY_PUBLIC_KEY (base64url SPKI) and optionally pinning the
 * expected key id via DC_ACS_CAPABILITY_KEY_ID. When configured, ANY request
 * presenting _meta.capability is verified as an ACS capability — the local
 * HMAC issuer path is bypassed — and a presented capability that fails any
 * check is rejected fail-closed, regardless of DC_ENFORCEMENT. When the env
 * is unset, behavior is unchanged byte-for-byte.
 */

export type AcsCapabilityRejectionCode =
  | 'ACS_CAPABILITY_INVALID_SIGNATURE'
  | 'ACS_CAPABILITY_EXPIRED'
  | 'ACS_CAPABILITY_TOOL_MISMATCH'
  | 'ACS_CAPABILITY_ARGS_MISMATCH'
  | 'ACS_CAPABILITY_MALFORMED';

export interface AcsCapabilityAttestation {
  capabilityId: string;
  workItemId: string;
  attemptId: string;
  leaseId: string;
  leaseEpoch: number;
}

export type AcsCapabilityVerifyResult =
  | { ok: true; attestation: AcsCapabilityAttestation }
  | { ok: false; code: AcsCapabilityRejectionCode; reason: string };

/** The configured ACS capability verification public key (SPKI, base64url), when set. */
export function acsCapabilityPublicKeyEnv(): string | undefined {
  const key = process.env.DC_ACS_CAPABILITY_PUBLIC_KEY;
  return key && key.length > 0 ? key : undefined;
}

/** The pinned ACS capability key id, when set. */
export function acsCapabilityKeyIdEnv(): string | undefined {
  const key = process.env.DC_ACS_CAPABILITY_KEY_ID;
  return key && key.length > 0 ? key : undefined;
}

let cachedAcsKey: { env: string; key: crypto.KeyObject } | undefined;
function acsPublicKey(): crypto.KeyObject {
  const env = acsCapabilityPublicKeyEnv() as string;
  if (cachedAcsKey && cachedAcsKey.env === env) return cachedAcsKey.key;
  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey({ key: Buffer.from(env, 'base64url'), format: 'der', type: 'spki' });
  } catch (error) {
    throw new Error('DC_ACS_CAPABILITY_PUBLIC_KEY is not a valid base64url SPKI Ed25519 key: ' + (error instanceof Error ? error.message : String(error)));
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`DC_ACS_CAPABILITY_PUBLIC_KEY must be an Ed25519 key (got ${key.asymmetricKeyType})`);
  }
  cachedAcsKey = { env, key };
  return key;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function requireHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function requireIdString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

/** Base64url Ed25519 signatures are exactly 64 bytes (86 base64url chars). */
function isBase64urlSignature(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{86}$/.test(value);
}

/**
 * Verify an ACS-issued acs.dc.v1 capability envelope against the configured
 * public key. Checks, in order: envelope structure (MALFORMED), key id pin +
 * Ed25519 signature over strictCanonicalJsonV1(payload) (INVALID_SIGNATURE),
 * issuance window / 30s TTL ceiling (EXPIRED), tool match + scope coverage
 * (TOOL_MISMATCH), and binding of normalizedArguments to the actual request
 * args via structural equality plus the SAME invocation hash construction the
 * ACS side uses (ARGS_MISMATCH).
 */
export function verifyAcsCapability(
  envelope: unknown,
  request: { tool: string; args: Record<string, unknown>; now?: number },
): AcsCapabilityVerifyResult {
  const reject = (code: AcsCapabilityRejectionCode, reason: string): AcsCapabilityVerifyResult => ({ ok: false, code, reason });
  if (!isPlainRecord(envelope)) return reject('ACS_CAPABILITY_MALFORMED', 'capability envelope must be a plain object');
  const payload = envelope.payload;
  if (!isPlainRecord(payload)) return reject('ACS_CAPABILITY_MALFORMED', 'capability payload must be a plain object');
  if (payload.version !== ACS_CAPABILITY_VERSION) return reject('ACS_CAPABILITY_MALFORMED', `capability version must be ${ACS_CAPABILITY_VERSION}`);
  if (payload.issuer !== 'acs') return reject('ACS_CAPABILITY_MALFORMED', 'capability issuer must be "acs"');
  if (payload.audience !== 'desktop-commander') return reject('ACS_CAPABILITY_MALFORMED', 'capability audience must be "desktop-commander"');
  for (const field of ['runtimeId', 'workItemId', 'attemptId', 'leaseId', 'toolName'] as const) {
    if (!requireIdString(payload[field])) return reject('ACS_CAPABILITY_MALFORMED', `${field} must be a bounded non-empty string`);
  }
  if (typeof payload.leaseEpoch !== 'number' || !Number.isInteger(payload.leaseEpoch) || payload.leaseEpoch < 0) {
    return reject('ACS_CAPABILITY_MALFORMED', 'leaseEpoch must be a non-negative integer');
  }
  if (!isPlainRecord(payload.normalizedArguments)) return reject('ACS_CAPABILITY_MALFORMED', 'normalizedArguments must be a plain object');
  for (const field of ['invocationHash', 'actionHash', 'requestHash', 'planHash'] as const) {
    if (!requireHex64(payload[field])) return reject('ACS_CAPABILITY_MALFORMED', `${field} must be a lowercase sha256 hex digest`);
  }
  if (!Array.isArray(payload.scopes) || payload.scopes.length === 0
    || !payload.scopes.every((scope) => typeof scope === 'string' && (FIXED_ACS_SCOPES as readonly string[]).includes(scope))) {
    return reject('ACS_CAPABILITY_MALFORMED', 'scopes must be a non-empty array of fixed ACS scopes');
  }
  if (payload.approvalId !== undefined && !requireIdString(payload.approvalId)) {
    return reject('ACS_CAPABILITY_MALFORMED', 'approvalId must be a bounded non-empty string when present');
  }
  if (typeof payload.issuedAt !== 'string' || Number.isNaN(Date.parse(payload.issuedAt))
    || typeof payload.expiresAt !== 'string' || Number.isNaN(Date.parse(payload.expiresAt))) {
    return reject('ACS_CAPABILITY_MALFORMED', 'issuedAt/expiresAt must be ISO-8601 timestamps');
  }
  if (typeof payload.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(payload.nonce)) {
    return reject('ACS_CAPABILITY_MALFORMED', 'nonce must be 32 bytes of base64url');
  }
  const pinnedKeyId = acsCapabilityKeyIdEnv();
  if (pinnedKeyId && envelope.keyId !== pinnedKeyId) {
    return reject('ACS_CAPABILITY_INVALID_SIGNATURE', `capability keyId "${String(envelope.keyId)}" is not the pinned ACS key id`);
  }
  if (!isBase64urlSignature(envelope.signature)) {
    return reject('ACS_CAPABILITY_INVALID_SIGNATURE', 'signature must be a 64-byte base64url Ed25519 signature');
  }

  // Signature over the EXACT strict canonical signing bytes the ACS side uses.
  let canonicalBytes: Buffer;
  try {
    canonicalBytes = Buffer.from(strictCanonicalJsonV1(payload), 'utf8');
  } catch (error) {
    return reject('ACS_CAPABILITY_MALFORMED', `payload is not strict-canonicalizable: ${error instanceof Error ? error.message : String(error)}`);
  }
  let signatureValid = false;
  try {
    signatureValid = crypto.verify(null, canonicalBytes, acsPublicKey(), Buffer.from(envelope.signature as string, 'base64url'));
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return reject('ACS_CAPABILITY_INVALID_SIGNATURE', 'Ed25519 signature does not verify under DC_ACS_CAPABILITY_PUBLIC_KEY');

  // Time window: protocol TTL ceiling is 30 seconds; expired is expired.
  const now = request.now ?? Date.now();
  const issuedAtMs = Date.parse(payload.issuedAt as string);
  const expiresAtMs = Date.parse(payload.expiresAt as string);
  const ttlMs = expiresAtMs - issuedAtMs;
  if (!(ttlMs > 0) || ttlMs > 30_000 || now > expiresAtMs) {
    return reject('ACS_CAPABILITY_EXPIRED', `capability time window invalid or expired (issuedAt=${payload.issuedAt as string}, expiresAt=${payload.expiresAt as string}, ttlMs=${ttlMs})`);
  }

  // Tool + scope binding: the requested tool must be the capability's tool and
  // the capability scopes must cover every scope the tool's fixed policy needs.
  if (payload.toolName !== request.tool) {
    return reject('ACS_CAPABILITY_TOOL_MISMATCH', `capability authorizes tool "${payload.toolName}" but request targets "${request.tool}"`);
  }
  const policy = getManagedAcsToolPolicy(request.tool);
  if (!policy) return reject('ACS_CAPABILITY_TOOL_MISMATCH', `tool "${request.tool}" has no ACS v1 scope mapping`);
  const granted = payload.scopes as string[];
  const missing = policy.scopes.filter((scope) => !granted.includes(scope));
  if (missing.length > 0) {
    return reject('ACS_CAPABILITY_TOOL_MISMATCH', `capability scopes [${granted.join(', ')}] do not cover required scope(s) ${missing.join(', ')} for tool "${request.tool}"`);
  }

  // Argument binding (fail closed): the presented normalizedArguments must be
  // the EXACT arguments of this request (structural equality over strict
  // canonical JSON), and the invocationHash must be reproducible over the
  // actual args with the SAME construction the ACS side uses
  // (sha256("acs:desktop-commander-invocation:v1\n" + canonical JSON of
  // { toolName, arguments })). Normalization is the caller's duty (ACS
  // normalizes before minting); any drift is a mismatch, not a coercion.
  try {
    if (strictCanonicalJsonV1(payload.normalizedArguments) !== strictCanonicalJsonV1(request.args)) {
      return reject('ACS_CAPABILITY_ARGS_MISMATCH', 'capability normalizedArguments do not match the actual request arguments');
    }
  } catch (error) {
    return reject('ACS_CAPABILITY_ARGS_MISMATCH', `arguments are not strict-canonicalizable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const recomputedInvocationHash = computeDesktopCommanderInvocationHash(payload.toolName as string, request.args);
  if (recomputedInvocationHash !== payload.invocationHash) {
    return reject('ACS_CAPABILITY_ARGS_MISMATCH', `invocationHash mismatch (expected ${recomputedInvocationHash}, got ${payload.invocationHash as string})`);
  }

  const capabilityId = `acs.dc.v1:${sha256Hex(canonicalJson(payload)).slice(0, 32)}`;
  return {
    ok: true,
    attestation: {
      capabilityId,
      workItemId: payload.workItemId as string,
      attemptId: payload.attemptId as string,
      leaseId: payload.leaseId as string,
      leaseEpoch: payload.leaseEpoch as number,
    },
  };
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
  // On an ACS gateway-configured executor, omitting attribution must not
  // downgrade a request to the local lane. Direct ACS stdio runtimes without
  // a gateway key retain their separate transport contract.
  if (gatewayAttestationKey() && (acsCapabilityPublicKeyEnv() || gatewayFromMeta(ctx.meta))) {
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

  // 0b. ACS-issued capability verification (fail-closed). Only active when
  //     DC_ACS_CAPABILITY_PUBLIC_KEY is configured — env unset means behavior
  //     is unchanged (no new rejections, HMAC issuer path intact). When set,
  //     ANY presented _meta.capability is verified as an acs.dc.v1 Ed25519
  //     capability; a presented capability that fails verification is
  //     rejected REGARDLESS of DC_ENFORCEMENT (a presented trust token must
  //     be genuine, same fail-closed posture as the gateway attestation).
  //     This runs BEFORE the HMAC capability path below, which is bypassed
  //     entirely in ACS mode.
  let acsCapability: AcsCapabilityAttestation | undefined;
  const acsMode = !!acsCapabilityPublicKeyEnv();
  if (acsMode && !cap) {
    return {
      allowed: false,
      kind: 'capability-rejected',
      code: 'ACS_CAPABILITY_MALFORMED',
      message: 'ACS capability rejected: _meta.capability is required when DC_ACS_CAPABILITY_PUBLIC_KEY is configured',
      classification,
    };
  }
  if (acsMode && cap) {
    const acs = verifyAcsCapability(cap, { tool: ctx.tool, args: ctx.args, now });
    if (!acs.ok) {
      return {
        allowed: false,
        kind: 'capability-rejected',
        code: acs.code,
        message: `ACS capability rejected: ${acs.reason}`,
        classification,
      };
    }
    acsCapability = acs.attestation;
  }

  // 1. Capability verification — mandatory whenever one is presented.
  let verified: VerifyResult | undefined;
  if (cap && !acsMode) {
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
      ...(gatewayTrusted ? { gatewayTrusted, gatewayActor } : {}),
      ...(acsCapability ? { acsCapability } : {}) };
  }

  // 2. Network profile enforcement. An explicit 'none' is enforced locally:
  //    blocklisted network binaries are rejected outright for terminal-style
  //    commands. The RAW command string is scanned with a word-boundary regex
  //    per blocklisted basename (not argv tokens), so obfuscations like
  //    `"curl`, `(/usr/bin/curl` or `x=curl` cannot bypass the blocklist.
  //    (Sandbox wrapping of spawned processes happens in the terminal-manager
  //    via network-guard; this gate catches tool-level intent.)
  const networkProfile: NetworkProfile = (cap && !acsMode) ? cap.network
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
  if (cap && (verified?.ok || acsCapability)) {
    return {
      allowed: true,
      classification,
      capability: cap,
      ...(gatewayTrusted ? { gatewayTrusted, gatewayActor } : {}),
      ...(acsCapability ? { acsCapability } : {}),
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
  /**
   * Present when the request carried an ACS capability that verified under
   * DC_ACS_CAPABILITY_PUBLIC_KEY: envelope-derived attribution fields
   * (additive — old events without them still verify).
   */
  workItemId?: string;
  attemptId?: string;
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
      ...(event.workItemId ? { workItemId: event.workItemId } : {}),
      ...(event.attemptId ? { attemptId: event.attemptId } : {}),
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
