import { ControlStackError } from "@agent-control-stack/shared";
import { desktopCommanderInvocationFingerprint } from "./arguments.js";
import type { DesktopCommanderAdapterConfig } from "./config.js";
import type { ContainmentConfig } from "./containment.js";
import { containPath } from "./containment.js";
import {
  authorizeDesktopCommanderExecution,
  isExecutionAuthorization,
  type AuthorizeExecutionInput,
  type ExecutionAuthorization
} from "./execution-authorization.js";
import {
  McpStdioClient,
  type McpStdioClientOptions,
  type McpToolCallResult,
  type McpToolDescriptor
} from "./mcp-stdio-client.js";
import { normalizeToolResult, type MachineExecutionResult } from "./result.js";
import { desktopCommanderToolPolicy, isAllowlistedDesktopCommanderTool } from "./tool-policy.js";

/**
 * Phase 1 + Phase 10 - the machine execution boundary.
 *
 * `execute` accepts ONLY a branded `ExecutionAuthorization`. It re-checks the
 * allowlist, re-validates the normalised arguments, re-verifies the invocation
 * fingerprint and re-asserts path containment before the MCP call. There is no
 * `execute(toolName, args)`. The raw stdio client is not exported from the
 * package barrel.
 */

export interface MachineTool {
  name: string;
  description?: string;
  /** Whether ACS will ever permit this tool to execute. */
  allowlisted: boolean;
}

export interface AuthorizedExecutionRequest {
  authorization: ExecutionAuthorization;
  signal?: AbortSignal;
}

export interface MachineExecutor {
  listTools(): Promise<MachineTool[]>;
  execute(request: AuthorizedExecutionRequest): Promise<MachineExecutionResult>;
  close(): Promise<void>;
}

/** Test seam: a minimal transport the executor can drive. */
export interface DesktopCommanderTransport {
  connect(): Promise<unknown>;
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(name: string, args: unknown): Promise<McpToolCallResult>;
  close(): Promise<void>;
  isConnected(): boolean;
  getServerInfo(): { name?: string; version?: string; protocolVersion?: string };
}

export interface DesktopCommanderMachineExecutorDeps {
  /** Inject a fake transport for unit tests. */
  transport?: DesktopCommanderTransport;
  now?: () => Date;
}

export class DesktopCommanderMachineExecutor implements MachineExecutor {
  private readonly transport: DesktopCommanderTransport;
  private readonly containment: ContainmentConfig;
  private readonly now: () => Date;
  private connecting: Promise<void> | undefined;

  constructor(
    private readonly config: DesktopCommanderAdapterConfig,
    deps: DesktopCommanderMachineExecutorDeps = {}
  ) {
    this.containment = { allowedRoots: config.allowedRoots, deniedRoots: config.deniedRoots };
    this.now = deps.now ?? (() => new Date());
    this.transport = deps.transport ?? new McpStdioClient(this.stdioOptions());
  }

  private stdioOptions(): McpStdioClientOptions {
    return {
      command: this.config.command,
      args: this.config.args,
      cwd: this.config.cwd,
      connectTimeoutMs: this.config.connectTimeoutMs,
      requestTimeoutMs: this.config.requestTimeoutMs
    };
  }

  /**
   * Fail-closed startup probe: connect and confirm the local Desktop Commander
   * MCP answers `tools/list`. Callers (the worker) must run this before
   * claiming work when the backend is `desktop_commander`.
   */
  async preflight(): Promise<{ serverInfo: { name?: string; version?: string }; toolCount: number }> {
    await this.ensureConnected();
    const tools = await this.transport.listTools();
    return { serverInfo: this.transport.getServerInfo(), toolCount: tools.length };
  }

  private async ensureConnected(): Promise<void> {
    if (this.transport.isConnected()) return;
    if (!this.connecting) {
      this.connecting = this.transport
        .connect()
        .then(() => undefined)
        .catch((error) => {
          this.connecting = undefined;
          throw error instanceof Error
            ? new ControlStackError("desktop_commander_connect_failed", error.message)
            : new ControlStackError("desktop_commander_connect_failed", String(error));
        });
    }
    await this.connecting;
  }

  async listTools(): Promise<MachineTool[]> {
    await this.ensureConnected();
    const discovered = await this.transport.listTools();
    return discovered.map((tool) => ({
      name: tool.name,
      description: tool.description,
      allowlisted: isAllowlistedDesktopCommanderTool(tool.name)
    }));
  }

  async execute(request: AuthorizedExecutionRequest): Promise<MachineExecutionResult> {
    const auth = request?.authorization;
    if (!isExecutionAuthorization(auth)) {
      throw new ControlStackError(
        "desktop_commander_unauthorized",
        "execute() requires a valid ExecutionAuthorization produced by authorizeDesktopCommanderExecution"
      );
    }

    // Defence in depth: re-run the checks that do not need store state.
    const policy = desktopCommanderToolPolicy(auth.toolName);
    if (!policy) {
      throw new ControlStackError(
        "desktop_commander_tool_not_allowlisted",
        `tool is not on the ACS allowlist: ${auth.toolName}`
      );
    }
    const reparsed = policy.argsSchema.safeParse(auth.normalizedArguments);
    if (!reparsed.success) {
      throw new ControlStackError(
        "desktop_commander_argument_invalid",
        `authorized arguments failed re-validation for ${auth.toolName}`
      );
    }
    const refingerprint = desktopCommanderInvocationFingerprint({
      toolName: auth.toolName,
      validatedArguments: auth.normalizedArguments as Record<string, unknown>
    });
    if (refingerprint !== auth.invocationFingerprint) {
      throw new ControlStackError(
        "desktop_commander_invocation_tampered",
        "authorized arguments do not match the authorized invocation fingerprint"
      );
    }
    for (const canonical of auth.canonicalPaths) {
      // Re-assert containment; throws if a canonical path is no longer contained.
      containPath(this.containment, canonical);
    }

    await this.ensureConnected();

    const startedAt = this.now();
    let raw: McpToolCallResult;
    try {
      raw = await this.withTimeout(
        this.transport.callTool(auth.toolName, auth.normalizedArguments),
        policy.timeoutMs,
        auth.toolName,
        request.signal
      );
    } catch (error) {
      const completedAt = this.now();
      const message = error instanceof Error ? error.message : String(error);
      return {
        toolName: auth.toolName,
        invocationFingerprint: auth.invocationFingerprint,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
        isError: true,
        output: "",
        error: message.slice(0, 4000),
        truncated: false,
        resultHash: "",
        omittedBlocks: 0
      };
    }
    const completedAt = this.now();

    return normalizeToolResult(raw, {
      toolName: auth.toolName,
      invocationFingerprint: auth.invocationFingerprint,
      startedAt,
      completedAt,
      maxResultBytes: Math.min(policy.maxResultBytes, this.config.maxResultBytes)
    });
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    toolName: string,
    signal?: AbortSignal
  ): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new ControlStackError(
            "desktop_commander_tool_timeout",
            `Desktop Commander tool '${toolName}' timed out after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new ControlStackError("desktop_commander_tool_aborted", `tool '${toolName}' aborted`));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      promise.then(
        (value) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}

export { authorizeDesktopCommanderExecution };
export type { AuthorizeExecutionInput, ExecutionAuthorization };
