import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { basename } from "node:path";
import { ControlStackError } from "@agent-control-stack/shared";
import {
  type AcpTimelineEventType,
  type RegistryCapabilityInput,
  type RegistryStatus,
  type WorkItemStore
} from "@agent-control-stack/work-items";

type JsonRpcId = string | number | null;

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface ReadonlyAcpAdapterOptions {
  store: WorkItemStore;
  agentId: string;
  actorId: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  initializeTimeoutMs?: number;
  protocolVersion?: string;
}

export interface ReadonlyAcpAdapterConfig {
  agentId: string;
  actorId: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  initializeTimeoutMs?: number;
  protocolVersion?: string;
}

export interface ReadonlyAcpAdapterStatus {
  agentId: string;
  connected: boolean;
  processAlive: boolean;
  initialized: boolean;
  protocolVersion?: string;
  agentName?: string;
  agentVersion?: string;
  capabilities: string[];
  authMethods: string[];
  supportedSessionFeatures: string[];
  lastMessageAt?: string;
  lastSessionUpdateAt?: string;
  lastError?: string;
  activeSessionId?: string;
  activeWorkItemId?: string;
}

interface InitializeMetadata {
  protocolVersion?: string;
  agentName?: string;
  agentVersion?: string;
  capabilities: string[];
  authMethods: string[];
  supportedSessionFeatures: string[];
  rawCapabilities: unknown;
}

export function acpAdapterConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ReadonlyAcpAdapterConfig | undefined {
  const command = env.ACS_ACP_AGENT_COMMAND?.trim();
  if (!command) return undefined;
  const agentId = env.ACS_ACP_AGENT_ID?.trim();
  const actorId = env.ACS_ACP_ACTOR_ID?.trim();
  if (!agentId || !actorId) {
    throw new ControlStackError(
      "acp_adapter_config_invalid",
      "ACS_ACP_AGENT_ID and ACS_ACP_ACTOR_ID are required when ACS_ACP_AGENT_COMMAND is set"
    );
  }
  return {
    agentId,
    actorId,
    command,
    args: parseArgs(env.ACS_ACP_AGENT_ARGS_JSON),
    cwd: env.ACS_ACP_AGENT_CWD,
    initializeTimeoutMs: env.ACS_ACP_INITIALIZE_TIMEOUT_MS
      ? Number(env.ACS_ACP_INITIALIZE_TIMEOUT_MS)
      : undefined,
    protocolVersion: env.ACS_ACP_PROTOCOL_VERSION
  };
}

