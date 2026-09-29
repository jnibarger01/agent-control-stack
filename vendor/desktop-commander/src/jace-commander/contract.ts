/**
 * acs.jc.v1 — ACS-issued capability contract for the Jace Commander MCP.
 *
 * Deliberately a SEPARATE capability version/audience from acs.dc.v1:
 * acs.dc.v1 fixes its scope vocabulary and forbids privilege escalation, and
 * its contract says new semantics require a new version. acs.jc.v1 reuses the
 * exact same envelope shape, strict canonicalization, Ed25519 signature, time
 * window and nonce rules (docs/jace-commander.md §Contract), and adds:
 *
 *   - audience `jace-commander`, version `acs.jc.v1`
 *   - scopes `integration.read`, `integration.write`, `process.privileged`
 *   - invocation hash domain `acs:jace-commander-invocation:v1`
 *
 * ACS is the sole issuer. This module only verifies. There is intentionally
 * no signing code outside tests: any key on this machine that could mint a
 * `process.privileged` capability would be a sudo bypass.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { strictCanonicalJsonV1 } from '../managed-acs.js';
import { JC_MANIFEST } from './manifest.generated.js';

export const JC_CAPABILITY_VERSION = 'acs.jc.v1' as const;
export const JC_AUDIENCE = 'jace-commander' as const;
export const JC_INVOCATION_DOMAIN = 'acs:jace-commander-invocation:v1';

/**
 * Scope vocabulary and per-tool policy come from the generated copy of the
 * canonical manifest (packages/jc-tool-manifest in agent-control-stack; see
 * manifest.generated.ts). ACS signs from the same manifest, so a tool, scope
 * or approval rule can no longer be added to one side and not the other.
 */
export const JC_SCOPES: readonly string[] = Object.freeze([...JC_MANIFEST.scopes]);
export type JcScope = string;

export interface JcToolPolicy {
  scopes: readonly JcScope[];
  requiresApproval: boolean;
}

/**
 * Every tool the server registers MUST appear here; server.ts asserts it at
 * startup. Approval requirements are the manifest's: every tool whose
 * manifest entry has `requiresApproval` (privileged_exec, write_file,
 * create_directory, move_file, edit_block, start_process, kill_process,
 * git_add, git_commit, git_fetch, git_push) must carry an approvalId, and no
 * other tool may.
 */
export const JC_TOOL_POLICIES: Readonly<Record<string, JcToolPolicy>> = Object.freeze(
  Object.fromEntries(
    JC_MANIFEST.tools.map((tool) => [
      tool.name,
      Object.freeze({ scopes: Object.freeze([...tool.scopes]), requiresApproval: tool.requiresApproval }),
    ]),
  ),
);

export type JcRejectionCode =
  | 'JC_CAPABILITY_MISSING'
  | 'JC_CAPABILITY_MALFORMED'
  | 'JC_CAPABILITY_EXTRA_FIELD'
  | 'JC_CAPABILITY_KEY_UNKNOWN'
  | 'JC_CAPABILITY_SIGNATURE_INVALID'
  | 'JC_CAPABILITY_VERSION_INVALID'
  | 'JC_CAPABILITY_ISSUER_INVALID'
  | 'JC_CAPABILITY_AUDIENCE_INVALID'
  | 'JC_CAPABILITY_RUNTIME_MISMATCH'
  | 'JC_CAPABILITY_ID_INVALID'
  | 'JC_CAPABILITY_TOOL_MISMATCH'
  | 'JC_CAPABILITY_TOOL_UNKNOWN'
  | 'JC_CAPABILITY_ARGUMENTS_MISMATCH'
  | 'JC_CAPABILITY_INVOCATION_HASH_MISMATCH'
  | 'JC_CAPABILITY_HASH_INVALID'
  | 'JC_CAPABILITY_SCOPE_MISMATCH'
  | 'JC_CAPABILITY_APPROVAL_REQUIRED'
  | 'JC_CAPABILITY_APPROVAL_FORBIDDEN'
  | 'JC_CAPABILITY_TIME_INVALID'
  | 'JC_CAPABILITY_NONCE_INVALID'
  | 'JC_CAPABILITY_NONCE_REPLAY';

