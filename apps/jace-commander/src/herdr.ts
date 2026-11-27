/**
 * Read-only Herdr Core operations for the independent Jace Commander runtime.
 *
 * The handler is intentionally small and dependency-free: arguments are
 * validated before an argv array is built, hc is never run through a shell,
 * only an allowlisted environment is inherited, and all failures are typed.
 * Authorization happens in server.ts before any of these functions run.
 */
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';

const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const TERMINAL = /^(?:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}|[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63})$/u;
const HERDR_NAMES = new Set(['herdr_status', 'herdr_terminals', 'herdr_read']);

export interface HerdrOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  spawn?: typeof nodeSpawn;
}

type Result =
  | { ok: true; result?: unknown; reachable?: boolean; version?: string; terminalCount?: number | null; truncated?: boolean }
  | { ok: false; error: { kind: string; message: string } };

function safeEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'XDG_CONFIG_HOME']) {
    if (typeof source[key] === 'string') env[key] = source[key];
  }
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('HC_') && !/(TOKEN|KEY|SECRET|PASSWORD)/iu.test(key) && typeof value === 'string') env[key] = value;
  }
  return env;
}

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validate(name: string, args: unknown): Record<string, unknown> | undefined {
  if (!HERDR_NAMES.has(name) || !isRecord(args)) return undefined;
  if (name === 'herdr_status') return Object.keys(args).length === 0 ? args : undefined;
  if (name === 'herdr_terminals') {
    return Object.keys(args).every((key) => key === 'all') && (args.all === undefined || typeof args.all === 'boolean')
      ? args
      : undefined;
  }
  const keys = Object.keys(args).sort();
  if (![...keys].every((key) => key === 'terminal' || key === 'lines')) return undefined;
  if (typeof args.terminal !== 'string' || !TERMINAL.test(args.terminal)) return undefined;
  if (args.lines !== undefined &&
      (typeof args.lines !== 'number' || !Number.isInteger(args.lines) || args.lines < 0 || args.lines > 2000)) return undefined;
  return args;
}

function failure(code: number | null, signal: NodeJS.Signals | null, spawnError: NodeJS.ErrnoException | undefined, stderr: string, timedOut: boolean): Result {
  if (timedOut) return { ok: false, error: { kind: 'timeout', message: 'hc command timed out' } };
  if (spawnError?.code === 'ENOENT') return { ok: false, error: { kind: 'hc_missing', message: 'hc executable is not on the configured PATH' } };
  const parsed = parseJson(stderr);
  const detail = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
  const kind = detail && typeof detail.kind === 'string' ? detail.kind : '';
  const message = detail && typeof detail.message === 'string' ? detail.message.slice(0, 1024) : '';
  if (kind === 'not_found' || code === 3) return { ok: false, error: { kind: 'not_found', message: message || 'terminal not found' } };
  if (kind === 'needs_target' || code === 7) return { ok: false, error: { kind: 'needs_target', message: message || 'herdr-core requires a target' } };
  if (['core_unreachable', 'socket_unreachable', 'server_unreachable', 'unavailable'].includes(kind)) {
    return { ok: false, error: { kind: 'core_unreachable', message: message || 'herdr-core is unreachable' } };
  }
  if (kind === 'invalid_argument') return { ok: false, error: { kind: 'invalid_argument', message: message || 'hc rejected the arguments' } };
  if (signal) return { ok: false, error: { kind: 'hc_failed', message: `hc exited from signal ${signal}` } };
  return { ok: false, error: { kind: 'hc_failed', message: 'hc command failed' } };
}

export function createHerdrHandlers(options: HerdrOptions = {}) {
  const env = safeEnv(options.env ?? process.env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run = (argv: string[]): Promise<{ output: string; truncated: boolean } | Result> => new Promise((resolve) => {
    const child = (options.spawn ?? nodeSpawn)('hc', argv, {
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    } satisfies SpawnOptions);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outSize = 0;
    let errSize = 0;
    let truncated = false;
    let timedOut = false;
    let spawnError: NodeJS.ErrnoException | undefined;
    const collect = (target: Buffer[], chunk: Buffer, size: number): number => {
      const room = Math.max(0, MAX_OUTPUT_BYTES - size);
      if (chunk.byteLength > room) truncated = true;
      if (room > 0) target.push(chunk.subarray(0, room));
      return size + chunk.byteLength;
    };
    child.stdout!.on('data', (chunk: Buffer) => { outSize = collect(stdout, chunk, outSize); });
    child.stderr!.on('data', (chunk: Buffer) => { errSize = collect(stderr, chunk, errSize); });
    child.once('error', (error) => { spawnError = error; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      if (spawnError || code !== 0) resolve(failure(code, signal, spawnError, err, timedOut));
      else resolve({ output: out, truncated });
    });
  });

  const invoke = async (name: string, args: unknown, argv: (value: Record<string, unknown>) => string[], allowText = false): Promise<Result> => {
    const checked = validate(name, args);
    if (!checked) return { ok: false, error: { kind: 'invalid_argument', message: 'invalid herdr tool arguments' } };
    const result = await run(argv(checked));
    if (!('output' in result)) return result;
    const parsed = parseJson(result.output);
    if (parsed === undefined && !result.truncated && !allowText) {
      return { ok: false, error: { kind: 'invalid_output', message: 'hc returned invalid JSON output' } };
    }
    return { ok: true, result: parsed ?? result.output, truncated: result.truncated };
  };

  return Object.freeze({
    status: async (args: unknown): Promise<Result> => {
      if (!validate('herdr_status', args)) {
        return { ok: false, error: { kind: 'invalid_argument', message: 'invalid herdr tool arguments' } };
      }
      const version = await run(['--version']);
      if (!('output' in version)) return version;
      if (version.truncated || version.output.trim().length === 0) {
        return { ok: false, error: { kind: 'invalid_output', message: 'hc returned an invalid version response' } };
      }
      const listing = await run(['ls', '--json']);
      if (!('output' in listing)) return listing;
      const terminals = parseJson(listing.output);
      if (listing.truncated) {
        return { ok: true, reachable: true, version: version.output.trim().slice(0, 256), terminalCount: null, truncated: true };
      }
      const list = isRecord(terminals) && 'terminals' in terminals ? terminals.terminals : terminals;
      if (!Array.isArray(list)) {
        return { ok: false, error: { kind: 'invalid_output', message: 'hc returned an unrecognized terminal list' } };
      }
      return { ok: true, reachable: true, version: version.output.trim().slice(0, 256), terminalCount: list.length };
    },
    terminals: (args: unknown): Promise<Result> => invoke(
      'herdr_terminals',
      args,
      (value) => ['ls', ...(value.all === true ? ['--all'] : []), '--json'],
    ),
    read: (args: unknown): Promise<Result> => invoke(
      'herdr_read',
      args,
      // The default is applied here, after validation, never to signed arguments.
      (value) => ['read', String(value.terminal), '--lines', String(value.lines ?? 100), '--json'],
      true,
    ),
  });
}
