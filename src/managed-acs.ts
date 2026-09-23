import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ACS_CAPABILITY_VERSION = 'acs.dc.v1' as const;
export const FIXED_ACS_SCOPES = Object.freeze([
  'fs.read',
  'fs.write',
  'network.read',
  'network.write',
  'process.exec',
  'process.spawn',
] as const);

export type DesktopCommanderExecutionMode = 'managed' | 'standalone';
export type AcsScope = typeof FIXED_ACS_SCOPES[number];

export type ManagedAcsRejectionCode =
  | 'ACS_CAPABILITY_MISSING'
  | 'ACS_CAPABILITY_MALFORMED'
  | 'ACS_CAPABILITY_EXTRA_FIELD'
  | 'ACS_CAPABILITY_KEY_UNKNOWN'
  | 'ACS_CAPABILITY_SIGNATURE_INVALID'
  | 'ACS_CAPABILITY_VERSION_INVALID'
  | 'ACS_CAPABILITY_ISSUER_INVALID'
  | 'ACS_CAPABILITY_AUDIENCE_INVALID'
  | 'ACS_CAPABILITY_RUNTIME_MISMATCH'
  | 'ACS_CAPABILITY_WORK_ITEM_MISMATCH'
  | 'ACS_CAPABILITY_ATTEMPT_MISMATCH'
  | 'ACS_CAPABILITY_LEASE_MISMATCH'
  | 'ACS_CAPABILITY_EPOCH_MISMATCH'
  | 'ACS_CAPABILITY_TOOL_MISMATCH'
  | 'ACS_CAPABILITY_ARGUMENTS_MISMATCH'
  | 'ACS_CAPABILITY_INVOCATION_HASH_MISMATCH'
  | 'ACS_CAPABILITY_ACTION_HASH_MISMATCH'
  | 'ACS_CAPABILITY_REQUEST_HASH_MISMATCH'
  | 'ACS_CAPABILITY_PLAN_HASH_MISMATCH'
  | 'ACS_CAPABILITY_SCOPE_MISMATCH'
  | 'ACS_CAPABILITY_APPROVAL_REQUIRED'
  | 'ACS_CAPABILITY_APPROVAL_FORBIDDEN'
  | 'ACS_CAPABILITY_TIME_INVALID'
  | 'ACS_CAPABILITY_NONCE_INVALID'
  | 'ACS_CAPABILITY_NONCE_REPLAY'
  | 'ACS_RUNTIME_IDENTITY_MISSING'
  | 'ACS_RUNTIME_IDENTITY_DRIFT'
  | 'ACS_RUNTIME_IDENTITY_REVOKED';

export class ManagedAcsAuthorizationError extends Error {
  constructor(public readonly code: ManagedAcsRejectionCode) {
    super(`Desktop Commander managed authorization rejected (${code})`);
    this.name = 'ManagedAcsAuthorizationError';
  }
}

export interface ManagedToolPolicy {
  scopes: readonly AcsScope[];
  requiresApproval: boolean;
}

const FS_READ_POLICY = Object.freeze({ scopes: ['fs.read'] as const, requiresApproval: false });
const FS_WRITE_POLICY = Object.freeze({ scopes: ['fs.write'] as const, requiresApproval: true });
const PROCESS_READ_POLICY = Object.freeze({ scopes: ['process.exec'] as const, requiresApproval: false });
const TOOL_POLICIES: Readonly<Record<string, ManagedToolPolicy>> = Object.freeze({
  get_config: FS_READ_POLICY,
  get_file_info: FS_READ_POLICY,
  get_usage_stats: PROCESS_READ_POLICY,
  list_directory: FS_READ_POLICY,
  read_file: FS_READ_POLICY,
  read_multiple_files: FS_READ_POLICY,
  list_processes: PROCESS_READ_POLICY,
  list_sessions: PROCESS_READ_POLICY,
  read_process_output: PROCESS_READ_POLICY,
  create_directory: FS_WRITE_POLICY,
  edit_block: FS_WRITE_POLICY,
  move_file: FS_WRITE_POLICY,
  write_file: FS_WRITE_POLICY,
  start_process: Object.freeze({ scopes: ['process.spawn'] as const, requiresApproval: true }),
  get_runtime_identity: PROCESS_READ_POLICY,
  start_search: FS_READ_POLICY,
  get_more_search_results: FS_READ_POLICY,
  list_searches: FS_READ_POLICY,
  health: PROCESS_READ_POLICY,
  last_error: PROCESS_READ_POLICY,
  capability_manifest: PROCESS_READ_POLICY,
  operation_preview: FS_READ_POLICY,
  git_state: FS_READ_POLICY,
  verify_head: FS_READ_POLICY,
  secret_scan: FS_READ_POLICY,
  wait_for_process: PROCESS_READ_POLICY,
  run_command: Object.freeze({ scopes: ['process.spawn'] as const, requiresApproval: true }),
  terminate_process: Object.freeze({ scopes: ['process.exec'] as const, requiresApproval: true }),
  apply_patch: FS_WRITE_POLICY,
  snapshot_path: FS_WRITE_POLICY,
  restore_snapshot: FS_WRITE_POLICY,
});