export class JcAuthorizationError extends Error {
  constructor(public readonly code: JcRejectionCode) {
    super(`Jace Commander authorization rejected (${code})`);
    this.name = 'JcAuthorizationError';
  }
}

function reject(code: JcRejectionCode): never {
  throw new JcAuthorizationError(code);
}

const ENVELOPE_KEYS = Object.freeze(['keyId', 'payload', 'signature']);
const BASE_PAYLOAD_KEYS = Object.freeze([
  'actionHash', 'attemptId', 'audience', 'expiresAt', 'invocationHash', 'issuedAt', 'issuer',
  'leaseEpoch', 'leaseId', 'nonce', 'normalizedArguments', 'planHash', 'requestHash',
  'runtimeId', 'scopes', 'toolName', 'version', 'workItemId',
]);
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const B64URL_64 = /^[A-Za-z0-9_-]{86}$/;
const RFC3339_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const JC_CLOCK_SKEW_MS = 5_000;
export const JC_MAX_TTL_MS = 30_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function requireExactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(record);
  const allowed = new Set(expected);
  if (actual.some((key) => !allowed.has(key))) reject('JC_CAPABILITY_EXTRA_FIELD');
  if (actual.length !== expected.length) reject('JC_CAPABILITY_MALFORMED');
}

function decodeB64Url(value: unknown, pattern: RegExp, bytes: number): Buffer | undefined {
  if (typeof value !== 'string' || !pattern.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== bytes || decoded.toString('base64url') !== value) return undefined;
  return decoded;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && RFC3339_MS.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  try {
    return strictCanonicalJsonV1(left) === strictCanonicalJsonV1(right);
  } catch {
    return false;
  }
}

export function computeJcInvocationHash(toolName: string, normalizedArguments: Record<string, unknown>): string {
  const canonical = strictCanonicalJsonV1({ toolName, arguments: normalizedArguments });
  return crypto.createHash('sha256').update(`${JC_INVOCATION_DOMAIN}\n${canonical}`, 'utf8').digest('hex');
}

/**
 * Drops keys whose value is `undefined` (absent) and nothing else. No path
 * resolution, defaulting or coercion: the delivered request must carry the
 * exact arguments ACS bound.
 */
export function jcAuthorizationArguments(delivered: unknown): Record<string, unknown> {
  if (!isPlainObject(delivered)) reject('JC_CAPABILITY_ARGUMENTS_MISMATCH');
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(delivered)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function loadEd25519PublicKey(encoded: string | undefined): crypto.KeyObject {
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded) || Buffer.from(encoded, 'base64url').toString('base64url') !== encoded) {
    reject('JC_CAPABILITY_KEY_UNKNOWN');
  }
  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey({ key: Buffer.from(encoded, 'base64url'), format: 'der', type: 'spki' });
  } catch {
    reject('JC_CAPABILITY_KEY_UNKNOWN');
  }
  if (key.asymmetricKeyType !== 'ed25519') reject('JC_CAPABILITY_KEY_UNKNOWN');
  return key;
}

/**
 * Single-use nonce reservation backed by one file per nonce digest created
 * with O_EXCL, so two processes (or the MCP server and the privileged helper
 * sharing a store) cannot both win. Store unavailability fails closed.
 */
export class FileNonceStore {
  constructor(private readonly directory: string, private readonly maxEntries = 10_000) {}

