import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { z } from 'zod';
const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const terminalAddress = z.string().regex(/^(?:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}|[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63})$/u);
const statusArgs = z.strictObject({});
const terminalsArgs = z.strictObject({ all: z.boolean().optional() });
const readArgs = z.strictObject({ terminal: terminalAddress, lines: z.number().int().min(0).max(2000).optional() });

type HerdrErrorKind = 'invalid_argument' | 'hc_missing' | 'core_unreachable' | 'not_found' | 'needs_target' | 'timeout' | 'hc_failed' | 'invalid_output';
type HerdrResult = { ok: true; result?: unknown; reachable?: boolean; version?: string; terminalCount?: number | null; truncated?: boolean } | { ok: false; error: { kind: HerdrErrorKind; message: string } };

export interface HerdrHandlerOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onSpawn?: (file: string, argv: readonly string[]) => void;
  spawn?: typeof nodeSpawn;
}

function safeEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'XDG_CONFIG_HOME']) {
    const value = source[key];
    if (typeof value === 'string') env[key] = value;
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

function normalizeFailure(code: number | null, signal: NodeJS.Signals | null, spawnError: NodeJS.ErrnoException | undefined, stderr: string, timedOut: boolean): HerdrResult {
  if (timedOut) return { ok: false, error: { kind: 'timeout', message: 'hc command timed out' } };
  if (spawnError?.code === 'ENOENT') return { ok: false, error: { kind: 'hc_missing', message: 'hc executable is not on the configured PATH' } };
  const parsed = parseJson(stderr);
  if (parsed && typeof parsed === 'object' && 'error' in parsed) {
    const detail = (parsed as { error?: { kind?: unknown; message?: unknown } }).error;
    if (detail && typeof detail === 'object') {
      const kind = typeof detail.kind === 'string' ? detail.kind : '';
      const message = typeof detail.message === 'string' ? detail.message : 'herdr-core rejected the request';
      if (kind === 'not_found' || code === 3) return { ok: false, error: { kind: 'not_found', message: message.slice(0, 1024) } };
      if (kind === 'needs_target' || code === 7) return { ok: false, error: { kind: 'needs_target', message: message.slice(0, 1024) } };
      if (kind === 'core_unreachable' || kind === 'socket_unreachable' || kind === 'server_unreachable' || kind === 'unavailable') return { ok: false, error: { kind: 'core_unreachable', message: message.slice(0, 1024) } };
      if (kind === 'invalid_argument') return { ok: false, error: { kind: 'invalid_argument', message: message.slice(0, 1024) } };
    }
  }
  if (code === 3) return { ok: false, error: { kind: 'not_found', message: 'terminal not found' } };
  if (code === 7) return { ok: false, error: { kind: 'needs_target', message: 'herdr-core requires a target' } };
  if (signal) return { ok: false, error: { kind: 'hc_failed', message: `hc exited from signal ${signal}` } };
  return { ok: false, error: { kind: 'hc_failed', message: 'hc command failed' } };
}

export function createHerdrHandlers(options: HerdrHandlerOptions = {}) {
  const sourceEnv = options.env ?? process.env;
  const env = safeEnv(sourceEnv);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run = async (argv: string[]): Promise<{ output: string; truncated: boolean } | HerdrResult> => {
    options.onSpawn?.('hc', argv);
    return new Promise((resolve) => {
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
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        const out = Buffer.concat(stdout).toString('utf8');
        const err = Buffer.concat(stderr).toString('utf8');
        if (spawnError || code !== 0) {
          resolve(normalizeFailure(code, signal, spawnError, err, timedOut));
        } else {
          resolve({ output: out, truncated });
        }
      });
    });
  };
  const invoke = async (args: unknown, schema: z.ZodType, build: (value: Record<string, unknown>) => string[], allowText = false): Promise<HerdrResult> => {
    const checked = schema.safeParse(args);
    if (!checked.success) return { ok: false, error: { kind: 'invalid_argument', message: 'invalid herdr tool arguments' } };
    const result = await run(build(checked.data as Record<string, unknown>));
    if (!('output' in result)) return result;
    const parsed = parseJson(result.output);
    if (parsed === undefined && !result.truncated && !allowText) {
      return { ok: false, error: { kind: 'invalid_output', message: 'hc returned invalid JSON output' } };
    }
    if (parsed === undefined && !result.truncated) return { ok: true, result: result.output, truncated: false };
    return { ok: true, result: parsed ?? result.output, truncated: result.truncated };
  };
  return Object.freeze({
    status: async (args: unknown): Promise<HerdrResult> => {
      const checked = statusArgs.safeParse(args);
      if (!checked.success) return { ok: false, error: { kind: 'invalid_argument', message: 'invalid herdr tool arguments' } };
      const versionResult = await run(['--version']);
      if (!('output' in versionResult)) return versionResult;
      if (versionResult.truncated || versionResult.output.trim().length === 0) {
        return { ok: false, error: { kind: 'invalid_output', message: 'hc returned an invalid version response' } };
      }
      const listing = await run(['ls', '--json']);
      if (!('output' in listing)) return listing;
      const version = versionResult.output.trim().slice(0, 256);
      const terminals = parseJson(listing.output);
      if (listing.truncated) return { ok: true, reachable: true, version, terminalCount: null, truncated: true };
      const terminalList = terminals && typeof terminals === 'object' && 'terminals' in terminals
        ? (terminals as { terminals?: unknown }).terminals
        : terminals;
      if (!Array.isArray(terminalList)) return { ok: false, error: { kind: 'invalid_output', message: 'hc returned an unrecognized terminal list' } };
      return { ok: true, reachable: true, version, terminalCount: terminalList.length };
    },
    terminals: (args: unknown): Promise<HerdrResult> => invoke(args, terminalsArgs, (value) => ['ls', ...(value.all === true ? ['--all'] : []), '--json']),
    read: (args: unknown): Promise<HerdrResult> => invoke(
      args,
      readArgs,
      // Apply the default only after argument validation; never mutate the
      // caller's (signed) argument object.
      (value) => ['read', String(value.terminal), '--lines', String(value.lines ?? 100), '--json'],
      true
    )
  });
}
