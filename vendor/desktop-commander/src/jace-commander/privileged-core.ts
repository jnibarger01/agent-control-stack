/**
 * Privileged execution core — runs INSIDE the privilege boundary (as root,
 * via the jc-privileged-helper sudo entrypoint).
 *
 * Trust model: the unprivileged MCP server is NOT trusted to have checked
 * anything. This module independently verifies the ACS acs.jc.v1 capability
 * (signature, audience, tool=privileged_exec, scope=process.privileged,
 * mandatory human approvalId, exact argv binding, 30 s window, single-use
 * nonce) against root-owned configuration, writes a hash-chained audit intent
 * record, and only then executes. Anything ambiguous fails closed.
 *
 * "Free" sudo means: once ACS has a human approval for this exact argv, no
 * local command blocklist second-guesses it. It does NOT mean ambient sudo:
 * each capability authorizes one exact invocation, once.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FileNonceStore, JcAuthorizationError, JcCapabilityVerifier, type JcAuthorization } from './contract.js';
import { JsonlTraceChain, redactArgv } from './looptrace.js';

export const PRIVILEGED_TOOL = 'privileged_exec';
export const DEFAULT_PRIVILEGED_CONFIG_PATH = '/etc/jace-commander/privileged.json';
export const MAX_REQUEST_BYTES = 256 * 1024;
export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const HARD_MAX_TIMEOUT_MS = 600_000;
const MAX_ARGV = 256;
const MAX_ARG_CHARS = 8192;
const MAX_STDIN_CHARS = 64 * 1024;
const SECURE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export interface PrivilegedConfig {
  /** base64url SPKI DER Ed25519 public key of the ACS acs.jc.v1 issuer. */
  acsPublicKey: string;
  acsKeyId: string;
  runtimeId: string;
  nonceDir: string;
  auditPath: string;
  maxTimeoutMs?: number;
}

export interface PrivilegedArguments {
  argv: string[];
  cwd?: string;
  timeoutMs?: number;
  stdin?: string;
}

export type PrivilegedErrorCode =
  | 'PRIVILEGED_REQUEST_INVALID'
  | 'PRIVILEGED_ARGUMENTS_INVALID'
  | 'PRIVILEGED_CONFIG_INVALID'
  | 'PRIVILEGED_AUDIT_UNAVAILABLE'
  | 'PRIVILEGED_EXECUTABLE_UNTRUSTED'
  | 'PRIVILEGED_SPAWN_FAILED';

export class PrivilegedError extends Error {
  constructor(public readonly code: PrivilegedErrorCode, message: string) {
    super(message);
    this.name = 'PrivilegedError';
  }
}

export interface PrivilegedResult {
  ok: true;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  authorization: Pick<JcAuthorization, 'workItemId' | 'attemptId' | 'approvalId' | 'invocationHash' | 'actionHash'>;
  auditEventHash: string;
}

export interface PrivilegedRejection {
  ok: false;
  code: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function argumentsInvalid(message: string): never {
  throw new PrivilegedError('PRIVILEGED_ARGUMENTS_INVALID', message);
}

/**
 * Shape validation only. No normalization: the capability binds the exact
 * delivered object, so rewriting it here would break (or worse, launder)
 * the binding.
 */
export function validatePrivilegedArguments(value: unknown, maxTimeoutMs = HARD_MAX_TIMEOUT_MS): PrivilegedArguments {
  if (!isPlainObject(value)) argumentsInvalid('arguments must be an object');
  const allowed = new Set(['argv', 'cwd', 'timeoutMs', 'stdin']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) argumentsInvalid(`unknown argument: ${key}`);
  const { argv, cwd, timeoutMs, stdin } = value;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGV) argumentsInvalid(`argv must have 1..${MAX_ARGV} entries`);
  for (const arg of argv) {
    if (typeof arg !== 'string' || arg.length > MAX_ARG_CHARS || arg.includes('\0')) argumentsInvalid('argv entries must be strings without NUL');
  }
  // An absolute executable removes PATH ambiguity from what the human approved.
  if (!path.isAbsolute(argv[0]) || path.normalize(argv[0]) !== argv[0]) argumentsInvalid('argv[0] must be a normalized absolute path');
  if (cwd !== undefined && (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0'))) argumentsInvalid('cwd must be an absolute path');
  const ceiling = Math.min(maxTimeoutMs, HARD_MAX_TIMEOUT_MS);
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > ceiling)) {
    argumentsInvalid(`timeoutMs must be an integer in [1, ${ceiling}]`);
  }
  if (stdin !== undefined && (typeof stdin !== 'string' || stdin.length > MAX_STDIN_CHARS)) argumentsInvalid('stdin must be a string <= 64 KiB');
  return value as unknown as PrivilegedArguments;
}