  reserve(key: string, retainUntil: number, now: number): void {
    const dir = path.resolve(this.directory);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      let retained = 0;
      for (const entry of fs.readdirSync(dir)) {
        if (!/^[a-f0-9]{64}$/.test(entry)) continue;
        const entryPath = path.join(dir, entry);
        const expiry = Number(fs.readFileSync(entryPath, 'utf8'));
        // Only delete entries that are provably expired; unreadable ones stay.
        if (Number.isSafeInteger(expiry) && expiry <= now) {
          fs.rmSync(entryPath, { force: true });
          continue;
        }
        retained += 1;
      }
      if (retained >= this.maxEntries) reject('JC_CAPABILITY_NONCE_REPLAY');
      const digest = crypto.createHash('sha256').update(key, 'utf8').digest('hex');
      const fd = fs.openSync(path.join(dir, digest), 'wx', 0o600);
      try {
        fs.writeFileSync(fd, String(retainUntil));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      if (error instanceof JcAuthorizationError) throw error;
      // EEXIST is the replay case; every other I/O failure also fails closed.
      reject('JC_CAPABILITY_NONCE_REPLAY');
    }
  }
}

export interface JcVerifierOptions {
  publicKey: string | undefined;
  keyId: string | undefined;
  runtimeId: string;
  nonceStore: FileNonceStore;
  now?: () => number;
}

export interface JcAuthorization {
  version: typeof JC_CAPABILITY_VERSION;
  keyId: string;
  runtimeId: string;
  workItemId: string;
  attemptId: string;
  leaseId: string;
  leaseEpoch: number;
  toolName: string;
  scopes: readonly JcScope[];
  approvalId?: string;
  invocationHash: string;
  actionHash: string;
  requestHash: string;
  planHash: string;
  nonceHash: string;
  authorizedAt: string;
}

export class JcCapabilityVerifier {
  private readonly now: () => number;
  private publicKey: crypto.KeyObject | undefined;

  constructor(private readonly options: JcVerifierOptions) {
    this.now = options.now ?? Date.now;
    if (!ID_PATTERN.test(options.runtimeId)) throw new TypeError('runtimeId must match the ACS ID grammar');
  }

