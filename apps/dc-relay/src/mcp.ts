import crypto from 'node:crypto';
import { z } from 'zod';
import { CallRecord, ControlPlaneError, ControlPlaneService, DeviceView } from './service.js';

/**
 * Claude-facing MCP endpoint (Streamable HTTP, JSON responses only, stateless).
 * It exposes exactly three tools and never a direct process/file tool: every
 * execution goes through the durable dispatch → device claim → complete path.
 */
export const MCP_TOOL_NAMES = ['list_devices', 'get_device', 'call_device_tool'] as const;
export const MCP_MAX_WAIT_MS = 60_000;
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'timed_out', 'cancelled']);

export interface McpOptions {
  pollIntervalMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}
interface JsonRpcRequest { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown>; }
export type JsonRpcResponse = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

const deviceIdSchema = z.object({ device_id: z.string().uuid() }).strict();
const callSchema = z.object({
  device_id: z.string().uuid(),
  tool_name: z.string().min(1).max(128),
  arguments: z.record(z.unknown()).optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
  timeout_ms: z.number().int().min(1).max(MCP_MAX_WAIT_MS).optional(),
}).strict();

export const MCP_TOOLS = [
  {
    name: 'list_devices',
    description: 'List your registered Desktop Commander devices and whether each is online and ready to execute.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_device',
    description: 'Get one device, including the reason it is not ready when it cannot execute.',
    inputSchema: { type: 'object', properties: { device_id: { type: 'string', format: 'uuid' } }, required: ['device_id'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'call_device_tool',
    description: 'Run one Desktop Commander tool on a ready device and wait (at most 60s) for its result.',
    inputSchema: {
      type: 'object',
      properties: {
        device_id: { type: 'string', format: 'uuid' },
        tool_name: { type: 'string', description: 'Desktop Commander tool name, e.g. list_directory' },
        arguments: { type: 'object', description: 'Arguments for the device tool' },
        idempotency_key: { type: 'string', description: 'Optional; reuse to fetch the same call instead of dispatching again' },
        timeout_ms: { type: 'integer', minimum: 1, maximum: MCP_MAX_WAIT_MS },
      },
      required: ['device_id', 'tool_name'],
      additionalProperties: false,
    },
  },
];

function deviceSummary(device: DeviceView): Record<string, unknown> {
  return {
    id: device.id,
    device_name: device.device_name,
    state: device.effective_state,
    execution_ready: device.executionReady,
    reason: device.reason,
    last_seen: device.last_seen,
    tool_names: Array.isArray(device.capabilities?.tool_names) ? device.capabilities.tool_names : [],
  };
}
function text(value: unknown, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], isError };
}
function toolResultFromCall(call: CallRecord): Record<string, unknown> {
  if (call.status === 'completed') {
    const result = call.result as { content?: unknown; isError?: unknown } | null;
    if (result && Array.isArray(result.content)) return { content: result.content, isError: result.isError === true };
    return text(result ?? null);
  }
  return text({ call_id: call.id, status: call.status, error: call.error_message ?? `call ${call.status}` }, true);
}

export class McpHandler {
  private readonly pollIntervalMs: number;
  private readonly maxWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: McpOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.maxWaitMs = Math.min(options.maxWaitMs ?? MCP_MAX_WAIT_MS, MCP_MAX_WAIT_MS);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Returns null for notifications (HTTP 202, no body). */
  async handle(message: unknown, userId: string, service: ControlPlaneService): Promise<JsonRpcResponse | null> {
    const request = message as JsonRpcRequest;
    if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }
    if (request.id === undefined) return null;
    const id = request.id ?? null;
    try {
      switch (request.method) {
        case 'initialize': {
          const requested = typeof request.params?.protocolVersion === 'string' ? request.params.protocolVersion : '';
          return { jsonrpc: '2.0', id, result: {
            protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'dc-own-relay', version: '1.0.0' },
          } };
        }
        case 'ping': return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list': return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
        case 'tools/call': return { jsonrpc: '2.0', id, result: await this.callTool(request.params ?? {}, userId, service) };
        default: return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
      }
    } catch (error) {
      if (error instanceof z.ZodError) return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params' } };
      throw error;
    }
  }

  private async callTool(params: Record<string, unknown>, userId: string, service: ControlPlaneService): Promise<Record<string, unknown>> {
    const name = params.name;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (name === 'list_devices') return text({ devices: (await service.listDevices(userId)).map(deviceSummary) });
      if (name === 'get_device') return text(deviceSummary(await service.getDevice(userId, deviceIdSchema.parse(args).device_id)));
      if (name === 'call_device_tool') return await this.callDeviceTool(callSchema.parse(args), userId, service);
    } catch (error) {
      if (error instanceof ControlPlaneError) return text({ error: error.code, message: error.message }, true);
      throw error;
    }
    return text({ error: 'unknown_tool' }, true);
  }

  private async callDeviceTool(input: z.infer<typeof callSchema>, userId: string, service: ControlPlaneService): Promise<Record<string, unknown>> {
    const budget = Math.min(input.timeout_ms ?? this.maxWaitMs, this.maxWaitMs);
    const started = Date.now();
    const idempotencyKey = input.idempotency_key ?? crypto.randomUUID();
    let call = await service.dispatch(userId, input.device_id, {
      tool_name: input.tool_name,
      arguments: input.arguments ?? {},
      metadata: { origin: 'dc-own-relay-mcp' },
      idempotency_key: idempotencyKey,
    });
    while (!TERMINAL.has(call.status) && Date.now() - started < budget) {
      await this.sleep(Math.min(this.pollIntervalMs, Math.max(0, budget - (Date.now() - started))));
      call = await service.getCall(userId, input.device_id, call.id);
    }
    if (!TERMINAL.has(call.status)) {
      return text({ call_id: call.id, status: call.status, idempotency_key: idempotencyKey, error: `no result within ${budget}ms; re-run with the same idempotency_key to fetch it` }, true);
    }
    return toolResultFromCall(call);
  }
}
