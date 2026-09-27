import { spawn } from 'node:child_process';
import { terminateProcessTree, shouldSpawnAsProcessGroupLeader } from '../utils/process-tree.js';
import { DcToolError } from './errors.js';
import { assertExecutableNotBlocked, realExecutable, resolveAllowedDirectory, whichExecutable } from './scope.js';
import { requireHead } from './git.js';
import { currentRequestContext, recordEvidence, sha256Hex } from './context.js';
import { buildSandboxCommand } from '../security/network-guard.js';

/**
 * run_command: bounded, non-interactive argv execution.
 *
 *  - argv is executed directly with shell:false. There is no shell-string
 *    interface, no implicit `bash -c`, and no shell fallback of any kind.
 *  - cwd is mandatory and must resolve (symlinks resolved) inside DC's allowed
 *    directories.
 *  - stdin is closed; the process gets a hard timeout (SIGTERM to the process
 *    group, then SIGKILL) and stdout/stderr are captured up to fixed caps.
 */
export interface RunCommandInput {
  argv: string[];
  cwd: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  expectedHeadSha?: string;
}

export interface RunCommandResult {
  requestId: string | null;
  argv: string[];
  executable: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: { stdout: boolean; stderr: boolean };
  headSha?: string;
}

export const RUN_COMMAND_LIMITS = Object.freeze({
  defaultTimeoutMs: 60_000,
  maxTimeoutMs: 15 * 60_000,
  defaultOutputBytes: 256 * 1024,
  maxOutputBytes: 4 * 1024 * 1024,
  maxArgs: 256,
  maxArgBytes: 32 * 1024,
  killGraceMs: 2_000,
});

function boundedInt(value: unknown, field: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new DcToolError('DC_INVALID_ARGUMENT', `${field} must be an integer between ${min} and ${max}`, { stage: 'validate' });
  }
  return value;
}

export function validateArgv(argv: unknown): string[] {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > RUN_COMMAND_LIMITS.maxArgs) {
    throw new DcToolError('DC_INVALID_ARGUMENT', `argv must be a non-empty array of at most ${RUN_COMMAND_LIMITS.maxArgs} strings`, { stage: 'validate' });
  }
  argv.forEach((arg, index) => {
    if (typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg) > RUN_COMMAND_LIMITS.maxArgBytes) {
      throw new DcToolError('DC_INVALID_ARGUMENT', `argv[${index}] must be a string without NUL, at most ${RUN_COMMAND_LIMITS.maxArgBytes} bytes`, { stage: 'validate' });
    }
  });
  if ((argv[0] as string).length === 0) {
    throw new DcToolError('DC_INVALID_ARGUMENT', 'argv[0] (the executable) must be non-empty', { stage: 'validate' });
  }
  return argv as string[];
}

class BoundedBuffer {
  private readonly chunks: Buffer[] = [];
  private kept = 0;
  total = 0;
  constructor(private readonly max: number) {}
  push(chunk: Buffer): void {
    this.total += chunk.length;
    const room = this.max - this.kept;
    if (room <= 0) return;
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.chunks.push(slice);
    this.kept += slice.length;
  }
  get truncated(): boolean {
    return this.total > this.kept;
  }
  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
  hash(): string {
    return sha256Hex(Buffer.concat(this.chunks));
  }
}

