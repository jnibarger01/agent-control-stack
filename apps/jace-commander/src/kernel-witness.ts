/**
 * JC Kernel Witness TypeScript integration (v1 & v2):
 * - Configuration from environment (`JC_WITNESS_*`), including `--signer-socket` (`JC_WITNESS_SIGNER_SOCKET`)
 * - Pre-exec `jc-kernel-witness run` argv builder (wraps `bwrap` while preserving fds and passing `--acs-anchor-ref`)
 * - `jc.kernel-witness.receipt.v1` and `jc.kernel-witness.receipt.v2` domain-separated canonical hash,
 *   per-category digest, Ed25519 signature, completeness, scope coverage, correlation ID, hash-chain,
 *   live-mode enforcement, and replay verification
 * - File-locked persistent chain head (`WitnessChainStateStore`) and `SeenReceiptStore`
 * - Best-effort / fail-closed ACS evidence submission (`POST /black-box/kernel-witness/receipts`)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strictCanonicalJsonV1 } from './canonical-json.js';
import { IntegrationError, requestJson } from './integrations.js';

export const KERNEL_WITNESS_RECEIPT_SCHEMA = 'jc.kernel-witness.receipt.v1' as const;
export const KERNEL_WITNESS_RECEIPT_SCHEMA_V2 = 'jc.kernel-witness.receipt.v2' as const;
export type KernelWitnessSchemaVersion =
  | typeof KERNEL_WITNESS_RECEIPT_SCHEMA
  | typeof KERNEL_WITNESS_RECEIPT_SCHEMA_V2;
export type KernelWitnessMode = 'live' | 'auto' | 'synthetic';
export type WitnessCategory = 'process' | 'filesystem' | 'network';

export interface KernelWitnessConfig {
  enabled: boolean;
  required: boolean;
  mode: KernelWitnessMode;
  binaryPath: string;
  signerSocketPath?: string;
  signingKeyPath?: string;
  publicKeyPath?: string;
  publicKeyPem?: string;
  publicKeysByKeyId?: Record<string, string>;
  observerId?: string;
  signingKeyId?: string;
  cgroupRoot?: string;
  bpfObjPath?: string;
  eventsInPath?: string;
  receiptDir: string;
  schemaVersion?: 'v1' | 'v2';
  pathDisplayMode?: 'digest' | 'workspace-relative' | 'redacted';
  workspaceRoot?: string;
  pathHmacKeyFile?: string;
}

export interface KernelWitnessEvent {
  seq: number;
  timestampNs: number;
  cgroupId: number;
  eventType: 'FORK' | 'EXEC' | 'EXIT';
  pid: number;
  tgid: number;
  ppid: number;
  childPid: number;
  childTgid: number;
  uid: number;
  gid: number;
  exitCode: number;
  comm: string;
}

export interface KernelWitnessProcessNode {
  pid: number;
  tgid: number;
  ppid: number;
  comm: string;
  uid: number;
  gid: number;
  forkedAtNs: number;
  execedAtNs: number;
  exitedAtNs: number;
  exitCode: number;
  children: KernelWitnessProcessNode[];
}

export interface WitnessObservationScope {
  policyRequired: WitnessCategory[];
  requested: WitnessCategory[];
  active: WitnessCategory[];
}

export interface WitnessCategoryStatus {
  category: WitnessCategory;
  enabled: boolean;
  status: 'complete' | 'partial' | 'incomplete' | 'unsupported' | 'failed';
  eventCount: number;
  droppedEvents: number;
  sequenceGaps: number;
  firstSeq: number | null;
  lastSeq: number | null;
  categoryDigestSha256: string;
  incompleteReasons: string[];
  unsupportedOperations: string[];
}

export interface KernelWitnessFilesystemEvent {
  seq: number;
  timestampNs: number;
  cgroupId: number;
  pid: number;
  tgid: number;
  comm: string;
  uid: number;
  gid: number;
  op:
    | 'CREATE'
    | 'MODIFY'
    | 'DELETE'
    | 'RENAME'
    | 'TRUNCATE'
    | 'MKDIR'
    | 'RMDIR'
    | 'OPENAT'
    | 'MMAP_WRITE'
    | 'IO_URING';
  phase: 'attempted' | 'completed';
  succeeded: boolean;
  resultErrno: number;
  bytes: number;
  flags: number;
  dev: number;
  inode: number;
  mountId: number;
  pathDigest: string;
  pathDigestKeyId: string;
  displayPath: string | null;
  targetPathDigest: string | null;
  targetDisplayPath: string | null;
  targetInode: number;
}

export interface KernelWitnessNetworkEvent {
  seq: number;
  timestampNs: number;
  cgroupId: number;
  pid: number;
  tgid: number;
  comm: string;
  sockCookie: number;
  af: 'INET' | 'INET6';
  proto: 'TCP' | 'UDP';
  op: 'CONNECT' | 'SENDMSG' | 'STATE_CHANGE';
  phase: 'attempted' | 'completed' | 'state_change';
  stateTransition: string | null;
  outcome:
    | 'attempted'
    | 'connected'
    | 'refused'
    | 'timed_out'
    | 'unreachable'
    | 'in_progress'
    | 'failed'
    | 'incomplete';
  errnoVal: number;
  remoteAddrDigest: string;
  displayRemoteAddr: string | null;
  remotePort: number;
  localPort: number;
  bytes: number;
}

export interface KernelWitnessReceipt {
  schemaVersion: KernelWitnessSchemaVersion;
  observerVersion: string;
  observerMode: 'live' | 'synthetic' | 'replay';
  observerId: string;
  workItemId: string;
  attemptId: string;
  leaseId: string;
  invocationHash: string;
  cgroupId: number;
  cgroupPath: string;
  rootPid?: number;
  startTimeNs: number;
  endTimeNs: number;
  signedAtUtc?: string;
  status: 'complete' | 'incomplete' | 'failed';
  incompleteReasons: string[];
  events: KernelWitnessEvent[];
  processTree: KernelWitnessProcessNode[];
  filesystemEvents?: KernelWitnessFilesystemEvent[];
  networkEvents?: KernelWitnessNetworkEvent[];
  eventCounts: {
    total: number;
    fork: number;
    exec: number;
    exit: number;
    filesystem?: number;
    network?: number;
  };
  observationScope?: WitnessObservationScope;
  categoryCompleteness?: Record<WitnessCategory, WitnessCategoryStatus>;
  droppedEvents: number;
  sequenceGaps: number;
  previousEvidenceHash: string | null;
  acsAnchorRef: string | null;
  signingKeyId: string;
  evidenceHash: string;
  signature: string;
}

export interface WitnessExpectedCorrelation {
  workItemId?: string;
  attemptId?: string;
  leaseId?: string;
  invocationHash?: string;
  observerId?: string;
  signingKeyId?: string;
  rootPid?: number;
  sandboxPid?: number;
  acsAnchorRef?: string | null;
  previousEvidenceHash?: string | null;
}

export interface WitnessVerificationResult {
  valid: boolean;
  complete: boolean;
  reasons: string[];
  evidenceHash?: string;
}

export interface WitnessRunOutcome {
  receiptPath: string;
  receipt?: KernelWitnessReceipt;
  verification: WitnessVerificationResult;
}

const DEFAULT_BINARY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'native',
  'kernel-witness',
  'build',
  'jc-kernel-witness',
);
const SHA256_HEX = /^[a-f0-9]{64}$/;

export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

export function computeV2CategoryDigest(
  category: WitnessCategory,
  items: unknown,
): string {
  return sha256Hex(`jc.kernel-witness.category.${category}.v2:${strictCanonicalJsonV1(items ?? [])}`);
}

export function kernelWitnessConfigFromEnv(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): KernelWitnessConfig {
  const enabled = env.JC_WITNESS_ENABLED === '1' || env.JC_WITNESS_ENABLED === 'true';
  const required = env.JC_WITNESS_REQUIRED === '1' || env.JC_WITNESS_REQUIRED === 'true';
  const rawMode = env.JC_WITNESS_MODE ?? 'auto';
  const mode: KernelWitnessMode =
    rawMode === 'live' || rawMode === 'auto' || rawMode === 'synthetic' ? rawMode : 'auto';
  const rawSchema = env.JC_WITNESS_SCHEMA_VERSION;
  const schemaVersion: 'v1' | 'v2' | undefined =
    rawSchema === 'v1' || rawSchema === 'v2' ? rawSchema : undefined;
  const rawDisplay = env.JC_WITNESS_PATH_DISPLAY_MODE;
  const pathDisplayMode: 'digest' | 'workspace-relative' | 'redacted' | undefined =
    rawDisplay === 'digest' || rawDisplay === 'workspace-relative' || rawDisplay === 'redacted'
      ? rawDisplay
      : undefined;
  return {
    enabled,
    required,
    mode,
    binaryPath: env.JC_WITNESS_BIN ?? DEFAULT_BINARY_PATH,
    signerSocketPath: env.JC_WITNESS_SIGNER_SOCKET ? path.resolve(env.JC_WITNESS_SIGNER_SOCKET) : undefined,
    signingKeyPath: env.JC_WITNESS_SIGNING_KEY ? path.resolve(env.JC_WITNESS_SIGNING_KEY) : undefined,
    publicKeyPath: env.JC_WITNESS_PUBLIC_KEY ? path.resolve(env.JC_WITNESS_PUBLIC_KEY) : undefined,
    publicKeyPem: env.JC_WITNESS_PUBLIC_KEY_PEM || undefined,
    observerId: env.JC_WITNESS_OBSERVER_ID || undefined,
    signingKeyId: env.JC_WITNESS_SIGNING_KEY_ID || undefined,
    cgroupRoot: env.JC_WITNESS_CGROUP_ROOT || undefined,
    bpfObjPath: env.JC_WITNESS_BPF_OBJ ? path.resolve(env.JC_WITNESS_BPF_OBJ) : undefined,
    eventsInPath: env.JC_WITNESS_EVENTS_IN ? path.resolve(env.JC_WITNESS_EVENTS_IN) : undefined,
    receiptDir: env.JC_WITNESS_RECEIPT_DIR
      ? path.resolve(env.JC_WITNESS_RECEIPT_DIR)
      : path.join(stateDir, 'witness-receipts'),
    ...(schemaVersion ? { schemaVersion } : {}),
    ...(pathDisplayMode ? { pathDisplayMode } : {}),
    ...(env.JC_WITNESS_WORKSPACE_ROOT ? { workspaceRoot: path.resolve(env.JC_WITNESS_WORKSPACE_ROOT) } : {}),
    ...(env.JC_WITNESS_PATH_HMAC_KEY_FILE
      ? { pathHmacKeyFile: path.resolve(env.JC_WITNESS_PATH_HMAC_KEY_FILE) }
      : {}),
  };
}

/**
 * File-backed O_EXCL replay store for verified Kernel Witness receipt hashes.
 * Two concurrent verifications of the same `evidenceHash` cannot both succeed.
 */
