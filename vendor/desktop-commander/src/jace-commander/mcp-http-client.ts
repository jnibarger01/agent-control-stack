/**
 * Minimal Streamable-HTTP MCP client used by the `jace-commander` CLI.
 *
 * The CLI is deliberately an ordinary MCP client of the managed /jc/mcp lane:
 * every CLI command becomes the same tools/call ChatGPT would make, so it
 * goes through the same OAuth edge, the same ACS capability issuance and the
 * same Jace Commander handler. There is no CLI-side execution path and no
 * CLI-side authorization decision.
 *
 * It classifies every outcome into a stable CLI result kind (and exit code),
 * accepting both refusal transports:
 *   - today's edge: HTTP 503 { error: managed_authorization_*, code, ... }
 *   - PR #204's edge: HTTP 200 JSON-RPC error -32001/-32002/-32003 with data
 */

export const JC_EXIT = Object.freeze({
  ok: 0,
  toolFailure: 1,
  invalidArguments: 2,
  denied: 3,
  approvalRequired: 4,
  authorityUnavailable: 5,
  notConnected: 6,
});

export type JcOutcomeKind =
  | 'ok'
  | 'tool_error'
  | 'invalid_arguments'
  | 'managed_authorization_denied'
  | 'managed_authorization_required'
  | 'managed_authorization_unavailable'
  | 'not_connected';

export interface JcCallOutcome {
  kind: JcOutcomeKind;
  exitCode: number;
  /** structuredContent of a successful tool result. */
  result?: Record<string, unknown>;
  /** Raw text content of the tool result (when no structuredContent). */
  text?: string;
  code?: string;
  message?: string;
  workItemId?: string;
  actionHash?: string;
  approvalInstructions?: string;
  retryable?: boolean;
}

export class McpTransportError extends Error {
  constructor(message: string, readonly outcome: JcCallOutcome) {
    super(message);
  }
}

const PROTOCOL_VERSION = '2025-06-18';

// Refusal codes that mean "ACS decided no" rather than "ACS could not decide".
const INVALID_ARGUMENT_CODES = new Set(['jace_commander_argument_invalid', 'invalid_arguments']);
const UNAVAILABLE_CODES = new Set([
  'managed_fail_closed', 'capability_issuance_unconfigured', 'capability_signing_key_invalid',
  'jace_commander_containment_unconfigured', 'jc_bridge_mismatch', 'acs_malformed_capability',
  'acs_capability_wrong_audience', 'execution_authority_unavailable', 'work_queue_full', 'acs_http_unreachable',
]);