export class ReadonlyAcpAdapter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly parser = new JsonRpcParser();
  private nextId = 1;
  private initializeId: JsonRpcId | undefined;
  private initializeSettled = false;
  private exitPromise: Promise<ReadonlyAcpAdapterStatus> | undefined;
  private resolveExit: ((status: ReadonlyAcpAdapterStatus) => void) | undefined;
  private readonly permissionRequestIds = new Set<string>();
  private registered = false;
  private readonly status: ReadonlyAcpAdapterStatus;

  constructor(private readonly options: ReadonlyAcpAdapterOptions) {
    this.status = {
      agentId: options.agentId,
      connected: false,
      processAlive: false,
      initialized: false,
      capabilities: [],
      authMethods: [],
      supportedSessionFeatures: []
    };
  }

  async start(): Promise<ReadonlyAcpAdapterStatus> {
    if (this.child) {
      throw new ControlStackError("acp_adapter_already_started", `ACP adapter already started: ${this.options.agentId}`);
    }
    this.options.store.registerActor({
      id: this.options.actorId,
      actorType: "SERVICE",
      displayName: "ACP read-only adapter",
      externalRef: `acp:stdio:${this.options.command}`
    });

    this.child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: this.options.env ? { ...process.env, ...this.options.env } : process.env,
      stdio: "pipe",
      shell: false
    });
    this.status.connected = true;
    this.status.processAlive = true;
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });

    this.child.stdout.on("data", (chunk: Buffer) => this.acceptStdout(chunk));
    this.child.stdin.on("error", (error) => this.failProcessError(error.message));
    this.child.on("error", (error) => this.failProcessError(error.message));
    this.child.on("exit", (code, signal) => this.handleExit(code, signal));

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failBeforeInitialize("acp_initialize_timeout", "ACP initialize timed out");
      }, this.options.initializeTimeoutMs ?? 1_000);
      const id = this.nextId++;
      this.initializeId = id;
      const settle = (result: ReadonlyAcpAdapterStatus | Error) => {
        clearTimeout(timer);
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      this.onInitializeSettled = settle;
      this.send({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: this.options.protocolVersion ?? "1.0",
          clientInfo: { name: "agent-control-stack", version: "0.1.0" },
          capabilities: { filesystem: false, terminal: false }
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.child || this.child.killed) return;
    this.child.kill();
    await this.waitForExit();
  }

  async waitForExit(timeoutMs = 1_000): Promise<ReadonlyAcpAdapterStatus> {
    if (!this.child || !this.status.processAlive) return this.snapshot();
    const timeout = new Promise<ReadonlyAcpAdapterStatus>((resolve) => {
      setTimeout(() => resolve(this.snapshot()), timeoutMs);
    });
    return await Promise.race([this.exitPromise ?? Promise.resolve(this.snapshot()), timeout]);
  }

  getStatus(): ReadonlyAcpAdapterStatus {
    return this.snapshot();
  }

  private onInitializeSettled: ((result: ReadonlyAcpAdapterStatus | Error) => void) | undefined;

  private acceptStdout(chunk: Buffer): void {
    let messages: JsonRpcMessage[];
    try {
      messages = this.parser.push(chunk);
    } catch (error) {
      this.failBeforeInitialize("acp_malformed_json_rpc", errorMessage(error));
      return;
    }
    for (const message of messages) {
      this.acceptMessage(message);
    }
  }

  private acceptMessage(message: JsonRpcMessage): void {
    const now = new Date().toISOString();
    this.status.lastMessageAt = now;
    if (!isJsonRpcMessage(message)) {
      this.failBeforeInitialize("acp_malformed_json_rpc", "malformed JSON-RPC message");
      return;
    }
    if (!this.initializeSettled && message.id === this.initializeId) {
      this.acceptInitializeResponse(message);
      return;
    }
    if (message.method) {
      if (message.id !== undefined) {
        this.rejectClientRequest(message);
      } else {
        this.recordNotification(message);
      }
      return;
    }
    this.recordTimeline("message", message);
  }

  private acceptInitializeResponse(message: JsonRpcMessage): void {
    this.initializeSettled = true;
    if (message.error) {
      const reason = `ACP initialize failed: ${JSON.stringify(message.error)}`;
      this.failClosed("acp_initialize_failed", reason);
      this.onInitializeSettled?.(new ControlStackError("acp_initialize_failed", reason));
      return;
    }
    try {
      const metadata = initializeMetadata(message.result);
      const unsupported = unsupportedCapabilities(metadata.rawCapabilities);
      if (unsupported.length) {
        const reason = `unsupported ACP capability: ${unsupported[0]}`;
        this.failClosed("acp_unsupported_capability", reason);
        this.onInitializeSettled?.(new ControlStackError("acp_unsupported_capability", reason));
        return;
      }
      this.registerInitializedAgent(metadata);
      this.onInitializeSettled?.(this.snapshot());
    } catch (error) {
      this.failClosed("acp_initialize_failed", errorMessage(error));
      this.onInitializeSettled?.(error instanceof Error ? error : new Error(errorMessage(error)));
    }
  }

  private registerInitializedAgent(metadata: InitializeMetadata): void {
    this.status.initialized = true;
    this.status.protocolVersion = metadata.protocolVersion;
    this.status.agentName = metadata.agentName;
    this.status.agentVersion = metadata.agentVersion;
    this.status.capabilities = metadata.capabilities;
    this.status.authMethods = metadata.authMethods;
    this.status.supportedSessionFeatures = metadata.supportedSessionFeatures;
    const existing = this.options.store.getRegistryAgent(this.options.agentId);
    const payload = {
      name: metadata.agentName ?? this.options.agentId,
      kind: "acp-adapter",
      acpRole: "LOCAL_CODING_AGENT" as const,
      provider: "acp",
      model: metadata.agentVersion,
      endpoint: `stdio:${basename(this.options.command)}`,
      status: "AVAILABLE" as const,
      actorId: this.options.actorId
    };
    if (existing) {
      this.options.store.updateRegistryAgent(this.options.agentId, payload);
    } else {
      this.options.store.createRegistryAgent({ id: this.options.agentId, ...payload });
    }
    this.registered = true;
    this.options.store.replaceAgentCapabilities(this.options.agentId, capabilityInputs(metadata), this.options.actorId);
    this.recordHeartbeat("AVAILABLE");
    this.recordTimeline("initialized", {
      protocolVersion: metadata.protocolVersion,
      agentName: metadata.agentName,
      agentVersion: metadata.agentVersion,
      capabilities: metadata.capabilities,
      authMethods: metadata.authMethods,
      supportedSessionFeatures: metadata.supportedSessionFeatures
    });
  }

  private rejectClientRequest(message: JsonRpcMessage): void {
    const method = message.method ?? "";
    const permission = permissionRequestId(message.params);
    let reason = "ACP client methods are disabled in the read-only adapter";
    if (permission) {
      reason = this.permissionRequestIds.has(permission)
        ? "duplicate permission request rejected"
        : "unknown permission request rejected";
      this.permissionRequestIds.add(permission);
    } else if (isFilesystemMethod(method)) {
      reason = "ACP filesystem methods are disabled";
    } else if (isTerminalMethod(method)) {
      reason = "ACP terminal methods are disabled";
    }
    this.status.lastError = reason;
    this.send({
      jsonrpc: "2.0",
      id: message.id ?? null,
      error: { code: -32001, message: reason }
    });
    this.recordTimeline("client_method_rejected", message, { reason });
  }

  private recordNotification(message: JsonRpcMessage): void {
    const eventType = classifyAcpEvent(message.method ?? "");
    const record = asRecord(message.params);
    const sessionId = stringValue(record.sessionId) ?? stringValue(record.session_id);
    const workItemId = stringValue(record.workItemId) ?? stringValue(record.work_item_id);
    const method = message.method?.toLowerCase() ?? "";
    if (sessionId || method.includes("session") || method.includes("update")) {
      this.status.lastSessionUpdateAt = new Date().toISOString();
      this.status.activeSessionId = sessionId ?? this.status.activeSessionId;
      this.status.activeWorkItemId = workItemId ?? this.status.activeWorkItemId;
      this.recordHeartbeat(eventType === "stop" ? "AVAILABLE" : "BUSY", sessionId ? `session:${sessionId}` : undefined);
    }
    this.recordTimeline(eventType, message);
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.status.processAlive = false;
    this.status.connected = false;
    const error = code === 0 ? undefined : `ACP process exited: code=${code ?? "null"} signal=${signal ?? "null"}`;
    if (error) this.status.lastError = error;
    if (this.registered) {
      this.recordHeartbeat("OFFLINE", undefined, error);
      this.recordTimeline("disconnected", { code, signal, error });
    }
    if (!this.initializeSettled) {
      this.initializeSettled = true;
      this.onInitializeSettled?.(
        new ControlStackError("acp_process_exited", error ?? "ACP process exited before initialize completed")
      );
    }
    this.resolveExit?.(this.snapshot());
  }

  private failClosed(code: string, message: string): void {
    this.status.lastError = message;
    if (this.registered) {
      this.recordHeartbeat("ERROR", undefined, message);
    }
    try {
      this.recordTimeline("error", { code, error: message });
    } catch {
      // If audit recording itself is unavailable, process shutdown still fails closed.
    }
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
  }

  private failBeforeInitialize(code: string, message: string): void {
    this.failClosed(code, message);
    if (!this.initializeSettled) {
      this.initializeSettled = true;
      this.onInitializeSettled?.(new ControlStackError(code, message));
    }
  }

  private failProcessError(message: string): void {
    if (!this.initializeSettled) {
      this.failBeforeInitialize("acp_process_error", message);
      return;
    }
    this.failClosed("acp_process_error", message);
  }

  private recordHeartbeat(status: RegistryStatus, currentTask?: string, lastError?: string): void {
    if (!this.registered) return;
    this.options.store.recordAgentHeartbeat(this.options.agentId, {
      actorId: this.options.actorId,
      status,
      currentTask,
      lastError
    });
  }

  private recordTimeline(eventType: AcpTimelineEventType, message: unknown, extra: Record<string, unknown> = {}): void {
    this.options.store.recordAgentTimelineEvent({
      agentId: this.options.agentId,
      actorId: this.options.actorId,
      eventType,
      method: isRecord(message) && typeof message.method === "string" ? message.method : undefined,
      messageId: isRecord(message) && message.id !== undefined ? String(message.id) : undefined,
      sessionId: sessionIdFrom(message),
      workItemId: workItemIdFrom(message),
      body: timelineBody(message, extra)
    });
  }

  private send(message: JsonRpcMessage): void {
    if (!this.child || this.child.stdin.destroyed || !this.child.stdin.writable) return;
    this.child.stdin.write(encodeJsonRpc(message));
  }

  private snapshot(): ReadonlyAcpAdapterStatus {
    return { ...this.status, capabilities: [...this.status.capabilities], authMethods: [...this.status.authMethods], supportedSessionFeatures: [...this.status.supportedSessionFeatures] };
  }
}