export class SeenReceiptStore {
  constructor(private readonly dir: string) {}

  reserve(evidenceHash: string): boolean {
    if (!SHA256_HEX.test(evidenceHash)) return false;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const fd = fs.openSync(path.join(this.dir, evidenceHash), 'wx', 0o600);
      try {
        fs.writeFileSync(fd, new Date().toISOString());
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * File-locked persistent store for `lastWitnessEvidenceHash` across concurrent
 * tool calls and JC process restarts (`[P1-06]`).
 */
export class WitnessChainStateStore {
  private readonly filePath: string;
  private readonly lockPath: string;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, 'witness-chain-head.json');
    this.lockPath = `${this.filePath}.lock`;
  }

  getHeadHash(): string | null {
    const token = this.acquireLock();
    try {
      return this.readUnlocked();
    } finally {
      this.releaseLock(token);
    }
  }

  recordHeadHash(evidenceHash: string): void {
    if (!SHA256_HEX.test(evidenceHash)) return;
    const token = this.acquireLock();
    try {
      this.writeUnlocked(evidenceHash);
    } finally {
      this.releaseLock(token);
    }
  }

  private readUnlocked(): string | null {
    try {
      if (!fs.existsSync(this.filePath)) return null;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as { headHash?: unknown };
      return typeof parsed.headHash === 'string' && SHA256_HEX.test(parsed.headHash)
        ? parsed.headHash
        : null;
    } catch {
      return null;
    }
  }

  private writeUnlocked(headHash: string): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmpPath = `${this.filePath}.tmp.${process.pid}`;
    const fd = fs.openSync(tmpPath, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ headHash, updatedAt: new Date().toISOString() }) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, this.filePath);
  }

  private acquireLock(): string {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const token = crypto.randomBytes(16).toString('hex');
    const deadline = Date.now() + 5_000;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
        fs.closeSync(fd);
        return token;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (this.lockHolderDead()) {
          fs.rmSync(this.lockPath, { force: true });
          continue;
        }
        if (Date.now() >= deadline) throw new Error('witness chain lock timeout', { cause: error });
        Atomics.wait(wait, 0, 0, 10);
      }
    }
  }

  private lockHolderDead(): boolean {
    try {
      const { pid } = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')) as { pid?: unknown };
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }

  private releaseLock(token: string): void {
    try {
      const held = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')) as { token?: unknown };
      if (held.token === token) fs.rmSync(this.lockPath, { force: true });
    } catch {
      // Ignore if already removed.
    }
  }
}

