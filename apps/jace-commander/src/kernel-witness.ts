/**
 * JC Kernel Witness TypeScript integration:
 * - Configuration from environment (`JC_WITNESS_*`)
 * - Pre-exec `jc-kernel-witness run` argv builder (wraps `bwrap` while preserving fds)
 * - `jc.kernel-witness.receipt.v1` canonical hash, Ed25519 signature, completeness,
 *   correlation ID, hash-chain, and replay verification
 * - Best-effort / fail-closed ACS evidence submission (`POST /black-box/kernel-witness/receipts`)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strictCanonicalJsonV1 } from './canonical-json.js';
import { IntegrationError, requestJson } from './integrations.js';

export const KERNEL_WITNESS_RECEIPT_SCHEMA = 'jc.kernel-witness.receipt.v1' as const;
export type KernelWitnessMode = 'live' | 'auto' | 'synthetic';

export interface KernelWitnessConfig {
  enabled: boolean;
  required: boolean;
  mode: KernelWitnessMode;
  binaryPath: string;
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

export interface KernelWitnessReceipt {
  schemaVersion: typeof KERNEL_WITNESS_RECEIPT_SCHEMA;
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
  status: 'complete' | 'incomplete' | 'failed';
  incompleteReasons: string[];
  events: KernelWitnessEvent[];
  processTree: KernelWitnessProcessNode[];
  eventCounts: { total: number; fork: number; exec: number; exit: number };
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

export function kernelWitnessConfigFromEnv(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): KernelWitnessConfig {
  const enabled = env.JC_WITNESS_ENABLED === '1' || env.JC_WITNESS_ENABLED === 'true';
  const required = env.JC_WITNESS_REQUIRED === '1' || env.JC_WITNESS_REQUIRED === 'true';
  const rawMode = env.JC_WITNESS_MODE ?? 'auto';
  const mode: KernelWitnessMode =
    rawMode === 'live' || rawMode === 'auto' || rawMode === 'synthetic' ? rawMode : 'auto';
  return {
    enabled,
    required,
    mode,
    binaryPath: env.JC_WITNESS_BIN ?? DEFAULT_BINARY_PATH,
    signingKeyPath: env.JC_WITNESS_SIGNING_KEY || undefined,
    publicKeyPath: env.JC_WITNESS_PUBLIC_KEY || undefined,
    publicKeyPem: env.JC_WITNESS_PUBLIC_KEY_PEM || undefined,
    observerId: env.JC_WITNESS_OBSERVER_ID || undefined,
    signingKeyId: env.JC_WITNESS_SIGNING_KEY_ID || undefined,
    cgroupRoot: env.JC_WITNESS_CGROUP_ROOT || undefined,
    bpfObjPath: env.JC_WITNESS_BPF_OBJ || undefined,
    eventsInPath: env.JC_WITNESS_EVENTS_IN || undefined,
    receiptDir: env.JC_WITNESS_RECEIPT_DIR ?? path.join(stateDir, 'witness-receipts'),
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
      signingKeyId && config.publicKeysByKeyId && Object.prototype.hasOwnProperty.call(config.publicKeysByKeyId, signingKeyId)
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

export function verifyKernelWitnessReceipt(
  raw: unknown,
  options: {
    publicKeyPem?: string;
    publicKeyPath?: string;
    publicKeysByKeyId?: Record<string, string>;
    expected?: WitnessExpectedCorrelation;
    seenStore?: SeenReceiptStore;
  },
): WitnessVerificationResult {
  const reasons: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, complete: false, reasons: ['receipt_malformed'] };
  }
  const receipt = raw as Partial<KernelWitnessReceipt> & Record<string, unknown>;
  if (receipt.schemaVersion !== KERNEL_WITNESS_RECEIPT_SCHEMA) {
    reasons.push('schema_version_invalid');
  }
  if (typeof receipt.evidenceHash !== 'string' || !SHA256_HEX.test(receipt.evidenceHash)) {
    reasons.push('evidence_hash_invalid');
  }
  if (typeof receipt.signature !== 'string' || receipt.signature.length === 0) {
    reasons.push('signature_missing');
  }

  let bodyStr = '';
  try {
    bodyStr = canonicalWitnessBody(receipt);
  } catch {
    reasons.push('canonicalization_failed');
  }

  if (bodyStr && typeof receipt.evidenceHash === 'string' && SHA256_HEX.test(receipt.evidenceHash)) {
    const computed = crypto.createHash('sha256').update(bodyStr, 'utf8').digest('hex');
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
      if (sigBuf.length !== 64 || !crypto.verify(null, Buffer.from(bodyStr, 'utf8'), pubKey, sigBuf)) {
        reasons.push('signature_invalid');
      }
    } catch {
      reasons.push('signature_invalid');
    }
  }

  const complete =
    receipt.status === 'complete' &&
    Array.isArray(receipt.incompleteReasons) &&
    receipt.incompleteReasons.length === 0 &&
    receipt.droppedEvents === 0 &&
    receipt.sequenceGaps === 0;
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
    if (exp.previousEvidenceHash !== undefined && receipt.previousEvidenceHash !== exp.previousEvidenceHash) {
      reasons.push('previous_evidence_hash_mismatch');
    }
  }

  // Only reserve in the replay store when cryptographic & correlation checks pass
  // (or check before/during so an already-seen hash is always rejected).
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

export function assertWitnessBinaryReady(config: KernelWitnessConfig): void {
  try {
    const real = fs.realpathSync(config.binaryPath);
    fs.accessSync(real, fs.constants.X_OK);
  } catch {
    throw new IntegrationError(
      'JC_WITNESS_UNAVAILABLE',
      `kernel witness binary is missing or not executable: ${config.binaryPath}`,
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
  if (config.signingKeyPath) args.push('--signing-key', config.signingKeyPath);
  if (config.signingKeyId) args.push('--signing-key-id', config.signingKeyId);
  if (config.cgroupRoot) args.push('--cgroup-root', config.cgroupRoot);
  if (config.bpfObjPath) args.push('--bpf-obj', config.bpfObjPath);
  if (config.eventsInPath) args.push('--events-in', config.eventsInPath);
  if (params.workItemId) args.push('--work-item-id', params.workItemId);
  if (params.attemptId) args.push('--attempt-id', params.attemptId);
  if (params.leaseId) args.push('--lease-id', params.leaseId);
  if (params.invocationHash) args.push('--invocation-hash', params.invocationHash);
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