class JsonRpcParser {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): JsonRpcMessage[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: JsonRpcMessage[] = [];
    while (this.buffer.length) {
      const framed = this.tryReadFramed();
      if (framed) {
        messages.push(framed);
        continue;
      }
      const line = this.tryReadLine();
      if (line === undefined) break;
      if (!line.trim()) continue;
      messages.push(parseJsonRpc(line));
    }
    return messages;
  }

  private tryReadFramed(): JsonRpcMessage | undefined {
    const headerEnd = this.buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return undefined;
    const header = this.buffer.subarray(0, headerEnd).toString("ascii");
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) return undefined;
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (this.buffer.length < bodyStart + length) return undefined;
    const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    this.buffer = this.buffer.subarray(bodyStart + length);
    return parseJsonRpc(body);
  }

  private tryReadLine(): string | undefined {
    const newline = this.buffer.indexOf("\n");
    if (newline === -1) return undefined;
    const line = this.buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
    this.buffer = this.buffer.subarray(newline + 1);
    return line;
  }
}

function encodeJsonRpc(message: JsonRpcMessage): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function parseJsonRpc(input: string): JsonRpcMessage {
  try {
    return JSON.parse(input) as JsonRpcMessage;
  } catch {
    throw new ControlStackError("acp_malformed_json_rpc", "malformed JSON-RPC message");
  }
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return isRecord(value) && value.jsonrpc === "2.0";
}