function outcome(kind: JcOutcomeKind, fields: Partial<JcCallOutcome> = {}): JcCallOutcome {
  const exitCode = {
    ok: JC_EXIT.ok,
    tool_error: JC_EXIT.toolFailure,
    invalid_arguments: JC_EXIT.invalidArguments,
    managed_authorization_denied: JC_EXIT.denied,
    managed_authorization_required: JC_EXIT.approvalRequired,
    managed_authorization_unavailable: JC_EXIT.authorityUnavailable,
    not_connected: JC_EXIT.notConnected,
  }[kind];
  return { kind, exitCode, ...fields };
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** Today's edge: HTTP 503 with a flat JSON body. */
export function classifyEdgeRefusalBody(body: Record<string, unknown>): JcCallOutcome {
  const code = str(body.code) ?? 'managed_fail_closed';
  const common = {
    code,
    workItemId: str(body.workItemId),
    actionHash: str(body.actionHash),
    approvalInstructions: str(body.approvalInstructions),
    message: str(body.detail) ?? str(body.error),
  };
  if (body.error === 'managed_authorization_required') return outcome('managed_authorization_required', { ...common, retryable: true });
  if (INVALID_ARGUMENT_CODES.has(code)) return outcome('invalid_arguments', common);
  if (UNAVAILABLE_CODES.has(code) || /^acs_http_/u.test(code)) return outcome('managed_authorization_unavailable', { ...common, retryable: true });
  // Remaining codes are ACS decisions: policy denial, unknown tool, path
  // containment, lease/issuance rejection.
  return outcome('managed_authorization_denied', { ...common, retryable: false });
}

/** PR #204's edge: a JSON-RPC error on HTTP 200. */
export function classifyJsonRpcError(error: { code?: unknown; message?: unknown; data?: unknown }): JcCallOutcome {
  const data = (error.data && typeof error.data === 'object' ? error.data : {}) as Record<string, unknown>;
  const common = {
    code: str(data.acsCode) ?? String(error.code),
    message: str(error.message),
    workItemId: str(data.workItemId),
    actionHash: str(data.actionHash),
    approvalInstructions: str(data.approvalInstructions),
    retryable: typeof data.retryable === 'boolean' ? data.retryable : undefined,
  };
  if (error.code === -32002) return outcome('managed_authorization_required', common);
  if (error.code === -32001) {
    return INVALID_ARGUMENT_CODES.has(common.code) ? outcome('invalid_arguments', common) : outcome('managed_authorization_denied', common);
  }
  if (error.code === -32003) return outcome('managed_authorization_unavailable', common);
  if (error.code === -32602) return outcome('invalid_arguments', common);
  return outcome('tool_error', common);
}

/** A tools/call result. Jace Commander's own verifier refusals are denials. */
export function classifyToolResult(result: Record<string, unknown>): JcCallOutcome {
  const structured = result.structuredContent && typeof result.structuredContent === 'object'
    ? result.structuredContent as Record<string, unknown>
    : undefined;
  const content = Array.isArray(result.content) ? result.content as Array<{ type?: string; text?: string }> : [];
  const text = content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
  if (result.isError !== true) return outcome('ok', { result: structured, text });
  let error = structured?.error as { code?: string; message?: string } | undefined;
  if (!error) {
    try {
      error = (JSON.parse(text) as { error?: { code?: string; message?: string } }).error;
    } catch {
      error = undefined;
    }
  }
  const code = error?.code ?? 'tool_error';
  const fields = { code, message: error?.message ?? text, result: structured, text };
  if (/^JC_CAPABILITY_/u.test(code)) return outcome('managed_authorization_denied', fields);
  if (code === 'invalid_argument') return outcome('invalid_arguments', fields);
  return outcome('tool_error', fields);
}

function parseSse(text: string): Record<string, unknown> | undefined {
  const events = text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => {
      try {
        return JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .filter((event): event is Record<string, unknown> => Boolean(event));
  return events.find((event) => 'result' in event || 'error' in event) ?? events.at(-1);
}

export interface McpHttpClientOptions {
  url: string;
  token: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class McpHttpClient {
  private sessionId: string | undefined;
  private nextId = 1;
  private initialized = false;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: McpHttpClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async post(message: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> | undefined }> {
    const token = await this.options.token();
    if (!token) {
      throw new McpTransportError('not connected', outcome('not_connected', {
        code: 'not_connected',
        message: 'no /jc/mcp credential: run `jace-commander connect` (or set JC_MCP_TOKEN)',
      }));
    }
    let response: Response;
    try {
      response = await this.fetchImpl(this.options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          'mcp-protocol-version': PROTOCOL_VERSION,
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
      });
    } catch (error) {
      throw new McpTransportError('edge unreachable', outcome('managed_authorization_unavailable', {
        code: 'edge_unreachable',
        message: `cannot reach ${this.options.url}: ${(error as Error).message}`,
        retryable: true,
      }));
    }
    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
    const text = await response.text();
    let body: Record<string, unknown> | undefined;
    if (text.trim().startsWith('{')) {
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = undefined;
      }
    } else if (text.includes('data:')) {
      body = parseSse(text);
    }
    return { status: response.status, body };
  }

  private refusal(status: number, body: Record<string, unknown> | undefined): McpTransportError {
    if (status === 401) {
      return new McpTransportError('unauthorized', outcome('not_connected', {
        code: 'unauthorized',
        message: 'the /jc/mcp edge rejected the credential: run `jace-commander connect` again',
      }));
    }
    if (body && typeof body.error === 'string' && body.error.startsWith('managed_authorization_')) {
      return new McpTransportError('refused', classifyEdgeRefusalBody(body));
    }
    return new McpTransportError(`HTTP ${status}`, outcome('managed_authorization_unavailable', {
      code: `edge_http_${status}`,
      message: body ? JSON.stringify(body).slice(0, 300) : `edge answered HTTP ${status}`,
      retryable: status >= 500,
    }));
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const { status, body } = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'jace-commander-cli', version: '1' } },
    });
    if (status !== 200 || !body || !('result' in body)) {
      if (body && 'error' in body && status === 200) {
        throw new McpTransportError('initialize failed', classifyJsonRpcError(body.error as Record<string, unknown>));
      }
      throw this.refusal(status, body);
    }
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    this.initialized = true;
  }

  async listTools(): Promise<Array<Record<string, unknown>>> {
    await this.initialize();
    const { status, body } = await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/list', params: {} });
    if (status !== 200 || !body) throw this.refusal(status, body);
    if ('error' in body) throw new McpTransportError('tools/list failed', classifyJsonRpcError(body.error as Record<string, unknown>));
    return ((body.result as { tools?: Array<Record<string, unknown>> } | undefined)?.tools) ?? [];
  }

  /** Calls one tool and classifies the outcome. Never throws for a refusal. */
  async callTool(name: string, args: Record<string, unknown>): Promise<JcCallOutcome> {
    try {
      await this.initialize();
      const { status, body } = await this.post({
        jsonrpc: '2.0',
        id: this.nextId++,
        method: 'tools/call',
        params: { name, arguments: args },
      });
      if (status !== 200 || !body) throw this.refusal(status, body);
      if ('error' in body) return classifyJsonRpcError(body.error as Record<string, unknown>);
      return classifyToolResult((body.result ?? {}) as Record<string, unknown>);
    } catch (error) {
      if (error instanceof McpTransportError) return error.outcome;
      throw error;
    }
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    const token = await this.options.token();
    await this.fetchImpl(this.options.url, {
      method: 'DELETE',
      headers: { 'mcp-session-id': this.sessionId, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    }).catch(() => undefined);
    this.sessionId = undefined;
  }
}