  /** Verifies `envelope` for exactly (toolName, deliveredArguments); reserves the nonce on success. */
  verify(toolName: string, deliveredArguments: unknown, envelope: unknown): JcAuthorization {
    if (envelope === undefined) reject('JC_CAPABILITY_MISSING');
    if (!isPlainObject(envelope)) reject('JC_CAPABILITY_MALFORMED');
    requireExactKeys(envelope, ENVELOPE_KEYS);
    if (typeof envelope.keyId !== 'string' || !KEY_ID_PATTERN.test(envelope.keyId)) reject('JC_CAPABILITY_MALFORMED');
    if (!this.options.keyId || envelope.keyId !== this.options.keyId) reject('JC_CAPABILITY_KEY_UNKNOWN');
    const signature = decodeB64Url(envelope.signature, B64URL_64, 64);
    if (!signature || !isPlainObject(envelope.payload)) reject('JC_CAPABILITY_MALFORMED');

    const payload = envelope.payload;
    const hasApproval = Object.prototype.hasOwnProperty.call(payload, 'approvalId');
    requireExactKeys(payload, hasApproval ? [...BASE_PAYLOAD_KEYS, 'approvalId'] : BASE_PAYLOAD_KEYS);

    let signedBytes: Buffer;
    try {
      signedBytes = Buffer.from(strictCanonicalJsonV1(payload), 'utf8');
    } catch {
      reject('JC_CAPABILITY_MALFORMED');
    }
    this.publicKey ??= loadEd25519PublicKey(this.options.publicKey);
    if (!crypto.verify(null, signedBytes, this.publicKey, signature)) reject('JC_CAPABILITY_SIGNATURE_INVALID');

    // Signature is valid from here on: remaining checks bind it to THIS call.
    if (payload.version !== JC_CAPABILITY_VERSION) reject('JC_CAPABILITY_VERSION_INVALID');
    if (payload.issuer !== 'acs') reject('JC_CAPABILITY_ISSUER_INVALID');
    if (payload.audience !== JC_AUDIENCE) reject('JC_CAPABILITY_AUDIENCE_INVALID');
    if (payload.runtimeId !== this.options.runtimeId) reject('JC_CAPABILITY_RUNTIME_MISMATCH');
    for (const field of ['workItemId', 'attemptId', 'leaseId'] as const) {
      if (typeof payload[field] !== 'string' || !ID_PATTERN.test(payload[field] as string)) reject('JC_CAPABILITY_ID_INVALID');
    }
    if (!Number.isSafeInteger(payload.leaseEpoch) || (payload.leaseEpoch as number) < 0) reject('JC_CAPABILITY_ID_INVALID');
    if (payload.toolName !== toolName) reject('JC_CAPABILITY_TOOL_MISMATCH');
    const toolPolicy = JC_TOOL_POLICIES[toolName];
    if (!toolPolicy) reject('JC_CAPABILITY_TOOL_UNKNOWN');

    const bound = jcAuthorizationArguments(deliveredArguments);
    if (!isPlainObject(payload.normalizedArguments) || !canonicalEqual(payload.normalizedArguments, bound)) {
      reject('JC_CAPABILITY_ARGUMENTS_MISMATCH');
    }
    if (payload.invocationHash !== computeJcInvocationHash(toolName, payload.normalizedArguments)) {
      reject('JC_CAPABILITY_INVOCATION_HASH_MISMATCH');
    }
    for (const field of ['actionHash', 'requestHash', 'planHash'] as const) {
      if (typeof payload[field] !== 'string' || !HASH_PATTERN.test(payload[field] as string)) reject('JC_CAPABILITY_HASH_INVALID');
    }
    if (!canonicalEqual(payload.scopes, toolPolicy.scopes)) reject('JC_CAPABILITY_SCOPE_MISMATCH');
    if (toolPolicy.requiresApproval && (!hasApproval || typeof payload.approvalId !== 'string' || !ID_PATTERN.test(payload.approvalId))) {
      reject('JC_CAPABILITY_APPROVAL_REQUIRED');
    }
    if (!toolPolicy.requiresApproval && hasApproval) reject('JC_CAPABILITY_APPROVAL_FORBIDDEN');

    if (!validTimestamp(payload.issuedAt) || !validTimestamp(payload.expiresAt)) reject('JC_CAPABILITY_TIME_INVALID');
    const issuedAt = Date.parse(payload.issuedAt);
    const expiresAt = Date.parse(payload.expiresAt);
    const now = this.now();
    if (
      issuedAt > now + JC_CLOCK_SKEW_MS
      || expiresAt <= now - JC_CLOCK_SKEW_MS
      || expiresAt <= issuedAt
      || expiresAt - issuedAt > JC_MAX_TTL_MS
    ) reject('JC_CAPABILITY_TIME_INVALID');

    if (!decodeB64Url(payload.nonce, B64URL_32, 32)) reject('JC_CAPABILITY_NONCE_INVALID');
    const nonceKey = `${envelope.keyId}:${payload.nonce}`;
    this.options.nonceStore.reserve(nonceKey, expiresAt + JC_CLOCK_SKEW_MS, now);

    return Object.freeze({
      version: JC_CAPABILITY_VERSION,
      keyId: envelope.keyId,
      runtimeId: payload.runtimeId as string,
      workItemId: payload.workItemId as string,
      attemptId: payload.attemptId as string,
      leaseId: payload.leaseId as string,
      leaseEpoch: payload.leaseEpoch as number,
      toolName,
      scopes: toolPolicy.scopes,
      ...(hasApproval ? { approvalId: payload.approvalId as string } : {}),
      invocationHash: payload.invocationHash as string,
      actionHash: payload.actionHash as string,
      requestHash: payload.requestHash as string,
      planHash: payload.planHash as string,
      // One-way only: raw nonces are never logged or persisted.
      nonceHash: crypto.createHash('sha256').update(nonceKey, 'utf8').digest('hex'),
      authorizedAt: new Date(now).toISOString(),
    });
  }
}