/**
 * Explicit managed-mode disposition for every tool Desktop Commander
 * registers (src/tools/schemas.ts toolArgSchemas). Mirrors ACS's
 * desktopCommanderManagedToolDispositions and is pinned by
 * test/fixtures/acs-managed-tool-coverage.v1.json (byte-identical copy of the
 * ACS contract). A newly registered tool without an entry here fails
 * test/test-managed-authorization-contract.js.
 *
 * This is NOT a DC authorization decision: `capability` tools still require a
 * verified ACS capability per call; `unsupported` tools are simply never
 * advertised or executed in managed mode (ACS denies them with
 * managed_tool_unsupported before any capability exists).
 */
export type ManagedToolClass =
  | 'read_only'
  | 'filesystem_mutation'
  | 'process_execution'
  | 'process_control'
  | 'configuration_mutation'
  | 'unsupported';

export interface ManagedToolDisposition {
  toolClass: ManagedToolClass;
  managed: 'capability' | 'unsupported';
}

const cap = (toolClass: ManagedToolClass): ManagedToolDisposition => Object.freeze({ toolClass, managed: 'capability' as const });
const unsupported = (toolClass: ManagedToolClass): ManagedToolDisposition => Object.freeze({ toolClass, managed: 'unsupported' as const });

const MANAGED_TOOL_DISPOSITIONS: Readonly<Record<string, ManagedToolDisposition>> = Object.freeze({
  get_config: cap('read_only'),
  get_runtime_identity: cap('read_only'),
  get_file_info: cap('read_only'),
  list_directory: cap('read_only'),
  read_file: cap('read_only'),
  read_multiple_files: cap('read_only'),
  start_search: cap('read_only'),
  get_more_search_results: cap('read_only'),
  list_searches: cap('read_only'),
  list_sessions: cap('read_only'),
  list_processes: cap('read_only'),
  read_process_output: cap('read_only'),
  get_usage_stats: cap('read_only'),
  create_directory: cap('filesystem_mutation'),
  write_file: cap('filesystem_mutation'),
  edit_block: cap('filesystem_mutation'),
  move_file: cap('filesystem_mutation'),
  write_pdf: unsupported('filesystem_mutation'),
  start_process: cap('process_execution'),
  interact_with_process: unsupported('process_execution'),
  acpx_list_sessions: unsupported('process_execution'),
  acpx_get_session: unsupported('process_execution'),
  acpx_exec: unsupported('process_execution'),
  acpx_prompt: unsupported('process_execution'),
  kill_process: unsupported('process_control'),
  force_terminate: unsupported('process_control'),
  stop_search: unsupported('process_control'),
  acpx_cancel: unsupported('process_control'),
  set_config_value: unsupported('configuration_mutation'),
  get_recent_tool_calls: unsupported('unsupported'),
  get_prompts: unsupported('unsupported'),
  give_feedback_to_desktop_commander: unsupported('unsupported'),
  track_ui_event: unsupported('unsupported'),
  health: cap('read_only'),
  last_error: cap('read_only'),
  capability_manifest: cap('read_only'),
  operation_preview: cap('read_only'),
  git_state: cap('read_only'),
  verify_head: cap('read_only'),
  secret_scan: cap('read_only'),
  wait_for_process: cap('read_only'),
  service_status: unsupported('read_only'),
  run_command: cap('process_execution'),
  terminate_process: cap('process_control'),
  apply_patch: cap('filesystem_mutation'),
  snapshot_path: cap('filesystem_mutation'),
  restore_snapshot: cap('filesystem_mutation'),
});

