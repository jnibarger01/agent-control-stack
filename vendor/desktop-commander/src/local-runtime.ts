import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ErrorCode, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRuntimeIdentityState, type RuntimeIdentityState } from './runtime-identity.js';
import { FIXED_ACS_SCOPES, type DesktopCommanderExecutionMode } from './managed-acs.js';
import { RuntimeExecutionError } from './runtime/errors.js';

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const FORWARDED_ENVIRONMENT = new Set([
  'DC_UNMATCHED_COMMAND_POLICY',
  'DESKTOP_COMMANDER_ACS_KEY_ID',
  'DESKTOP_COMMANDER_ACS_PUBLIC_KEY',
  'DESKTOP_COMMANDER_ACS_SCOPES',
  'DESKTOP_COMMANDER_DEVICE_CONFIG_PATH',
  'DESKTOP_COMMANDER_DISABLE_TELEMETRY',
  'DESKTOP_COMMANDER_STATE_DIR',
]);

type RuntimeState = 'idle' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';

export interface LocalMcpRuntimeOptions {
  mode?: DesktopCommanderExecutionMode;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  startupTimeoutMs?: number;
  healthTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  callTimeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
}

export interface LocalMcpRuntimeHealth {
  ok: boolean;
  state: RuntimeState;
  runtime_identity?: RuntimeIdentityState;
  tool_count?: number;
  error?: { code: string; message: string };
}

export class LocalMcpRuntimeError extends RuntimeExecutionError {
  constructor(public readonly code: string, message: string, cause?: unknown) {
    super(code, message, {
      cause,
      retryable: code === 'STARTUP_FAILED' || code === 'STARTUP_TIMEOUT' || code === 'HEALTH_TIMEOUT',
      causeCategory: code.includes('TIMEOUT') ? 'timeout' : code.includes('STARTUP') ? 'transport' : 'unknown',
    });
    this.name = 'LocalMcpRuntimeError';
  }
}