export function canonicalWitnessBody(receipt: Record<string, unknown>): string {
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(receipt)) {
    if (k === 'evidenceHash' || k === 'signature') continue;
    copy[k] = v;
  }
  return strictCanonicalJsonV1(copy);
}

function loadPublicKey(
  config: { publicKeyPem?: string; publicKeyPath?: string; publicKeysByKeyId?: Record<string, string> },
  signingKeyId?: string,
): crypto.KeyObject | null {
  try {
    const mappedPem =
      signingKeyId &&
      config.publicKeysByKeyId &&
      Object.prototype.hasOwnProperty.call(config.publicKeysByKeyId, signingKeyId)
        ? config.publicKeysByKeyId[signingKeyId]
        : undefined;
    const pem =
      mappedPem ??
      config.publicKeyPem ??
      (config.publicKeyPath ? fs.readFileSync(config.publicKeyPath, 'utf8') : undefined);
    if (!pem) return null;
    const key = crypto.createPublicKey(pem);
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

function treeContainsPid(nodes: readonly KernelWitnessProcessNode[], targetPid: number): boolean {
  for (const node of nodes) {
    if (!node) continue;
    if (node.pid === targetPid || node.tgid === targetPid) return true;
    if (Array.isArray(node.children) && treeContainsPid(node.children, targetPid)) return true;
  }
  return false;
}

export function verifyKernelWitnessReceipt(
  raw: unknown,
  options: {
    publicKeyPem?: string;
    publicKeyPath?: string;
    publicKeysByKeyId?: Record<string, string>;
    expected?: WitnessExpectedCorrelation;
    seenStore?: SeenReceiptStore;
    requireLiveMode?: boolean;
  },
): WitnessVerificationResult {
  const reasons: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, complete: false, reasons: ['receipt_malformed'] };
  }
  const receipt = raw as Partial<KernelWitnessReceipt> & Record<string, unknown>;
  const isV1 = receipt.schemaVersion === KERNEL_WITNESS_RECEIPT_SCHEMA;
  const isV2 = receipt.schemaVersion === KERNEL_WITNESS_RECEIPT_SCHEMA_V2;
  if (!isV1 && !isV2) {
    reasons.push('schema_version_invalid');
  }
  if (typeof receipt.evidenceHash !== 'string' || !SHA256_HEX.test(receipt.evidenceHash)) {
    reasons.push('evidence_hash_invalid');
  }
  if (typeof receipt.signature !== 'string' || receipt.signature.length === 0) {
    reasons.push('signature_missing');
  }
  if (options.requireLiveMode && receipt.observerMode !== 'live') {
    reasons.push('observer_mode_not_live');
  }

  let bodyStr = '';
  try {
    bodyStr = canonicalWitnessBody(receipt);
  } catch {
    reasons.push('canonicalization_failed');
  }

  if (bodyStr && typeof receipt.evidenceHash === 'string' && SHA256_HEX.test(receipt.evidenceHash)) {
    const hashInput = isV2 ? `jc.kernel-witness.receipt.v2:${bodyStr}` : bodyStr;
    const computed = sha256Hex(hashInput);
    if (computed !== receipt.evidenceHash) {
      reasons.push('evidence_hash_mismatch');
    }
  }

  const pubKey = loadPublicKey(options, typeof receipt.signingKeyId === 'string' ? receipt.signingKeyId : undefined);
  if (!pubKey) {
    reasons.push('public_key_unavailable');
  } else if (bodyStr && typeof receipt.signature === 'string') {
    try {
      const sigBuf = Buffer.from(receipt.signature, 'base64');
      const sigPayload = isV2
        ? `jc.kernel-witness.sig.v2:${String(receipt.evidenceHash ?? '')}:${bodyStr}`
        : bodyStr;
      if (sigBuf.length !== 64 || !crypto.verify(null, Buffer.from(sigPayload, 'utf8'), pubKey, sigBuf)) {
        reasons.push('signature_invalid');
      }
    } catch {
      reasons.push('signature_invalid');
    }
  }

  let v2CategoriesComplete = true;
  if (isV2) {
    if (typeof receipt.signedAtUtc !== 'string' || Number.isNaN(Date.parse(receipt.signedAtUtc))) {
      reasons.push('signed_at_utc_invalid');
    }
    const cc = receipt.categoryCompleteness;
    const scope = receipt.observationScope;
    if (!cc || typeof cc !== 'object' || !scope || typeof scope !== 'object') {
      reasons.push('v2_completeness_metadata_missing');
      v2CategoriesComplete = false;
    } else {
      const expectedProcessDigest = computeV2CategoryDigest('process', receipt.processTree ?? []);
      const expectedFsDigest = computeV2CategoryDigest('filesystem', receipt.filesystemEvents ?? []);
      const expectedNetDigest = computeV2CategoryDigest('network', receipt.networkEvents ?? []);
      if (cc.process?.categoryDigestSha256 !== expectedProcessDigest) {
        reasons.push('category_digest_mismatch:process');
      }
      if (cc.filesystem?.categoryDigestSha256 !== expectedFsDigest) {
        reasons.push('category_digest_mismatch:filesystem');
      }
      if (cc.network?.categoryDigestSha256 !== expectedNetDigest) {
        reasons.push('category_digest_mismatch:network');
      }
      const requiredCats: WitnessCategory[] = Array.isArray(scope.policyRequired)
        ? scope.policyRequired
        : ['process'];
      const activeCats: WitnessCategory[] = Array.isArray(scope.active) ? scope.active : [];
      for (const cat of requiredCats) {
        const st = cc[cat];
        if (
          !activeCats.includes(cat) ||
          !st ||
          !st.enabled ||
          st.status !== 'complete' ||
          st.droppedEvents > 0 ||
          st.sequenceGaps > 0 ||
          (Array.isArray(st.incompleteReasons) && st.incompleteReasons.length > 0)
        ) {
          v2CategoriesComplete = false;
        }
      }
    }
  }

  const complete =
    receipt.status === 'complete' &&
    Array.isArray(receipt.incompleteReasons) &&
    receipt.incompleteReasons.length === 0 &&
    receipt.droppedEvents === 0 &&
    receipt.sequenceGaps === 0 &&
    v2CategoriesComplete;
  if (!complete) {
    reasons.push('incomplete_observation');
  }

  if (receipt.rootPid !== undefined) {
    if (typeof receipt.rootPid !== 'number' || !Number.isSafeInteger(receipt.rootPid) || receipt.rootPid <= 0) {
      reasons.push('root_pid_invalid');
    } else if (
      complete &&
      Array.isArray(receipt.processTree) &&
      receipt.processTree.length > 0 &&
      !receipt.processTree.some((node) => node && (node.pid === receipt.rootPid || node.tgid === receipt.rootPid))
    ) {
      reasons.push('root_pid_missing_from_tree');
    }
  } else if (receipt.observerMode === 'live') {
    reasons.push('root_pid_missing');
  }

  if (options.expected) {
    const exp = options.expected;
    if (exp.workItemId !== undefined && receipt.workItemId !== exp.workItemId) {
      reasons.push('correlation_mismatch:workItemId');
    }
    if (exp.attemptId !== undefined && receipt.attemptId !== exp.attemptId) {
      reasons.push('correlation_mismatch:attemptId');
    }
    if (exp.leaseId !== undefined && receipt.leaseId !== exp.leaseId) {
      reasons.push('correlation_mismatch:leaseId');
    }
    if (exp.invocationHash !== undefined && receipt.invocationHash !== exp.invocationHash) {
      reasons.push('correlation_mismatch:invocationHash');
    }
    if (exp.observerId !== undefined && receipt.observerId !== exp.observerId) {
      reasons.push('correlation_mismatch:observerId');
    }
    if (exp.signingKeyId !== undefined && receipt.signingKeyId !== exp.signingKeyId) {
      reasons.push('correlation_mismatch:signingKeyId');
    }
    if (exp.rootPid !== undefined && receipt.rootPid !== exp.rootPid) {
      reasons.push('correlation_mismatch:rootPid');
    }
    if (
      exp.sandboxPid !== undefined &&
      receipt.observerMode === 'live' &&
      complete &&
      Array.isArray(receipt.processTree) &&
      receipt.processTree.length > 0 &&
      !treeContainsPid(receipt.processTree, exp.sandboxPid)
    ) {
      reasons.push('correlation_mismatch:sandboxPid');
    }
    if (exp.acsAnchorRef !== undefined && receipt.acsAnchorRef !== exp.acsAnchorRef) {
      reasons.push('correlation_mismatch:acsAnchorRef');
    }
    if (exp.previousEvidenceHash !== undefined && receipt.previousEvidenceHash !== exp.previousEvidenceHash) {
      reasons.push('previous_evidence_hash_mismatch');
    }
  }

  // Only reserve in the replay store when cryptographic & correlation checks pass
  if (
    options.seenStore &&
    typeof receipt.evidenceHash === 'string' &&
    SHA256_HEX.test(receipt.evidenceHash) &&
    !reasons.includes('evidence_hash_mismatch') &&
    !reasons.includes('signature_invalid')
  ) {
    if (!options.seenStore.reserve(receipt.evidenceHash)) {
      reasons.push('receipt_replayed');
    }
  }

  return {
    valid: reasons.length === 0,
    complete,
    reasons,
    ...(typeof receipt.evidenceHash === 'string' ? { evidenceHash: receipt.evidenceHash } : {}),
  };
}