export function listManagedToolDispositions(): Readonly<Record<string, ManagedToolDisposition>> {
  return MANAGED_TOOL_DISPOSITIONS;
}

/**
 * Canonical authorizationArguments contract (acs.dc.v1), shared with ACS
 * (packages/desktop-commander-adapter/src/authorization-arguments.ts) and
 * pinned by test/fixtures/acs-authorization-arguments.v1.json.
 *
 * Transport-metadata keys are validated and removed; `undefined` is absent.
 * NOTHING else is normalized here: no path resolution, no default
 * materialization, no type coercion, no array reordering. The delivered
 * request must already carry the exact arguments ACS bound; key order is
 * irrelevant because comparison is over strict canonical JSON.
 */
export const DC_TRANSPORT_METADATA_ARGUMENT_KEYS = Object.freeze(['origin'] as const);
const TRANSPORT_METADATA_VALUES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  origin: Object.freeze(['ui', 'llm']),
});

export class AuthorizationArgumentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationArgumentsError';
  }
}

export function authorizationArguments(delivered: unknown): Record<string, unknown> {
  if (!isPlainObject(delivered)) throw new AuthorizationArgumentsError('tool arguments must be a plain object');
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(delivered)) {
    if ((DC_TRANSPORT_METADATA_ARGUMENT_KEYS as readonly string[]).includes(key)) {
      const allowed = TRANSPORT_METADATA_VALUES[key] ?? [];
      if (typeof value !== 'string' || !allowed.includes(value)) {
        throw new AuthorizationArgumentsError(`transport metadata '${key}' is invalid`);
      }
      continue;
    }
    if (value === undefined) continue;
    result[key] = value;
  }
  return result;
}

export function isManagedAcsToolName(toolName: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_POLICIES, toolName);
}

export function getManagedAcsToolPolicy(toolName: string): ManagedToolPolicy | undefined {
  return TOOL_POLICIES[toolName];
}

export function listManagedAcsToolPolicies(): Readonly<Record<string, ManagedToolPolicy>> {
  return TOOL_POLICIES;
}

const ENVELOPE_KEYS = ['keyId', 'payload', 'signature'];
const BASE_PAYLOAD_KEYS = [
  'actionHash',
  'attemptId',
  'audience',
  'expiresAt',
  'invocationHash',
  'issuedAt',
  'issuer',
  'leaseEpoch',
  'leaseId',
  'nonce',
  'normalizedArguments',
  'planHash',
  'requestHash',
  'runtimeId',
  'scopes',
  'toolName',
  'version',
  'workItemId',
];
const BOOTSTRAP_KEYS = ['challenge', 'runtimeId', 'schemaVersion', 'scopes'];
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const TOOL_PATTERN = /^[\x21-\x7e]{1,128}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const BASE64URL_32_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_64_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const RFC3339_MILLISECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CLOCK_SKEW_MS = 5_000;
const MAX_CAPABILITY_TTL_MS = 30_000;
const DEFAULT_MAX_REPLAY_ENTRIES = 10_000;

function reject(code: ManagedAcsRejectionCode): never {
  throw new ManagedAcsAuthorizationError(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sortedOwnKeys(value: Record<string, unknown>): string[] {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    throw new TypeError('strict canonical JSON rejects symbol keys');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of ownKeys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable) throw new TypeError('strict canonical JSON rejects non-enumerable properties');
    if ('get' in descriptor || 'set' in descriptor) throw new TypeError('strict canonical JSON rejects accessors');
  }
  return (ownKeys as string[]).sort();
}