/**
 * Loads root-owned config. When running as root, the file and every parent
 * directory must be root-owned and not group/world-writable; otherwise an
 * unprivileged user could swap in their own "ACS" public key.
 */
export function loadPrivilegedConfig(configPath: string, enforceRootOwnership: boolean): PrivilegedConfig {
  let raw: string;
  try {
    if (enforceRootOwnership) assertRootOwnedChain(configPath);
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error instanceof PrivilegedError) throw error;
    throw new PrivilegedError('PRIVILEGED_CONFIG_INVALID', 'privileged config is unreadable');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PrivilegedError('PRIVILEGED_CONFIG_INVALID', 'privileged config is not valid JSON');
  }
  if (!isPlainObject(parsed)) throw new PrivilegedError('PRIVILEGED_CONFIG_INVALID', 'privileged config must be an object');
  const { acsPublicKey, acsKeyId, runtimeId, nonceDir, auditPath, maxTimeoutMs } = parsed;
  const strings = { acsPublicKey, acsKeyId, runtimeId, nonceDir, auditPath };
  for (const [key, entry] of Object.entries(strings)) {
    if (typeof entry !== 'string' || entry.length === 0) throw new PrivilegedError('PRIVILEGED_CONFIG_INVALID', `config.${key} is required`);
  }
  if (!path.isAbsolute(nonceDir as string) || !path.isAbsolute(auditPath as string)) {
    throw new PrivilegedError('PRIVILEGED_CONFIG_INVALID', 'config nonceDir/auditPath must be absolute');
  }
  if (maxTimeoutMs !== undefined && (!Number.isSafeInteger(maxTimeoutMs) || (maxTimeoutMs as number) < 1)) {
    throw new PrivilegedError('PRIVILEGED_CONFIG_INVALID', 'config.maxTimeoutMs must be a positive integer');
  }
  return parsed as unknown as PrivilegedConfig;
}

/**
 * The approved argv[0] must be root-controlled content: the path as written
 * and its fully resolved target, plus every parent directory of both, must be
 * root-owned, not group/world-writable, and the target a regular file.
 * Otherwise the agent could swap the file (or a symlink in its path) after a
 * human approved the exact argv and have different content run as root.
 * Because nothing in the chain is writable by non-root, the check cannot be
 * raced between here and spawn().
 */
export function assertRootControlledExecutable(executable: string): void {
  const untrusted = (why: string): never => {
    throw new PrivilegedError('PRIVILEGED_EXECUTABLE_UNTRUSTED', `argv[0] is not root-controlled: ${why}`);
  };
  const checkNode = (node: string) => {
    const stat = fs.lstatSync(node);
    if (stat.uid !== 0) untrusted(`${node} is not root-owned`);
    // Symlink modes are meaningless; the link itself must still be root-owned.
    if (!stat.isSymbolicLink() && (stat.mode & 0o022) !== 0) untrusted(`${node} is group/world-writable`);
  };
  const checkChain = (target: string) => {
    let current = target;
    for (;;) {
      checkNode(current);
      const parent = path.dirname(current);
      if (parent === current) return;
      current = parent;
    }
  };
  let resolved: string;
  try {
    checkChain(executable);
    resolved = fs.realpathSync(executable);
    checkChain(resolved);
  } catch (error) {
    if (error instanceof PrivilegedError) throw error;
    return untrusted('path does not exist or is unreadable');
  }
  if (!fs.statSync(resolved).isFile()) untrusted(`${resolved} is not a regular file`);
}

