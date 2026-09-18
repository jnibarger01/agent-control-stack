/**
 * Capability-scoped authorization (kernel issue #3).
 *
 * Short-lived execution capabilities authorize a single (tool, paths,
 * commandClass, network) tuple. Verification is fail-closed: any request
 * broader than the granted capability is rejected with a structured
 * RejectionResult rather than an exception, so callers can render rejections.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strictCanonicalJsonV1 } from '../managed-acs.js';

export const CAPABILITY_VERSION = 'dc.capability.v1' as const;
export const DEFAULT_CAPABILITY_TTL_MS = 5 * 60 * 1000;
export const MAX_CAPABILITY_TTL_MS = 5 * 60 * 1000;

export type CommandClass = 'read-only' | 'local-write' | 'destructive' | 'secret' | 'external';
export type NetworkProfile = 'none' | 'restricted' | 'full';

const COMMAND_CLASS_RANK: Readonly<Record<CommandClass, number>> = Object.freeze({
  'read-only': 0,
  'local-write': 1,
  destructive: 2,
  secret: 2,
  external: 2,
});

const NETWORK_RANK: Readonly<Record<NetworkProfile, number>> = Object.freeze({
  none: 0,
  restricted: 1,
  full: 2,
});

export function isCommandClass(value: unknown): value is CommandClass {
  return typeof value === 'string' && value in COMMAND_CLASS_RANK;
}

export function isNetworkProfile(value: unknown): value is NetworkProfile {
  return typeof value === 'string' && value in NETWORK_RANK;
}

export interface ExecutionCapability {
  capabilityId: string;
  workItemId: string;
  agent: string;
  tool: string;
  paths: string[];
  commandClass: CommandClass;
  network: NetworkProfile;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

export interface CapabilityIssueRequest {
  workItemId: string;
  agent: string;
  tool: string;
  paths?: readonly string[];
  commandClass: CommandClass;
  network: NetworkProfile;
  ttlMs?: number;
  issuedAt?: number;
}

export interface CapabilityVerifyRequest {
  tool: string;
  paths?: readonly string[];
  commandClass: CommandClass;
  network: NetworkProfile;
  now?: number;
}

export type CapabilityRejectionCode =
  | 'CAPABILITY_MALFORMED'
  | 'CAPABILITY_SIGNATURE_INVALID'
  | 'CAPABILITY_EXPIRED'
  | 'CAPABILITY_TOOL_MISMATCH'
  | 'CAPABILITY_PATH_ESCALATION'
  | 'CAPABILITY_COMMAND_CLASS_ESCALATION'
  | 'CAPABILITY_NETWORK_ESCALATION';

export interface RejectionResult {
  ok: false;
  code: CapabilityRejectionCode;
  reason: string;
}

export interface AcceptResult {
  ok: true;
  capability: ExecutionCapability;
}

export type VerifyResult = AcceptResult | RejectionResult;

function rejection(code: CapabilityRejectionCode, reason: string): RejectionResult {
  return { ok: false, code, reason };
}

export function canonicalCapabilityPayload(cap: Omit<ExecutionCapability, 'signature'>): string {
  return strictCanonicalJsonV1(cap);
}

export function signCapabilityPayload(payload: string, key: Buffer | string): string {
  return crypto.createHmac('sha256', key).update(payload, 'utf8').digest('base64url');
}

export function verifyCapabilitySignature(cap: ExecutionCapability, key: Buffer | string): boolean {
  const { signature, ...rest } = cap;
  if (typeof signature !== 'string' || signature.length === 0) return false;
  let payload: string;
  try {
    payload = canonicalCapabilityPayload(rest as Omit<ExecutionCapability, 'signature'>);
  } catch {
    return false;
  }
  const expected = signCapabilityPayload(payload, key);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface CapabilityIssuer {
  issue(request: CapabilityIssueRequest): ExecutionCapability;
}

function assertFiniteTimestamp(name: string, value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a safe integer epoch milliseconds`);
  }
}

export function issueCapabilityWithKey(
  request: CapabilityIssueRequest,
  key: Buffer | string,
  capabilityId: string = crypto.randomUUID(),
): ExecutionCapability {
  const issuedAt = request.issuedAt ?? Date.now();
  const ttlMs = request.ttlMs ?? DEFAULT_CAPABILITY_TTL_MS;
  assertFiniteTimestamp('issuedAt', issuedAt);
  assertFiniteTimestamp('ttlMs', ttlMs);
  if (ttlMs <= 0 || ttlMs > MAX_CAPABILITY_TTL_MS) {
    throw new RangeError(`capability ttlMs must be in (0, ${MAX_CAPABILITY_TTL_MS}]`);
  }
  const unsigned = {
    capabilityId,
    workItemId: request.workItemId,
    agent: request.agent,
    tool: request.tool,
    paths: [...(request.paths ?? [])],
    commandClass: request.commandClass,
    network: request.network,
    issuedAt,
    expiresAt: issuedAt + ttlMs,
  };
  const signature = signCapabilityPayload(canonicalCapabilityPayload(unsigned), key);
  return Object.freeze({ ...unsigned, signature });
}

function pathIsWithinRoot(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

export function verifyCapability(
  cap: ExecutionCapability,
  request: CapabilityVerifyRequest,
  key: Buffer | string,
): VerifyResult {
  const now = request.now ?? Date.now();
  if (
    cap === null
    || typeof cap !== 'object'
    || typeof cap.capabilityId !== 'string'
    || typeof cap.workItemId !== 'string'
    || typeof cap.agent !== 'string'
    || typeof cap.tool !== 'string'
    || !Array.isArray(cap.paths)
    || !cap.paths.every((entry) => typeof entry === 'string')
    || !isCommandClass(cap.commandClass)
    || !isNetworkProfile(cap.network)
    || !Number.isSafeInteger(cap.issuedAt)
    || !Number.isSafeInteger(cap.expiresAt)
    || typeof cap.signature !== 'string'
  ) {
    return rejection('CAPABILITY_MALFORMED', 'capability is missing or has fields of the wrong type');
  }
  if (cap.expiresAt <= cap.issuedAt || cap.expiresAt - cap.issuedAt > MAX_CAPABILITY_TTL_MS) {
    return rejection('CAPABILITY_MALFORMED', 'capability validity window is malformed or exceeds the maximum TTL');
  }
  if (!verifyCapabilitySignature(cap, key)) {
    return rejection('CAPABILITY_SIGNATURE_INVALID', 'capability HMAC signature does not verify');
  }
  if (now >= cap.expiresAt) {
    return rejection('CAPABILITY_EXPIRED', `capability expired at ${new Date(cap.expiresAt).toISOString()}`);
  }
  if (request.tool !== cap.tool) {
    return rejection(
      'CAPABILITY_TOOL_MISMATCH',
      `capability grants tool '${cap.tool}' but request is for '${request.tool}'`,
    );
  }
  if (COMMAND_CLASS_RANK[request.commandClass] > COMMAND_CLASS_RANK[cap.commandClass]) {
    return rejection(
      'CAPABILITY_COMMAND_CLASS_ESCALATION',
      `capability grants '${cap.commandClass}' but request requires '${request.commandClass}'`,
    );
  }
  if (NETWORK_RANK[request.network] > NETWORK_RANK[cap.network]) {
    return rejection(
      'CAPABILITY_NETWORK_ESCALATION',
      `capability grants network '${cap.network}' but request requires '${request.network}'`,
    );
  }
  for (const requestedPath of request.paths ?? []) {
    if (typeof requestedPath !== 'string' || !path.isAbsolute(requestedPath)) {
      return rejection('CAPABILITY_PATH_ESCALATION', `requested path is not absolute: ${String(requestedPath)}`);
    }
    const match = cap.paths.some((root) => pathIsWithinRoot(requestedPath, root));
    if (!match) {
      return rejection(
        'CAPABILITY_PATH_ESCALATION',
        `requested path '${requestedPath}' is outside the granted roots [${cap.paths.join(', ')}]`,
      );
    }
  }
  return { ok: true, capability: cap };
}

const DEFAULT_KEY_PATH = path.join(os.homedir(), '.desktop-commander', 'capability-key');

/**
 * Local (non-ACS) capability issuer. Signs capabilities with HMAC-SHA256 over
 * the strict canonical JSON payload. The key comes from DC_CAPABILITY_KEY or
 * is auto-generated and persisted at ~/.desktop-commander/capability-key with
 * mode 0600. The key material is never logged or included in any error/result.
 */