export function strictCanonicalJsonV1(value: unknown): string {
  const active = new Set<object>();

  const serialize = (entry: unknown): string => {
    if (entry === null || typeof entry === 'boolean' || typeof entry === 'string') {
      return JSON.stringify(entry);
    }
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw new TypeError('strict canonical JSON requires finite numbers');
      return JSON.stringify(entry);
    }
    if (entry === undefined) throw new TypeError('strict canonical JSON rejects undefined');
    if (typeof entry === 'bigint' || typeof entry === 'symbol' || typeof entry === 'function') {
      throw new TypeError(`strict canonical JSON rejects ${typeof entry}`);
    }
    if (active.has(entry)) throw new TypeError('strict canonical JSON rejects cycles');
    active.add(entry);
    try {
      if (Array.isArray(entry)) {
        if (Object.getPrototypeOf(entry) !== Array.prototype) {
          throw new TypeError('strict canonical JSON requires a plain array');
        }
        const ownKeys = Reflect.ownKeys(entry);
        const allowedKeys = new Set(['length', ...Array.from({ length: entry.length }, (_, index) => String(index))]);
        if (ownKeys.some((key) => typeof key !== 'string' || !allowedKeys.has(key))) {
          throw new TypeError('strict canonical JSON rejects extra array properties');
        }
        const serialized: string[] = [];
        for (let index = 0; index < entry.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(entry, String(index));
          if (descriptor === undefined) {
            throw new TypeError('strict canonical JSON rejects sparse arrays');
          }
          if (!descriptor.enumerable) {
            throw new TypeError('strict canonical JSON rejects non-enumerable array entries');
          }
          if (!('value' in descriptor)) {
            throw new TypeError('strict canonical JSON rejects array accessors');
          }
          serialized.push(serialize(descriptor.value));
        }
        return `[${serialized.join(',')}]`;
      }
      if (!isPlainObject(entry)) throw new TypeError('strict canonical JSON requires plain objects');
      const keys = sortedOwnKeys(entry);
      return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(entry[key])}`).join(',')}}`;
    } finally {
      active.delete(entry);
    }
  };

  return serialize(value);
}

function legacyCanonicalJson(value: unknown): string {
  const serialize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map((item) => serialize(item));
    if (isPlainObject(entry)) {
      return Object.fromEntries(
        Object.entries(entry)
          .filter(([, item]) => item !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, serialize(item)]),
      );
    }
    return entry;
  };
  return JSON.stringify(serialize(value));
}

export function computeDesktopCommanderInvocationHash(
  toolName: string,
  normalizedArguments: Record<string, unknown>,
): string {
  const canonical = legacyCanonicalJson({ toolName, arguments: normalizedArguments });
  return crypto
    .createHash('sha256')
    .update(`acs:desktop-commander-invocation:v1\n${canonical}`, 'utf8')
    .digest('hex');
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function requireExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  malformedCode: ManagedAcsRejectionCode,
): void {
  const actual = Object.keys(record);
  const expectedSet = new Set(expected);
  if (actual.some((key) => !expectedSet.has(key))) reject('ACS_CAPABILITY_EXTRA_FIELD');
  if (!hasExactKeys(record, expected)) reject(malformedCode);
}

function isSortedUniqueScopes(value: unknown): value is AcsScope[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (!value.every((scope) => typeof scope === 'string' && FIXED_ACS_SCOPES.includes(scope as AcsScope))) return false;
  return value.every((scope, index) => index === 0 || value[index - 1] < scope);
}

function exactStructuralEqual(left: unknown, right: unknown): boolean {
  try {
    return strictCanonicalJsonV1(left) === strictCanonicalJsonV1(right);
  } catch {
    return false;
  }
}