export async function runCommand(input: RunCommandInput): Promise<RunCommandResult> {
  const argv = validateArgv(input.argv);
  const timeoutMs = boundedInt(input.timeoutMs, 'timeoutMs', RUN_COMMAND_LIMITS.defaultTimeoutMs, 1, RUN_COMMAND_LIMITS.maxTimeoutMs);
  const maxStdout = boundedInt(input.maxStdoutBytes, 'maxStdoutBytes', RUN_COMMAND_LIMITS.defaultOutputBytes, 0, RUN_COMMAND_LIMITS.maxOutputBytes);
  const maxStderr = boundedInt(input.maxStderrBytes, 'maxStderrBytes', RUN_COMMAND_LIMITS.defaultOutputBytes, 0, RUN_COMMAND_LIMITS.maxOutputBytes);
  const cwd = await resolveAllowedDirectory(input.cwd, 'cwd');

  await assertExecutableNotBlocked(argv[0]);
  const found = await whichExecutable(argv[0], cwd.resolved);
  if (!found) {
    throw new DcToolError('DC_COMMAND_NOT_FOUND', `executable not found (no shell lookup is performed): ${argv[0]}`, { stage: 'resolve' });
  }
  // The RESOLVED executable and its symlink-free real path are both checked,
  // so neither a path alias nor a symlink to a blocked binary slips through;
  // the real path is what gets spawned (argv0 keeps the caller's name).
  await assertExecutableNotBlocked(found);
  const executable = await realExecutable(found);
  await assertExecutableNotBlocked(executable);

  let headSha: string | undefined;
  if (input.expectedHeadSha !== undefined) {
    headSha = (await requireHead(cwd.resolved, input.expectedHeadSha)).actualSha ?? undefined;
  }

  recordEvidence({ cwd: cwd.resolved, ...(headSha ? { repoHeadSha: headSha, preconditions: { expectedHeadSha: input.expectedHeadSha } } : {}) });

  const stdout = new BoundedBuffer(maxStdout);
  const stderr = new BoundedBuffer(maxStderr);
  const started = Date.now();
  const useGroup = shouldSpawnAsProcessGroupLeader();
  // Windows has no process groups; the tree helper uses taskkill /T there.
  const killTree = useGroup || process.platform === 'win32';

  // DC_NETWORK_PROFILE=none: scrubbed env always; `unshare -n` when usable.
  const isolation = currentRequestContext()?.networkIsolation;
  let spawnFile = executable;
  let spawnArgs = argv.slice(1);
  let spawnArgv0: string | undefined = argv[0];
  let spawnEnv: NodeJS.ProcessEnv = process.env;
  if (isolation) {
    spawnEnv = isolation.env;
    let isolated = false;
    if (isolation.sandboxAvailable) {
      const wrapped = await buildSandboxCommand([executable, ...argv.slice(1)], { allowsSandbox: true });
      if (wrapped.wrapped) {
        [spawnFile, ...spawnArgs] = wrapped.argv;
        spawnArgv0 = undefined;
        isolated = true;
      }
    }
    recordEvidence({ network: { profile: 'none', netnsIsolated: isolated, envScrubbed: true, degraded: !isolated } });
  }

  const outcome = await new Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean }>((resolve, reject) => {
    let timedOut = false;
    let settled = false;
    let child;
    try {
      child = spawn(spawnFile, spawnArgs, {
        ...(spawnArgv0 ? { argv0: spawnArgv0 } : {}),
        cwd: cwd.resolved,
        shell: false,
        detached: useGroup,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spawnEnv,
      });
    } catch (error) {
      reject(new DcToolError('DC_COMMAND_NOT_FOUND', `failed to spawn ${argv[0]}`, { stage: 'execute', cause: error }));
      return;
    }
    const pid = child.pid;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      if (pid) {
        killTree ? terminateProcessTree(pid, 'SIGTERM') : child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          killTree ? terminateProcessTree(pid, 'SIGKILL') : child.kill('SIGKILL');
        }, RUN_COMMAND_LIMITS.killGraceMs);
      }
    }, timeoutMs);
    child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error.code === 'ENOENT' || error.code === 'EACCES'
        ? new DcToolError(error.code === 'ENOENT' ? 'DC_COMMAND_NOT_FOUND' : 'DC_PERMISSION_DENIED', `failed to execute ${argv[0]}: ${error.code}`, { stage: 'execute', errno: error.code, cause: error })
        : new DcToolError('DC_INTERNAL_ERROR', `failed to execute ${argv[0]}`, { stage: 'execute', errno: error.code, cause: error }));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ exitCode: code, signal: signal ?? null, timedOut });
    });
  });

  const result: RunCommandResult = {
    requestId: currentRequestContext()?.requestId ?? null,
    argv,
    executable,
    cwd: cwd.resolved,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    durationMs: Date.now() - started,
    stdout: stdout.toString(),
    stderr: stderr.toString(),
    stdoutBytes: stdout.total,
    stderrBytes: stderr.total,
    truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
    ...(headSha ? { headSha } : {}),
  };
  recordEvidence({
    exitCode: result.exitCode,
    signal: result.signal,
    truncated: result.truncated,
    results: { stdoutSha256: stdout.hash(), stderrSha256: stderr.hash(), stdoutBytes: stdout.total, stderrBytes: stderr.total, timedOut: result.timedOut, executable },
  });
  return result;
}