/** Enforces private signing-key custody: regular file, owned by current UID, mode 0600 or 0400 (no group/world bits). */
export function assertSigningKeyCustody(signingKeyPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(signingKeyPath);
  } catch {
    throw new IntegrationError(
      'JC_WITNESS_KEY_CUSTODY_INVALID',
      `kernel witness signing key is missing or unreadable: ${signingKeyPath}`,
    );
  }
  if (!stat.isFile()) {
    throw new IntegrationError(
      'JC_WITNESS_KEY_CUSTODY_INVALID',
      `kernel witness signing key must be a regular file (not symlink/dir): ${signingKeyPath}`,
    );
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new IntegrationError(
      'JC_WITNESS_KEY_CUSTODY_INVALID',
      `kernel witness signing key must be owned by current user: ${signingKeyPath}`,
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new IntegrationError(
      'JC_WITNESS_KEY_CUSTODY_INVALID',
      `kernel witness signing key must not be group- or world-accessible (require 0600/0400): ${signingKeyPath}`,
    );
  }
}

export function assertWitnessBinaryReady(
  config: KernelWitnessConfig,
  options: { managed?: boolean } = {},
): void {
  try {
    const real = fs.realpathSync(config.binaryPath);
    fs.accessSync(real, fs.constants.X_OK);
  } catch {
    throw new IntegrationError(
      'JC_WITNESS_UNAVAILABLE',
      `kernel witness binary is missing or not executable: ${config.binaryPath}`,
    );
  }
  // [P0-01] Forbid raw private signing key in live or managed mode; require privilege-separated signer socket.
  if (config.signingKeyPath && (config.mode === 'live' || options.managed === true)) {
    throw new IntegrationError(
      'JC_WITNESS_KEY_CUSTODY_INVALID',
      'direct private signing key (JC_WITNESS_SIGNING_KEY) is forbidden in live/managed mode; use JC_WITNESS_SIGNER_SOCKET',
    );
  }
  if (config.signingKeyPath) {
    assertSigningKeyCustody(config.signingKeyPath);
  }
}