function parseBase64Url(value: unknown, pattern: RegExp, bytes: number): Buffer | undefined {
  if (typeof value !== 'string' || !pattern.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== bytes || decoded.toString('base64url') !== value) return undefined;
  return decoded;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && RFC3339_MILLISECONDS_PATTERN.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

export interface AcsRuntimeIdentityHandshake {
  schemaVersion: 1;
  runtimeId: string;
  challenge: string;
  scopes: readonly AcsScope[];
}

export interface ManagedAcsAuthorizationMetadata {
  version: typeof ACS_CAPABILITY_VERSION;
  keyId: string;
  runtimeId: string;
  workItemId: string;
  attemptId: string;
  leaseId: string;
  leaseEpoch: number;
  toolName: string;
  scopes: readonly AcsScope[];
  actionHash: string;
  requestHash: string;
  planHash: string;
  authorizedAt: string;
}

export interface ManagedAcsGuardOptions {
  mode: DesktopCommanderExecutionMode;
  runtimeId: string;
  publicKey?: string;
  keyId?: string;
  allowedScopes?: readonly AcsScope[];
  now?: () => number;
  maxReplayEntries?: number;
  replayDirectory?: string;
}

export class ManagedAcsGuard {
  private identityState: 'missing' | 'active' | 'drift' | 'revoked' = 'missing';
  private readonly replayCache = new Map<string, number>();
  private readonly now: () => number;
  private readonly maxReplayEntries: number;
  private readonly allowedScopes: readonly AcsScope[];
  private publicKey: crypto.KeyObject | undefined;

  constructor(private readonly options: ManagedAcsGuardOptions) {
    this.now = options.now ?? Date.now;
    this.maxReplayEntries = options.maxReplayEntries ?? DEFAULT_MAX_REPLAY_ENTRIES;
    if (!Number.isSafeInteger(this.maxReplayEntries) || this.maxReplayEntries <= 0) {
      throw new TypeError('maxReplayEntries must be a positive safe integer');
    }
    this.allowedScopes = Object.freeze([...(options.allowedScopes ?? FIXED_ACS_SCOPES)]);
    if (!isSortedUniqueScopes(this.allowedScopes)) {
      throw new TypeError('allowedScopes must be a sorted unique nonempty subset of the ACS v1 scope vocabulary');
    }
  }

  initialize(meta: unknown): AcsRuntimeIdentityHandshake | undefined {
    if (this.options.mode === 'standalone') return undefined;
    if (this.identityState === 'revoked') reject('ACS_RUNTIME_IDENTITY_REVOKED');
    if (isPlainObject(meta) && meta.__acsDuplicateJsonKeys === true) {
      this.identityState = 'drift';
      reject('ACS_RUNTIME_IDENTITY_DRIFT');
    }
    if (!isPlainObject(meta) || !isPlainObject(meta.acsRuntimeBootstrap)) {
      this.identityState = 'missing';
      reject('ACS_RUNTIME_IDENTITY_MISSING');
    }
    const bootstrap = meta.acsRuntimeBootstrap;
    const actualKeys = Object.keys(bootstrap);
    if (actualKeys.some((key) => !BOOTSTRAP_KEYS.includes(key))) {
      this.identityState = 'drift';
      reject('ACS_RUNTIME_IDENTITY_DRIFT');
    }
    if (!hasExactKeys(bootstrap, BOOTSTRAP_KEYS)) {
      this.identityState = 'missing';
      reject('ACS_RUNTIME_IDENTITY_MISSING');
    }
    if (
      bootstrap.schemaVersion !== 1
      || typeof bootstrap.runtimeId !== 'string'
      || !ID_PATTERN.test(bootstrap.runtimeId)
      || bootstrap.runtimeId !== this.options.runtimeId
      || parseBase64Url(bootstrap.challenge, BASE64URL_32_PATTERN, 32) === undefined
      || !isSortedUniqueScopes(bootstrap.scopes)
      || !exactStructuralEqual(bootstrap.scopes, this.allowedScopes)
    ) {
      this.identityState = 'drift';
      reject('ACS_RUNTIME_IDENTITY_DRIFT');
    }
    this.ensurePublicKey();
    this.identityState = 'active';
    return Object.freeze({
      schemaVersion: 1,
      runtimeId: bootstrap.runtimeId,
      challenge: bootstrap.challenge as string,
      scopes: Object.freeze([...(bootstrap.scopes as AcsScope[])]),
    });
  }

  revoke(): void {
    if (this.options.mode === 'managed') this.identityState = 'revoked';
  }

  /** Non-secret runtime-identity handshake state (for health reporting only). */
  identityStatus(): 'standalone' | 'missing' | 'active' | 'drift' | 'revoked' {
    return this.options.mode === 'standalone' ? 'standalone' : this.identityState;
  }

  authorize(
    toolName: string,
    actualArguments: Record<string, unknown>,
    meta: unknown,
  ): ManagedAcsAuthorizationMetadata | undefined {
    if (this.options.mode === 'standalone') return undefined;
    if (this.identityState === 'revoked') reject('ACS_RUNTIME_IDENTITY_REVOKED');
    if (this.identityState === 'drift') reject('ACS_RUNTIME_IDENTITY_DRIFT');
    if (this.identityState !== 'active') reject('ACS_RUNTIME_IDENTITY_MISSING');

    if (isPlainObject(meta) && meta.__acsDuplicateJsonKeys === true) {
      reject('ACS_CAPABILITY_EXTRA_FIELD');
    }

    if (!isPlainObject(meta) || !Object.prototype.hasOwnProperty.call(meta, 'acsCapability')) {
      reject('ACS_CAPABILITY_MISSING');
    }
    const envelope = meta.acsCapability;
    if (!isPlainObject(envelope)) reject('ACS_CAPABILITY_MALFORMED');
    requireExactKeys(envelope, ENVELOPE_KEYS, 'ACS_CAPABILITY_MALFORMED');
    if (typeof envelope.keyId !== 'string' || !KEY_ID_PATTERN.test(envelope.keyId)) {
      reject('ACS_CAPABILITY_MALFORMED');
    }
    if (!this.options.keyId || envelope.keyId !== this.options.keyId || !this.options.publicKey) {
      reject('ACS_CAPABILITY_KEY_UNKNOWN');
    }
    const signature = parseBase64Url(envelope.signature, BASE64URL_64_PATTERN, 64);
    if (!signature || !isPlainObject(envelope.payload)) reject('ACS_CAPABILITY_MALFORMED');

    const payload = envelope.payload;
    const payloadKeys = Object.prototype.hasOwnProperty.call(payload, 'approvalId')
      ? [...BASE_PAYLOAD_KEYS, 'approvalId']
      : BASE_PAYLOAD_KEYS;
    requireExactKeys(payload, payloadKeys, 'ACS_CAPABILITY_MALFORMED');

    let signedBytes: Buffer;
    try {
      signedBytes = Buffer.from(strictCanonicalJsonV1(payload), 'utf8');
    } catch {
      reject('ACS_CAPABILITY_MALFORMED');
    }
    this.ensurePublicKey();
    const verificationKey = this.publicKey;
    if (!verificationKey || !crypto.verify(null, signedBytes, verificationKey, signature)) {
      reject('ACS_CAPABILITY_SIGNATURE_INVALID');
    }

    if (payload.version !== ACS_CAPABILITY_VERSION) reject('ACS_CAPABILITY_VERSION_INVALID');
    if (payload.issuer !== 'acs') reject('ACS_CAPABILITY_ISSUER_INVALID');
    if (payload.audience !== 'desktop-commander') reject('ACS_CAPABILITY_AUDIENCE_INVALID');
    if (payload.runtimeId !== this.options.runtimeId) reject('ACS_CAPABILITY_RUNTIME_MISMATCH');
    if (typeof payload.workItemId !== 'string' || !ID_PATTERN.test(payload.workItemId)) reject('ACS_CAPABILITY_WORK_ITEM_MISMATCH');
    if (typeof payload.attemptId !== 'string' || !ID_PATTERN.test(payload.attemptId)) reject('ACS_CAPABILITY_ATTEMPT_MISMATCH');
    if (typeof payload.leaseId !== 'string' || !ID_PATTERN.test(payload.leaseId)) reject('ACS_CAPABILITY_LEASE_MISMATCH');
    if (!Number.isSafeInteger(payload.leaseEpoch) || (payload.leaseEpoch as number) < 0) reject('ACS_CAPABILITY_EPOCH_MISMATCH');
    if (typeof payload.toolName !== 'string' || !TOOL_PATTERN.test(payload.toolName) || payload.toolName !== toolName) {
      reject('ACS_CAPABILITY_TOOL_MISMATCH');
    }
    let boundCandidate: Record<string, unknown>;
    try {
      boundCandidate = authorizationArguments(actualArguments);
    } catch {
      reject('ACS_CAPABILITY_ARGUMENTS_MISMATCH');
    }
    if (!isPlainObject(payload.normalizedArguments) || !exactStructuralEqual(payload.normalizedArguments, boundCandidate)) {
      reject('ACS_CAPABILITY_ARGUMENTS_MISMATCH');
    }
    if (typeof payload.invocationHash !== 'string' || !HASH_PATTERN.test(payload.invocationHash)
      || payload.invocationHash !== computeDesktopCommanderInvocationHash(toolName, payload.normalizedArguments)) {
      reject('ACS_CAPABILITY_INVOCATION_HASH_MISMATCH');
    }
    if (typeof payload.actionHash !== 'string' || !HASH_PATTERN.test(payload.actionHash)) reject('ACS_CAPABILITY_ACTION_HASH_MISMATCH');
    if (typeof payload.requestHash !== 'string' || !HASH_PATTERN.test(payload.requestHash)) reject('ACS_CAPABILITY_REQUEST_HASH_MISMATCH');
    if (typeof payload.planHash !== 'string' || !HASH_PATTERN.test(payload.planHash)) reject('ACS_CAPABILITY_PLAN_HASH_MISMATCH');

    const policy = TOOL_POLICIES[toolName];
    if (toolName === 'read_file' && payload.normalizedArguments.isUrl !== undefined
      && payload.normalizedArguments.isUrl !== false) {
      reject('ACS_CAPABILITY_SCOPE_MISMATCH');
    }
    if (!policy || !isSortedUniqueScopes(payload.scopes)
      || !exactStructuralEqual(payload.scopes, policy.scopes)
      || !(payload.scopes as AcsScope[]).every((scope) => this.allowedScopes.includes(scope))) {
      reject('ACS_CAPABILITY_SCOPE_MISMATCH');
    }
    const hasApproval = Object.prototype.hasOwnProperty.call(payload, 'approvalId');
    if (policy.requiresApproval && (!hasApproval || typeof payload.approvalId !== 'string' || !ID_PATTERN.test(payload.approvalId))) {
      reject('ACS_CAPABILITY_APPROVAL_REQUIRED');
    }
    if (!policy.requiresApproval && hasApproval) reject('ACS_CAPABILITY_APPROVAL_FORBIDDEN');

    if (!validTimestamp(payload.issuedAt) || !validTimestamp(payload.expiresAt)) reject('ACS_CAPABILITY_TIME_INVALID');
    const issuedAt = Date.parse(payload.issuedAt);
    const expiresAt = Date.parse(payload.expiresAt);
    const now = this.now();
    if (
      issuedAt > now + CLOCK_SKEW_MS
      || expiresAt <= now - CLOCK_SKEW_MS
      || expiresAt <= issuedAt
      || expiresAt - issuedAt > MAX_CAPABILITY_TTL_MS
    ) reject('ACS_CAPABILITY_TIME_INVALID');

    if (parseBase64Url(payload.nonce, BASE64URL_32_PATTERN, 32) === undefined) {
      reject('ACS_CAPABILITY_NONCE_INVALID');
    }
    this.reserveNonce(`${envelope.keyId}:${payload.nonce}`, expiresAt + CLOCK_SKEW_MS, now);

    return Object.freeze({
      version: ACS_CAPABILITY_VERSION,
      keyId: envelope.keyId,
      runtimeId: payload.runtimeId as string,
      workItemId: payload.workItemId as string,
      attemptId: payload.attemptId as string,
      leaseId: payload.leaseId as string,
      leaseEpoch: payload.leaseEpoch as number,
      toolName,
      scopes: Object.freeze([...(payload.scopes as AcsScope[])]),
      actionHash: payload.actionHash as string,
      requestHash: payload.requestHash as string,
      planHash: payload.planHash as string,
      authorizedAt: new Date(now).toISOString(),
    });
  }

  private reserveNonce(key: string, retainUntil: number, now: number): void {
    if (this.options.replayDirectory) {
      this.reservePersistedNonce(key, retainUntil, now);
      return;
    }
    for (const [cachedKey, expiry] of this.replayCache) {
      if (expiry <= now) this.replayCache.delete(cachedKey);
    }
    if (this.replayCache.has(key)) reject('ACS_CAPABILITY_NONCE_REPLAY');
    if (this.replayCache.size >= this.maxReplayEntries) reject('ACS_CAPABILITY_NONCE_REPLAY');
    this.replayCache.set(key, retainUntil);
  }

  private reservePersistedNonce(key: string, retainUntil: number, now: number): void {
    const directory = path.resolve(this.options.replayDirectory!);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lockPath = path.join(directory, '.reserve.lock');
    let lock: { descriptor: number; token: string } | undefined;
    try {
      lock = this.acquireReplayLock(lockPath);
      const digest = crypto.createHash('sha256').update(key, 'utf8').digest('hex');
      let retained = 0;
      let replayed = false;
      for (const entry of fs.readdirSync(directory)) {
        const match = /^nonce-(\d+)-([a-f0-9]{64})$/.exec(entry);
        if (!match) continue;
        const expiry = Number(match[1]);
        const entryPath = path.join(directory, entry);
        if (!Number.isSafeInteger(expiry)) reject('ACS_CAPABILITY_NONCE_REPLAY');
        if (expiry <= now) {
          fs.unlinkSync(entryPath);
          continue;
        }
        retained += 1;
        if (match[2] === digest) replayed = true;
      }
      if (replayed || retained >= this.maxReplayEntries) reject('ACS_CAPABILITY_NONCE_REPLAY');
      const markerPath = path.join(directory, `nonce-${retainUntil}-${digest}`);
      const marker = fs.openSync(markerPath, 'wx', 0o600);
      fs.closeSync(marker);
    } catch (error) {
      if (error instanceof ManagedAcsAuthorizationError) throw error;
      reject('ACS_CAPABILITY_NONCE_REPLAY');
    } finally {
      if (lock !== undefined) {
        try {
          fs.closeSync(lock.descriptor);
        } finally {
          this.releaseReplayLock(lockPath, lock.token);
        }
      }
    }
  }

  private acquireReplayLock(lockPath: string): { descriptor: number; token: string } {
    const deadline = Date.now() + 1_000;
    const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
    while (true) {
      let descriptor: number | undefined;
      try {
        descriptor = fs.openSync(lockPath, 'wx', 0o600);
        const token = crypto.randomBytes(16).toString('base64url');
        fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: Date.now(), token }));
        fs.fsyncSync(descriptor);
        return { descriptor, token };
      } catch (error: any) {
        if (descriptor !== undefined) {
          fs.closeSync(descriptor);
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // Acquisition still fails closed below if cleanup itself raced.
          }
        }
        if (error?.code !== 'EEXIST') reject('ACS_CAPABILITY_NONCE_REPLAY');
        if (this.replayLockIsOrphaned(lockPath)) {
          try {
            fs.unlinkSync(lockPath);
          } catch (unlinkError: any) {
            if (unlinkError?.code !== 'ENOENT') reject('ACS_CAPABILITY_NONCE_REPLAY');
          }
          continue;
        }
        if (Date.now() >= deadline) reject('ACS_CAPABILITY_NONCE_REPLAY');
        Atomics.wait(waitBuffer, 0, 0, 10);
      }
    }
  }

  private replayLockIsOrphaned(lockPath: string): boolean {
    try {
      const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: unknown };
      if (typeof parsed.pid === 'number' && Number.isSafeInteger(parsed.pid) && parsed.pid > 0) {
        try {
          process.kill(parsed.pid, 0);
          return false;
        } catch (error: any) {
          return error?.code === 'ESRCH';
        }
      }
      return Date.now() - fs.statSync(lockPath).mtimeMs > 5_000;
    } catch (error: any) {
      if (error?.code === 'ENOENT') return true;
      try {
        return Date.now() - fs.statSync(lockPath).mtimeMs > 5_000;
      } catch {
        return false;
      }
    }
  }

  private releaseReplayLock(lockPath: string, token: string): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { token?: unknown };
      if (parsed.token === token) fs.unlinkSync(lockPath);
    } catch {
      // Losing ownership or the lock path is safe: never remove another
      // process's reservation lock during cleanup.
    }
  }

  private ensurePublicKey(): void {
    if (this.publicKey) return;
    if (!this.options.publicKey || !this.options.keyId || !KEY_ID_PATTERN.test(this.options.keyId)) {
      reject('ACS_CAPABILITY_KEY_UNKNOWN');
    }
    try {
      const encoded = this.options.publicKey;
      if (!/^[A-Za-z0-9_-]+$/.test(encoded) || Buffer.from(encoded, 'base64url').toString('base64url') !== encoded) {
        reject('ACS_CAPABILITY_KEY_UNKNOWN');
      }
      this.publicKey = crypto.createPublicKey({
        key: Buffer.from(encoded, 'base64url'),
        format: 'der',
        type: 'spki',
      });
      if (this.publicKey.asymmetricKeyType !== 'ed25519') reject('ACS_CAPABILITY_KEY_UNKNOWN');
    } catch (error) {
      if (error instanceof ManagedAcsAuthorizationError) throw error;
      reject('ACS_CAPABILITY_KEY_UNKNOWN');
    }
  }
}

export function executionModeFromArgv(argv: readonly string[]): DesktopCommanderExecutionMode {
  return argv.includes('--standalone') ? 'standalone' : 'managed';
}