export class LocalCapabilityIssuer implements CapabilityIssuer {
  private key: Buffer | undefined;

  constructor(private readonly keyPath: string = process.env.DC_CAPABILITY_KEY_PATH ?? DEFAULT_KEY_PATH) {}

  getKey(): Buffer {
    if (this.key) return this.key;
    const fromEnv = process.env.DC_CAPABILITY_KEY;
    if (fromEnv && fromEnv.length > 0) {
      this.key = Buffer.from(fromEnv, 'utf8');
      return this.key;
    }
    try {
      fs.mkdirSync(path.dirname(this.keyPath), { recursive: true, mode: 0o700 });
      const descriptor = fs.openSync(this.keyPath, 'a+', 0o600);
      try {
        fs.fchmodSync(descriptor, 0o600);
        const size = fs.fstatSync(descriptor).size;
        if (size === 0) {
          const material = crypto.randomBytes(32);
          fs.writeFileSync(descriptor, material.toString('base64url'));
          fs.fsyncSync(descriptor);
        }
      } finally {
        fs.closeSync(descriptor);
      }
      const raw = fs.readFileSync(this.keyPath, 'utf8').trim();
      if (raw.length === 0) {
        throw new Error('capability key file is empty');
      }
      this.key = Buffer.from(raw, 'base64url');
      return this.key;
    } catch (error) {
      // Fail closed without leaking key material into the error message.
      throw new Error(`unable to load or create capability key at the configured key path: ${(error as NodeJS.ErrnoException).code ?? 'error'}`);
    }
  }

  issue(request: CapabilityIssueRequest): ExecutionCapability {
    return issueCapabilityWithKey(request, this.getKey());
  }

  verify(cap: ExecutionCapability, request: CapabilityVerifyRequest): VerifyResult {
    return verifyCapability(cap, request, this.getKey());
  }
}