function assertRootOwnedChain(target: string): void {
  let current = path.resolve(target);
  for (;;) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
      throw new PrivilegedError('PRIVILEGED_CONFIG_INVALID', `privileged config path is not exclusively root-controlled: ${current}`);
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export interface ExecuteDependencies {
  now?: () => number;
  /** Test seam; production always uses the real process environment below. */
  envOverride?: NodeJS.ProcessEnv;
}

function sha256(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

export async function executePrivileged(
  request: unknown,
  config: PrivilegedConfig,
  deps: ExecuteDependencies = {},
): Promise<PrivilegedResult | PrivilegedRejection> {
  try {
    if (!isPlainObject(request)) throw new PrivilegedError('PRIVILEGED_REQUEST_INVALID', 'request must be an object');
    const keys = Object.keys(request).sort();
    if (keys.join(',') !== 'arguments,capability') throw new PrivilegedError('PRIVILEGED_REQUEST_INVALID', 'request must be {capability, arguments}');

    const args = validatePrivilegedArguments(request.arguments, config.maxTimeoutMs);
    const verifier = new JcCapabilityVerifier({
      publicKey: config.acsPublicKey,
      keyId: config.acsKeyId,
      runtimeId: config.runtimeId,
      nonceStore: new FileNonceStore(config.nonceDir),
      now: deps.now,
    });
    const auth = verifier.verify(PRIVILEGED_TOOL, request.arguments, request.capability);
    assertRootControlledExecutable(args.argv[0]);

    const audit = new JsonlTraceChain(config.auditPath, 'jc-privileged-exec');
    const attribution = {
      workItemId: auth.workItemId,
      attemptId: auth.attemptId,
      approvalId: auth.approvalId,
      invocationHash: auth.invocationHash,
      actionHash: auth.actionHash,
      nonceHash: auth.nonceHash,
    };
    // Boundary 1: durable intent BEFORE the side effect. No audit, no exec.
    try {
      // argv is evidence, not a secret store: argv-aware redaction, bound to the
      // exact approved argv through attribution.invocationHash.
      audit.append('tool_call_started', {
        tool: PRIVILEGED_TOOL,
        argv: redactArgv(args.argv),
        argvCount: args.argv.length,
        cwd: args.cwd ?? '/',
        ...attribution,
      });
    } catch {
      throw new PrivilegedError('PRIVILEGED_AUDIT_UNAVAILABLE', 'privileged audit chain unavailable; refusing to execute');
    }

    let outcome: ProcessOutcome;
    try {
      outcome = await runProcess(args, deps.envOverride ?? {
        PATH: SECURE_PATH,
        HOME: '/root',
        LANG: 'C.UTF-8',
        JC_WORK_ITEM_ID: auth.workItemId,
        JC_APPROVAL_ID: auth.approvalId ?? '',
      }, config.maxTimeoutMs);
    } catch (error) {
      // Close the intent record so the chain never shows a dangling start.
      try {
        audit.append('tool_call_finished', { tool: PRIVILEGED_TOOL, ...attribution, spawnFailed: true });
      } catch {
        // Surfacing the spawn failure matters more than this secondary gap.
      }
      throw error;
    }

    // Boundary 2: outcome. Output content is not audited, only its digest.
    let auditEventHash: string;
    try {
      auditEventHash = audit.append('tool_call_finished', {
        tool: PRIVILEGED_TOOL,
        ...attribution,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut: outcome.timedOut,
        durationMs: outcome.durationMs,
        stdoutSha256: sha256(outcome.stdout),
        stderrSha256: sha256(outcome.stderr),
      }).hash;
    } catch {
      // The command already ran; report it but make the audit gap explicit.
      auditEventHash = 'AUDIT_APPEND_FAILED_AFTER_EXECUTION';
    }

    return {
      ok: true,
      ...outcome,
      authorization: {
        workItemId: auth.workItemId,
        attemptId: auth.attemptId,
        approvalId: auth.approvalId,
        invocationHash: auth.invocationHash,
        actionHash: auth.actionHash,
      },
      auditEventHash,
    };
  } catch (error) {
    if (error instanceof JcAuthorizationError || error instanceof PrivilegedError) return { ok: false, code: error.code };
    return { ok: false, code: 'PRIVILEGED_INTERNAL_ERROR' };
  }
}

interface ProcessOutcome {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

function runProcess(args: PrivilegedArguments, env: NodeJS.ProcessEnv, maxTimeoutMs?: number): Promise<ProcessOutcome> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(args.argv[0], args.argv.slice(1), {
      cwd: args.cwd ?? '/',
      env,
      shell: false,
      detached: true, // own process group so a timeout kills the whole tree
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const collect = () => ({ chunks: [] as Buffer[], size: 0, truncated: false });
    const out = collect();
    const err = collect();
    const onData = (sink: ReturnType<typeof collect>) => (chunk: Buffer) => {
      const room = MAX_OUTPUT_BYTES - sink.size;
      if (room <= 0) {
        sink.truncated = true;
        return;
      }
      sink.chunks.push(chunk.subarray(0, room));
      sink.size += Math.min(chunk.length, room);
      if (chunk.length > room) sink.truncated = true;
    };
    child.stdout.on('data', onData(out));
    child.stderr.on('data', onData(err));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, args.timeoutMs ?? Math.min(DEFAULT_TIMEOUT_MS, maxTimeoutMs ?? DEFAULT_TIMEOUT_MS));

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new PrivilegedError('PRIVILEGED_SPAWN_FAILED', `spawn failed: ${(error as NodeJS.ErrnoException).code ?? 'error'}`));
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - started,
        stdout: Buffer.concat(out.chunks).toString('utf8'),
        stderr: Buffer.concat(err.chunks).toString('utf8'),
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
      });
    });
    child.stdin.on('error', () => { /* child may exit before reading stdin */ });
    child.stdin.end(args.stdin ?? '');
  });
}