function positiveTimeout(value: number | undefined, fallback: number, name: string): number {
  const timeout = value ?? fallback;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new LocalMcpRuntimeError('INVALID_OPTIONS', `${name} must be a positive finite number`);
  }
  return timeout;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, code: string, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new LocalMcpRuntimeError(code, `${message} after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One deterministic local MCP child per instance. It never starts the hosted
 * remote bridge. Managed ACS authorization is the default; callers must select
 * mode:'standalone' deliberately to retain upstream-compatible direct execution.
 */
export class LocalMcpRuntime {
  private state: RuntimeState = 'idle';
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private identity: RuntimeIdentityState | undefined;
  private lastError: LocalMcpRuntimeError | undefined;
  private shutdownRequested = false;
  private readonly options: Required<Pick<LocalMcpRuntimeOptions,
    'startupTimeoutMs' | 'healthTimeoutMs' | 'shutdownTimeoutMs' | 'callTimeoutMs' | 'clientName' | 'clientVersion'>>
    & Omit<LocalMcpRuntimeOptions, 'startupTimeoutMs' | 'healthTimeoutMs' | 'shutdownTimeoutMs' | 'callTimeoutMs' | 'clientName' | 'clientVersion'>;

  constructor(options: LocalMcpRuntimeOptions = {}) {
    const mode = options.mode ?? 'managed';
    if (mode === 'managed' && options.args?.includes('--standalone')) {
      throw new LocalMcpRuntimeError('INVALID_OPTIONS', 'managed local runtime args must not contain --standalone');
    }
    for (const key of Object.keys(options.env ?? {})) {
      if (!FORWARDED_ENVIRONMENT.has(key)) {
        throw new LocalMcpRuntimeError('INVALID_OPTIONS', `env.${key} is not on the local runtime forwarding allowlist`);
      }
    }
    this.options = {
      ...options,
      mode,
      startupTimeoutMs: positiveTimeout(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, 'startupTimeoutMs'),
      healthTimeoutMs: positiveTimeout(options.healthTimeoutMs, DEFAULT_HEALTH_TIMEOUT_MS, 'healthTimeoutMs'),
      shutdownTimeoutMs: positiveTimeout(options.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS, 'shutdownTimeoutMs'),
      callTimeoutMs: positiveTimeout(options.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS, 'callTimeoutMs'),
      clientName: options.clientName ?? 'desktop-commander-local-runtime',
      clientVersion: options.clientVersion ?? '1.0.0',
    };
  }

  start(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve();
    if (this.state === 'stopping' || this.state === 'stopped') {
      return Promise.reject(new LocalMcpRuntimeError('RUNTIME_STOPPED', 'A stopped local runtime cannot be restarted'));
    }
    if (this.startPromise) return this.startPromise;

    this.state = 'starting';
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    const serverPath = fileURLToPath(new URL('./index.js', import.meta.url));
    const command = this.options.command ?? process.execPath;
    const baseArgs = this.options.args ?? [serverPath, '--no-onboarding'];
    const args = this.options.mode === 'standalone' && !baseArgs.includes('--standalone')
      ? [...baseArgs, '--standalone']
      : [...baseArgs];

    try {
      // getDefaultEnvironment intentionally forwards only a small allowlist.
      // Identity path overrides are part of runtime identity, so forward them
      // explicitly when inherited and use the exact same effective values in
      // the parent-side health record and child-side MCP tool.
      const identityEnv: Record<string, string> = {
        ...(process.env.DESKTOP_COMMANDER_STATE_DIR
          ? { DESKTOP_COMMANDER_STATE_DIR: process.env.DESKTOP_COMMANDER_STATE_DIR }
          : {}),
        ...(process.env.DESKTOP_COMMANDER_DEVICE_CONFIG_PATH
          ? { DESKTOP_COMMANDER_DEVICE_CONFIG_PATH: process.env.DESKTOP_COMMANDER_DEVICE_CONFIG_PATH }
          : {}),
        ...(process.env.DESKTOP_COMMANDER_ACS_PUBLIC_KEY
          ? { DESKTOP_COMMANDER_ACS_PUBLIC_KEY: process.env.DESKTOP_COMMANDER_ACS_PUBLIC_KEY }
          : {}),
        ...(process.env.DESKTOP_COMMANDER_ACS_KEY_ID
          ? { DESKTOP_COMMANDER_ACS_KEY_ID: process.env.DESKTOP_COMMANDER_ACS_KEY_ID }
          : {}),
        ...(process.env.DESKTOP_COMMANDER_ACS_SCOPES
          ? { DESKTOP_COMMANDER_ACS_SCOPES: process.env.DESKTOP_COMMANDER_ACS_SCOPES }
          : {}),
        ...this.options.env,
      };
      for (const key of ['DESKTOP_COMMANDER_STATE_DIR', 'DESKTOP_COMMANDER_DEVICE_CONFIG_PATH']) {
        if (identityEnv[key]) identityEnv[key] = path.resolve(identityEnv[key]);
      }
      const configuredHome = identityEnv.HOME ?? identityEnv.USERPROFILE;
      const identityHome = configuredHome ? path.resolve(configuredHome) : undefined;
      if (identityHome) {
        if (process.platform === 'win32') identityEnv.USERPROFILE = identityHome;
        else identityEnv.HOME = identityHome;
      }
      this.identity = await getRuntimeIdentityState({
        stateDirectory: identityEnv.DESKTOP_COMMANDER_STATE_DIR,
        deviceConfigPath: identityEnv.DESKTOP_COMMANDER_DEVICE_CONFIG_PATH,
        homeDirectory: identityHome,
      });
      if (this.shutdownRequested) {
        throw new LocalMcpRuntimeError('STARTUP_CANCELLED', 'Desktop Commander local MCP startup was cancelled');
      }
      this.transport = new StdioClientTransport({
        command,
        args,
        cwd: this.options.cwd ?? path.dirname(serverPath),
        env: { ...getDefaultEnvironment(), ...identityEnv, DC_LOCAL_RUNTIME: 'true' },
        stderr: 'inherit',
      });
      if (this.options.mode === 'managed') {
        const originalSend = this.transport.send.bind(this.transport);
        const bootstrapScopes = (identityEnv.DESKTOP_COMMANDER_ACS_SCOPES
          ? identityEnv.DESKTOP_COMMANDER_ACS_SCOPES.split(',')
          : [...FIXED_ACS_SCOPES]);
        (this.transport as any).send = (message: any) => {
          if (message?.method === 'initialize' && message.params) {
            message = {
              ...message,
              params: {
                ...message.params,
                _meta: {
                  ...(message.params._meta ?? {}),
                  acsRuntimeBootstrap: {
                    schemaVersion: 1,
                    runtimeId: this.identity!.runtime_id,
                    challenge: crypto.randomBytes(32).toString('base64url'),
                    scopes: bootstrapScopes,
                  },
                },
              },
            };
          }
          return originalSend(message);
        };
      }
      this.client = new Client(
        { name: this.options.clientName, version: this.options.clientVersion },
        { capabilities: {} },
      );

      await this.client.connect(this.transport, {
        timeout: this.options.startupTimeoutMs,
        maxTotalTimeout: this.options.startupTimeoutMs,
      });
      if (this.state !== 'starting') {
        throw new LocalMcpRuntimeError('STARTUP_CANCELLED', 'Desktop Commander local MCP startup was cancelled');
      }
      this.state = 'ready';
    } catch (error) {
      const runtimeError = error instanceof LocalMcpRuntimeError
        ? error
        : error instanceof McpError && error.code === ErrorCode.RequestTimeout
          ? new LocalMcpRuntimeError('STARTUP_TIMEOUT', `Desktop Commander local MCP startup timed out after ${this.options.startupTimeoutMs}ms`, error)
        : new LocalMcpRuntimeError('STARTUP_FAILED', `Desktop Commander local MCP startup failed: ${error instanceof Error ? error.message : String(error)}`, error);
      this.lastError = runtimeError;
      this.forceKillChild();
      if (!this.shutdownRequested) this.state = 'failed';
      await withTimeout(
        this.closeResources(),
        this.options.shutdownTimeoutMs,
        'STARTUP_CLEANUP_TIMEOUT',
        'Desktop Commander failed-start cleanup timed out',
      ).catch(() => undefined);
      throw runtimeError;
    }
  }

  async health(): Promise<LocalMcpRuntimeHealth> {
    if (this.state !== 'ready' || !this.client) {
      return {
        ok: false,
        state: this.state,
        ...(this.identity ? { runtime_identity: this.identity } : {}),
        ...(this.lastError ? { error: { code: this.lastError.code, message: this.lastError.message } } : {}),
      };
    }

    try {
      const tools = await this.client.listTools(undefined, {
        timeout: this.options.healthTimeoutMs,
        maxTotalTimeout: this.options.healthTimeoutMs,
      });
      return { ok: true, state: this.state, runtime_identity: this.identity, tool_count: tools.tools.length };
    } catch (error) {
      const runtimeError = error instanceof LocalMcpRuntimeError
        ? error
        : error instanceof McpError && error.code === ErrorCode.RequestTimeout
          ? new LocalMcpRuntimeError('HEALTH_TIMEOUT', `Desktop Commander local MCP health check timed out after ${this.options.healthTimeoutMs}ms`, error)
        : new LocalMcpRuntimeError('HEALTH_FAILED', `Desktop Commander local MCP health check failed: ${error instanceof Error ? error.message : String(error)}`, error);
      this.lastError = runtimeError;
      return { ok: false, state: this.state, runtime_identity: this.identity, error: { code: runtimeError.code, message: runtimeError.message } };
    }
  }

  async listTools(timeoutMs?: number): Promise<{ tools: Tool[] }> {
    if (this.state !== 'ready' || !this.client) {
      throw new LocalMcpRuntimeError('RUNTIME_NOT_READY', `Cannot list tools: local MCP runtime state is ${this.state}`);
    }

    const listTimeoutMs = positiveTimeout(timeoutMs, this.options.healthTimeoutMs, 'timeoutMs');
    try {
      return await this.client.listTools(undefined, {
        timeout: listTimeoutMs,
        maxTotalTimeout: listTimeoutMs,
      });
    } catch (error) {
      if (error instanceof LocalMcpRuntimeError) throw error;
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
        throw new LocalMcpRuntimeError('TOOL_LIST_TIMEOUT', `Desktop Commander tool listing timed out after ${listTimeoutMs}ms`, error);
      }
      throw new LocalMcpRuntimeError(
        'TOOL_LIST_FAILED',
        `Desktop Commander tool listing failed: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    timeoutMs?: number,
    meta?: Record<string, unknown>,
  ) {
    if (this.state !== 'ready' || !this.client) {
      throw new LocalMcpRuntimeError('RUNTIME_NOT_READY', `Cannot call ${name}: local MCP runtime state is ${this.state}`);
    }
    if (!name) {
      throw new LocalMcpRuntimeError('INVALID_TOOL_NAME', 'Tool name must not be empty');
    }

    const callTimeoutMs = positiveTimeout(timeoutMs, this.options.callTimeoutMs, 'timeoutMs');
    try {
      return await this.client.callTool(
        { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
        undefined,
        { timeout: callTimeoutMs, maxTotalTimeout: callTimeoutMs },
      );
    } catch (error) {
      if (error instanceof LocalMcpRuntimeError) throw error;
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
        throw new LocalMcpRuntimeError('TOOL_CALL_TIMEOUT', `Desktop Commander tool ${name} timed out after ${callTimeoutMs}ms`, error);
      }
      throw new LocalMcpRuntimeError(
        'TOOL_CALL_FAILED',
        `Desktop Commander tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
  }

  shutdown(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.state === 'stopped') return Promise.resolve();
    this.shutdownRequested = true;
    this.state = 'stopping';
    this.stopPromise = withTimeout(
      this.stopInternal(),
      this.options.shutdownTimeoutMs,
      'SHUTDOWN_TIMEOUT',
      'Desktop Commander local MCP shutdown timed out',
    ).then(
      () => { this.state = 'stopped'; },
      (error) => {
        const runtimeError = error instanceof LocalMcpRuntimeError
          ? error
          : new LocalMcpRuntimeError('SHUTDOWN_FAILED', `Desktop Commander local MCP shutdown failed: ${error instanceof Error ? error.message : String(error)}`, error);
        this.lastError = runtimeError;
        this.state = 'failed';
        throw runtimeError;
      },
    );
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    // Close anything already created, then synchronize with an in-flight start
    // and close once more in case it reached a resource assignment first.
    await this.closeResources();
    await this.startPromise?.catch(() => undefined);
    await this.closeResources();
  }

  /**
   * Force-kill the spawned child, if any. Used on the failed-start path where
   * the child is unresponsive by definition (e.g. STARTUP_TIMEOUT): graceful
   * transport.close() can spend up to ~4s racing before escalating to SIGKILL,
   * which exceeds the bounded cleanup window and leaves the child unreaped.
   * SIGKILL makes the closePromise resolve promptly so cleanup stays within
   * its timeout budget and the child is reaped deterministically.
   */
  private forceKillChild(): void {
    const pid = this.transport?.pid;
    if (pid == null) return;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Child already exited or never spawned; nothing to reap.
    }
  }

  private async closeResources(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;

    // Close the owning stdio transport first. In particular, Client.close()
    // can wait for its protocol handshake timeout when startup never completed;
    // transport.close() terminates and reaps that child immediately.
    if (transport) {
      await transport.close().catch(() => undefined);
    }
    if (client) await client.close().catch(() => undefined);
  }
}

export function createLocalMcpRuntime(options: LocalMcpRuntimeOptions = {}): LocalMcpRuntime {
  return new LocalMcpRuntime(options);
}
