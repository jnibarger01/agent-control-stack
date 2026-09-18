import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ControlStackError } from "@agent-control-stack/shared";

/**
 * Minimal Model Context Protocol client over a local stdio subprocess.
 *
 * ACS deliberately does not depend on `@modelcontextprotocol/sdk` (it would pull
 * a second major of `zod` into the workspace). This is a hand-rolled transport
 * that implements exactly the three verbs the Desktop Commander adapter needs -
 * `initialize`, `tools/list`, `tools/call` - modelled on
 * `packages/acp-adapter`'s newline-delimited JSON-RPC framing.
 *
 * The client owns transport only. It performs no authorization, no tool
 * allow-listing and no argument validation - those are the caller's job
 * (`DesktopCommanderMachineExecutor`).
 */

const JSON_RPC_VERSION = "2.0";
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_STDOUT_BUFFER_LIMIT_BYTES = 32 * 1024 * 1024;

type JsonRpcId = number;

interface JsonRpcResponse {
  jsonrpc: typeof JSON_RPC_VERSION;
  id?: JsonRpcId | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: unknown;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

export interface McpToolCallResult {
  content?: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

export interface McpRuntimeBootstrap {
  readonly schemaVersion: 1;
  readonly runtimeId: string;
  readonly challenge: string;
  readonly scopes: readonly string[];
}

export type McpRuntimeIdentity = McpRuntimeBootstrap;

export interface McpStdioClientOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  /** Extra environment entries merged on top of the safe allow-listed base. */
  env?: Record<string, string>;
  clientName?: string;
  clientVersion?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxMessageBytes?: number;
  /** Sink for the child's stderr (telemetry only, never trusted). */
  onStderr?: (chunk: string) => void;
}

export interface McpServerInfo {
  name?: string;
  version?: string;
  protocolVersion?: string;
}

const childEnvironmentAllowlist = new Set([
  "COMSPEC",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "USERNAME",
  "WINDIR"
]);

export function desktopCommanderChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  additions: Record<string, string> = {}
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && childEnvironmentAllowlist.has(name.toUpperCase())) {
      environment[name] = value;
    }
  }
  // Keep the local Desktop Commander MCP fully offline and non-interactive.
  environment.DESKTOP_COMMANDER_DISABLE_TELEMETRY = "1";
  environment.DC_REMOTE_DEVICE = "true";
  environment.DC_TELEMETRY = "false";
  for (const [name, value] of Object.entries(additions)) {
    environment[name] = value;
  }
  return environment;
}

class LineBuffer {
  private buffer = "";

  constructor(private readonly maxMessageBytes: number) {}

  push(chunk: string): string[] {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxMessageBytes) {
      throw new ControlStackError(
        "desktop_commander_message_too_large",
        `Desktop Commander stdout exceeded ${this.maxMessageBytes} bytes without a newline`
      );
    }
    const lines: string[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim().length > 0) {
        lines.push(line);
      }
      newline = this.buffer.indexOf("\n");
    }
    return lines;
  }
}

interface PendingRequest {
  resolve: (value: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private stdout: LineBuffer;
  private nextId = 1;
  private closed = false;
  private connected = false;
  private fatalError: Error | undefined;
  private serverInfo: McpServerInfo = {};
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: McpStdioClientOptions) {
    this.stdout = new LineBuffer(options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  getServerInfo(): McpServerInfo {
    return { ...this.serverInfo };
  }

  isConnected(): boolean {
    return this.connected && !this.closed && this.fatalError === undefined;
  }

  async connect(
    runtimeBootstrap?: McpRuntimeBootstrap
  ): Promise<McpServerInfo & { runtimeIdentity?: McpRuntimeIdentity }> {
    if (this.child) {
      throw new ControlStackError("desktop_commander_already_connected", "MCP stdio client already connected");
    }
    const child = spawn(this.options.command, [...(this.options.args ?? [])], {
      cwd: this.options.cwd,
      env: desktopCommanderChildEnvironment(process.env, this.options.env ?? {}),
      stdio: "pipe",
      shell: false
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    let stderrBudget = DEFAULT_STDOUT_BUFFER_LIMIT_BYTES;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrBudget -= Buffer.byteLength(chunk, "utf8");
      if (stderrBudget > 0) this.options.onStderr?.(chunk);
    });
    child.on("error", (error) => this.failFatally(error));
    child.on("exit", (code, signal) => {
      this.failFatally(
        new ControlStackError(
          "desktop_commander_process_exited",
          `Desktop Commander MCP exited (code=${code ?? "null"} signal=${signal ?? "null"})`
        )
      );
    });

    try {
      const connectTimeoutMs = this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
      const initialize = (await this.request(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: this.options.clientName ?? "acs-desktop-commander-adapter",
            version: this.options.clientVersion ?? "0.1.0"
          },
          ...(runtimeBootstrap ? { _meta: { acsRuntimeBootstrap: runtimeBootstrap } } : {})
        },
        connectTimeoutMs
      )) as {
        protocolVersion?: string;
        serverInfo?: { name?: string; version?: string };
        _meta?: { acsRuntimeIdentity?: unknown };
      };

      const runtimeIdentity = runtimeBootstrap
        ? requireExactRuntimeIdentity(initialize?._meta?.acsRuntimeIdentity, runtimeBootstrap)
        : undefined;

      this.serverInfo = {
        name: initialize?.serverInfo?.name,
        version: initialize?.serverInfo?.version,
        protocolVersion: initialize?.protocolVersion
      };
      this.notify("notifications/initialized", {});
      this.connected = true;
      return { ...this.getServerInfo(), ...(runtimeIdentity ? { runtimeIdentity } : {}) };
    } catch (error) {
      // A failed connect must not poison the client: kill the half-open child
      // and reset state so the next connect() starts a clean session.
      if (child && !child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
      this.child = undefined;
      this.connected = false;
      this.fatalError = undefined;
      throw error;
    }
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.request("tools/list", {})) as { tools?: McpToolDescriptor[] };
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name: string, args: unknown, meta?: Record<string, unknown>): Promise<McpToolCallResult> {
    const result = (await this.request("tools/call", {
      name,
      arguments: args ?? {},
      ...(meta ? { _meta: meta } : {})
    })) as McpToolCallResult;
    return result ?? {};
  }