export function buildWitnessRunArgv(
  config: KernelWitnessConfig,
  params: {
    receiptOutPath: string;
    workItemId?: string;
    attemptId?: string;
    leaseId?: string;
    invocationHash?: string;
    acsAnchorRef?: string | null;
    previousEvidenceHash?: string | null;
  },
  commandArgv: readonly string[],
): string[] {
  const args: string[] = [
    config.binaryPath,
    'run',
    '--receipt-out',
    params.receiptOutPath,
    '--mode',
    config.mode,
  ];
  if (config.signerSocketPath) {
    args.push('--signer-socket', config.signerSocketPath);
  } else if (config.signingKeyPath) {
    args.push('--signing-key', config.signingKeyPath);
  }
  if (config.observerId) args.push('--observer-id', config.observerId);
  if (config.signingKeyId) args.push('--signing-key-id', config.signingKeyId);
  if (config.cgroupRoot) args.push('--cgroup-root', config.cgroupRoot);
  if (config.bpfObjPath) args.push('--bpf-obj', config.bpfObjPath);
  if (config.eventsInPath) args.push('--events-in', config.eventsInPath);
  if (config.schemaVersion) args.push('--schema-version', config.schemaVersion);
  if (config.pathDisplayMode === 'redacted') {
    args.push('--include-display-paths');
  }
  if (config.pathHmacKeyFile) {
    try {
      const hmacKey = fs.readFileSync(config.pathHmacKeyFile, 'utf8').trim();
      if (hmacKey) args.push('--path-hmac-key', hmacKey);
    } catch {
      // Fail-closed or fall back to binary default if unreadable
    }
  }
  if (params.workItemId) args.push('--work-item-id', params.workItemId);
  if (params.attemptId) args.push('--attempt-id', params.attemptId);
  if (params.leaseId) args.push('--lease-id', params.leaseId);
  if (params.invocationHash) args.push('--invocation-hash', params.invocationHash);
  const anchorRef = params.acsAnchorRef !== undefined ? params.acsAnchorRef : params.workItemId;
  if (anchorRef) args.push('--acs-anchor-ref', anchorRef);
  if (params.previousEvidenceHash) args.push('--previous-evidence-hash', params.previousEvidenceHash);
  args.push('--', ...commandArgv);
  return args;
}