function initializeMetadata(result: unknown): InitializeMetadata {
  const root = asRecord(result);
  const agent = asRecord(root.agent ?? root.agentInfo ?? root.serverInfo);
  const capabilities = root.capabilities;
  const session = asRecord(root.session ?? root.sessions ?? root.sessionUpdates);
  return {
    protocolVersion: stringValue(root.protocolVersion) ?? stringValue(root.protocol_version),
    agentName: stringValue(agent.name) ?? stringValue(root.name),
    agentVersion: stringValue(agent.version) ?? stringValue(root.version),
    capabilities: capabilityNames(capabilities),
    authMethods: stringArray(root.authMethods ?? root.auth_methods ?? asRecord(root.auth).methods),
    supportedSessionFeatures: [...new Set([...stringArray(root.sessionFeatures), ...Object.keys(session)])],
    rawCapabilities: capabilities
  };
}

function capabilityInputs(metadata: InitializeMetadata): RegistryCapabilityInput[] {
  const names = [
    ...metadata.capabilities.map((name) => `acp.capability.${name}`),
    ...metadata.authMethods.map((name) => `acp.auth.${name}`),
    ...metadata.supportedSessionFeatures.map((name) => `acp.session.${name}`)
  ];
  if (metadata.protocolVersion) names.unshift(`acp.protocol.${metadata.protocolVersion}`);
  return [...new Set(names)].map((name) => ({ name, description: "ACP initialize metadata" }));
}

function capabilityNames(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter(([, entry]) => entry !== false && entry !== null && entry !== undefined)
    .map(([key]) => key)
    .sort();
}

function unsupportedCapabilities(value: unknown, path: string[] = []): string[] {
  if (!isRecord(value)) return [];
  const unsupported: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (entry === false || entry === null || entry === undefined) continue;
    const capabilityPath = [...path, key].join(".");
    if (isFilesystemMethod(key) || isFilesystemMethod(capabilityPath) || isTerminalMethod(key) || isTerminalMethod(capabilityPath)) {
      unsupported.push(capabilityPath);
      continue;
    }
    unsupported.push(...unsupportedCapabilities(entry, [...path, key]));
  }
  return unsupported;
}

function classifyAcpEvent(method: string): AcpTimelineEventType {
  const normalized = method.toLowerCase();
  if (normalized.includes("plan")) return "plan";
  if (normalized.includes("tool") && (normalized.includes("propos") || normalized.includes("call"))) return "tool_call_proposed";
  if (normalized.includes("diff")) return "diff";
  if (normalized.includes("stop") || normalized.includes("finish") || normalized.includes("complete")) return "stop";
  return "message";
}

function isFilesystemMethod(method: string): boolean {
  return /(^|[./_-])(fs|file|files|filesystem)([./_-]|$)/i.test(method);
}

function isTerminalMethod(method: string): boolean {
  return /(^|[./_-])(terminal|shell|exec|command)([./_-]|$)/i.test(method);
}

function permissionRequestId(params: unknown): string | undefined {
  const method = asRecord(params);
  const id = stringValue(method.permissionId) ?? stringValue(method.permission_id) ?? stringValue(method.requestId) ?? stringValue(method.id);
  return id ?? (JSON.stringify(params).includes("permission") ? "unknown" : undefined);
}

function sessionIdFrom(message: unknown): string | undefined {
  const params = asRecord(isRecord(message) ? message.params : undefined);
  return stringValue(params.sessionId) ?? stringValue(params.session_id);
}

function workItemIdFrom(message: unknown): string | undefined {
  const params = asRecord(isRecord(message) ? message.params : undefined);
  return stringValue(params.workItemId) ?? stringValue(params.work_item_id);
}

function timelineBody(message: unknown, extra: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(message) && !("jsonrpc" in message) && !("method" in message)) {
    return { ...message, ...extra };
  }
  return { message, ...extra };
}

function parseArgs(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new ControlStackError("acp_adapter_config_invalid", "ACS_ACP_AGENT_ARGS_JSON must be a JSON string array");
  }
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