  /**
   * Fully tear down the transport and leave the client reusable.
   *
   * This is a reconnectable lifecycle, not a one-shot dispose: `close()` kills
   * the child (terminating any in-flight tool execution - stdio MCP has no
   * server-side cancellation), then resets all transport state so a later
   * `connect()` spawns a clean fresh session. Callers rely on this to recover
   * from timeouts and aborts without discarding the executor.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(
        this.fatalError ?? new ControlStackError("desktop_commander_client_closed", "MCP stdio client closed")
      );
    }
    this.pending.clear();
    const child = this.child;
    if (child && !child.killed) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
          resolve();
        }, 2_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    // The 'exit' listener installed in connect() calls failFatally() while the
    // child dies; that state belonged to the torn-down session. Reset every
    // field so the next connect() starts from a clean slate.
    this.child = undefined;
    this.closed = false;
    this.connected = false;
    this.fatalError = undefined;
    this.serverInfo = {};
    this.stdout = new LineBuffer(this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES);
  }

  private async request(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    if (this.fatalError) throw this.fatalError;
    if (this.closed) {
      throw new ControlStackError("desktop_commander_client_closed", "MCP stdio client closed");
    }
    const child = this.child;
    if (!child || !child.stdin.writable) {
      throw new ControlStackError("desktop_commander_not_connected", "MCP stdio client is not connected");
    }
    const id = this.nextId++;
    const payload = `${JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id, method, params })}\n`;
    if (payload.includes("\n", 0) && payload.indexOf("\n") !== payload.length - 1) {
      throw new ControlStackError("desktop_commander_invalid_frame", "JSON-RPC frame contains an embedded newline");
    }

    const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ControlStackError(
            "desktop_commander_request_timeout",
            `Desktop Commander MCP request '${method}' timed out after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(payload, (error) => {
        if (error) {
          const record = this.pending.get(id);
          if (record) {
            clearTimeout(record.timer);
            this.pending.delete(id);
          }
          reject(error);
        }
      });
    });

    if (response.error) {
      throw new ControlStackError(
        "desktop_commander_tool_error",
        `Desktop Commander MCP '${method}' failed: ${response.error.message} (code ${response.error.code})`
      );
    }
    return response.result;
  }

  private notify(method: string, params: unknown): void {
    const child = this.child;
    if (!child || !child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: JSON_RPC_VERSION, method, params })}\n`);
  }

  private onStdout(chunk: string): void {
    let lines: string[];
    try {
      lines = this.stdout.push(chunk);
    } catch (error) {
      this.failFatally(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    for (const line of lines) {
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        // Desktop Commander wraps stray stdout as log notifications, but a
        // hard parse failure of a framed line is a protocol violation.
        this.failFatally(
          new ControlStackError(
            "desktop_commander_malformed_json_rpc",
            "malformed JSON-RPC line from Desktop Commander"
          )
        );
        return;
      }
      if (message.jsonrpc !== JSON_RPC_VERSION) continue;
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        pending.resolve(message);
      }
      // Notifications (no id) from the server are ignored - the adapter never
      // subscribes to Desktop Commander resources or logging.
    }
  }

  private failFatally(error: Error): void {
    if (this.fatalError) return;
    this.fatalError = error;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    const child = this.child;
    if (child && !child.killed) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

function requireExactRuntimeIdentity(value: unknown, expected: McpRuntimeBootstrap): McpRuntimeIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ControlStackError(
      "desktop_commander_runtime_identity_rejected",
      "runtime identity is missing or malformed"
    );
  }
  const identity = value as Record<string, unknown>;
  const keys = Object.keys(identity).sort();
  const expectedKeys = ["challenge", "runtimeId", "schemaVersion", "scopes"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new ControlStackError(
      "desktop_commander_runtime_identity_rejected",
      "runtime identity has unexpected fields"
    );
  }
  if (
    identity.schemaVersion !== 1 ||
    identity.runtimeId !== expected.runtimeId ||
    identity.challenge !== expected.challenge ||
    !Array.isArray(identity.scopes) ||
    identity.scopes.length !== expected.scopes.length ||
    identity.scopes.some((scope, index) => scope !== expected.scopes[index])
  ) {
    throw new ControlStackError(
      "desktop_commander_runtime_identity_rejected",
      "runtime identity does not exactly match bootstrap"
    );
  }
  return {
    schemaVersion: 1,
    runtimeId: expected.runtimeId,
    challenge: expected.challenge,
    scopes: [...expected.scopes]
  };
}