export function readAndVerifyWitnessReceipt(
  receiptPath: string,
  config: KernelWitnessConfig,
  expected: WitnessExpectedCorrelation,
  seenStore?: SeenReceiptStore,
): WitnessRunOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  } catch {
    return {
      receiptPath,
      verification: { valid: false, complete: false, reasons: ['receipt_missing_or_unreadable'] },
    };
  }
  const verification = verifyKernelWitnessReceipt(parsed, {
    publicKeyPem: config.publicKeyPem,
    publicKeyPath: config.publicKeyPath,
    publicKeysByKeyId: config.publicKeysByKeyId,
    expected: {
      ...expected,
      ...(config.observerId ? { observerId: config.observerId } : {}),
      ...(config.signingKeyId ? { signingKeyId: config.signingKeyId } : {}),
    },
    seenStore,
    requireLiveMode: config.mode === 'live',
  });
  return {
    receiptPath,
    receipt: parsed as KernelWitnessReceipt,
    verification,
  };
}

export async function submitWitnessReceiptToAcs(params: {
  acsUrl: string;
  token: string | undefined;
  receipt: KernelWitnessReceipt;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; status?: number; body?: unknown }> {
  if (!params.token) return { ok: false };
  try {
    const response = await requestJson(`${params.acsUrl.replace(/\/$/, '')}/black-box/kernel-witness/receipts`, {
      method: 'POST',
      token: params.token,
      body: { receipt: params.receipt },
      timeoutMs: Math.min(params.timeoutMs, 5_000),
      fetchImpl: params.fetchImpl,
    });
    return { ok: response.status >= 200 && response.status < 300, status: response.status, body: response.body };
  } catch {
    return { ok: false };
  }
}
