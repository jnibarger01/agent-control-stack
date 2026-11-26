/**
 * Minimal Streamable-HTTP MCP client used by the `jace-commander` / `jace` CLI.
 *
 * The CLI is deliberately an ordinary MCP client of the managed /jc/mcp lane:
 * every CLI command becomes the same tools/call ChatGPT would make, so it
 * goes through the same OAuth edge, the same ACS capability issuance and the
 * same Jace Commander handler. There is no CLI-side execution path and no
 * CLI-side authorization decision.
 *
 * Auth:
 *   - Preferred: typed `AuthProvider` (DPoP-bound tokens with fresh `DPoP` proof per
 *     request, `use_dpop_nonce` retry-once, refresh-on-401 for idempotent methods,
 *     or explicit `JC_MCP_TOKEN` legacy Bearer env override).
 *   - Legacy compat: `token()` callback (Bearer).
 *
 * It classifies every outcome into a stable CLI result kind (and exit code),
 * accepting both refusal transports:
 *   - today's edge: HTTP 503 { error: managed_authorization_*, code, ... }
 *   - PR #204's edge: HTTP 200 JSON-RPC error -32001/-32002/-32003 with data
 */
import type { AuthProvider } from './mcp-auth.js';
import { redactSecrets } from './secret-redaction.js';

export const JC_EXIT = Object.freeze({
  ok: 0,
  toolFailure: 1,
  invalidArguments: 2,
  denied: 3,
  approvalRequired: 4,
  authorityUnavailable: 5,
  notConnected: 6,
  /** A non-idempotent call failed ambiguously after send: it may have executed. */
  executionUnknown: 7,
});

export type JcOutcomeKind =
  | 'ok'
  | 'tool_error'
  | 'invalid_arguments'
  | 'managed_authorization_denied'
  | 'managed_authorization_required'
  | 'managed_authorization_unavailable'
  | 'not_connected'
  | 'execution_unknown';

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
  /**
   * @param undelivered true only when the request provably never reached the
   *   server (no request bytes were sent), so resending cannot double-execute.
   */
  constructor(message: string, readonly outcome: JcCallOutcome, readonly undelivered = false) {
    super(message);
  }
}

/**
 * Methods that are safe to resend after an ambiguous failure (5xx, timeout,
 * reset after send): they have no side effects on the server beyond session
 * setup. tools/call is deliberately NOT here: it can execute write_file,
 * start_process, privileged_exec, mission submit, ...
 */
const IDEMPOTENT_METHODS = new Set(['initialize', 'notifications/initialized', 'tools/list']);

const PRE_SEND_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
const PRE_SEND_IF_CONNECT_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH']);
const PRE_SEND_SYSCALLS = new Set(['connect', 'getaddrinfo']);

/** True only when a fetch failure provably happened before any request bytes were sent. */
export function isProvablyUndelivered(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  if (name === 'AbortError' || name === 'TimeoutError') return false;
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') {
      if (PRE_SEND_ERROR_CODES.has(code)) return true;
      const syscall = (current as { syscall?: unknown }).syscall;
      return PRE_SEND_IF_CONNECT_CODES.has(code) && typeof syscall === 'string' && PRE_SEND_SYSCALLS.has(syscall);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const PROTOCOL_VERSION = '2025-06-18';

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
    execution_unknown: JC_EXIT.executionUnknown,
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
  auth?: AuthProvider;
  token?: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface PostResult {
  status: number;
  body: Record<string, unknown> | undefined;
  /** Whether this request carried an mcp-session-id header. */
  sentSession: boolean;
}

export class McpHttpClient {
  private sessionId: string | undefined;
  private nextId = 1;
  private initialized = false;
  private readonly fetchImpl: typeof fetch;
  private readonly auth: AuthProvider;

  constructor(private readonly options: McpHttpClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (options.auth) {
      this.auth = options.auth;
    } else if (options.token) {
      const getToken = options.token;
      this.auth = {
        async getAuthHeaders() {
          const tok = await getToken();
          if (!tok) {
            return {
              ok: false,
              kind: 'not_connected',
              code: 'not_connected',
              message: 'no /jc/mcp credential: run `jace auth login` (or set JC_MCP_TOKEN)',
            };
          }
          return { ok: true, mode: 'bearer', headers: { authorization: `Bearer ${tok}` } };
        },
      };
    } else {
      throw new Error('McpHttpClient requires auth or token option');
    }
  }

  private async post(message: Record<string, unknown>, idempotent: boolean): Promise<PostResult> {
    let nonce: string | undefined;
    let authRetryCount = 0;

    for (;;) {
      const auth = await this.auth.getAuthHeaders({ method: 'POST', url: this.options.url, nonce });
      if (!auth.ok) {
        const kind = auth.kind === 'unavailable' ? 'managed_authorization_unavailable' : 'not_connected';
        throw new McpTransportError(auth.code, outcome(kind, {
          code: auth.code,
          message: redactSecrets(auth.message),
          ...(kind === 'managed_authorization_unavailable' ? { retryable: true } : {}),
        }));
      }

      const sentSession = this.sessionId !== undefined;
      let response: Response;
      try {
        response = await this.fetchImpl(this.options.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...auth.headers,
            'mcp-protocol-version': PROTOCOL_VERSION,
            ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
          },
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
        });
      } catch (error) {
        throw new McpTransportError('edge unreachable', outcome('managed_authorization_unavailable', {
          code: 'edge_unreachable',
          message: redactSecrets(`cannot reach ${this.options.url}: ${(error as Error).message}`),
          retryable: true,
        }), isProvablyUndelivered(error));
      }

      if (response.status === 401 && authRetryCount === 0 && this.auth.handleAuthChallenge) {
        const challenge = await this.auth.handleAuthChallenge({
          status: response.status,
          headers: response.headers,
          method: 'POST',
          url: this.options.url,
          sentAuthMode: auth.mode,
          idempotent,
        });
        // Gateway 401 DPoP-Nonce challenges reject before upstream MCP dispatch, so retry once.
        // For expired-token 401 refreshes (no nonce), retry ONLY idempotent methods.
        if (challenge.retry && (challenge.nonce !== undefined || idempotent)) {
          authRetryCount += 1;
          nonce = challenge.nonce;
          await response.text().catch(() => undefined);
          continue;
        }
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
      return { status: response.status, body, sentSession };
    }
  }

  /**
   * Posts `message` with bounded backoff retry.
   *
   * Idempotent methods (initialize, notifications/initialized, tools/list) are
   * retried on 5xx and on any retryable transport error. Every other method
   * (tools/call) is retried ONLY on provable non-delivery: a connect/DNS error
   * raised before any request bytes were sent. A 5xx, timeout, reset after
   * send, or any other ambiguous failure is returned/raised to the caller
   * immediately, because the server may already have executed the call.
   */
  private async postWithRetry(message: Record<string, unknown>, attempts = 3): Promise<PostResult> {
    const idempotent = typeof message.method === 'string' && IDEMPOTENT_METHODS.has(message.method);
    let lastError: McpTransportError | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** (attempt - 1), 1000)));
      }
      try {
        const result = await this.post(message, idempotent);
        if (idempotent && result.status >= 500 && attempt < attempts - 1) continue;
        return result;
      } catch (error) {
        if (!(error instanceof McpTransportError) || error.outcome.retryable !== true) throw error;
        if (!idempotent && !error.undelivered) {
          throw new McpTransportError('execution unknown', outcome('execution_unknown', {
            code: 'execution_unknown',
            message: redactSecrets(`${String(message.method)} may have executed: the request was sent but no response arrived (${error.outcome.message ?? 'transport error'}). Verify its effects before re-running it.`),
            retryable: false,
          }));
        }
        lastError = error;
      }
    }
    throw lastError ?? new McpTransportError('retry exhausted', outcome('managed_authorization_unavailable', {
      code: 'edge_unreachable', message: 'retry exhausted', retryable: true,
    }));
  }

  /** Drops the current session and re-establishes it (used after a stale 404). */
  private async reinitialize(): Promise<void> {
    this.initialized = false;
    this.sessionId = undefined;
    await this.initialize();
  }

  private refusal(status: number, body: Record<string, unknown> | undefined, method?: string): McpTransportError {
    if (status === 401) {
      return new McpTransportError('unauthorized', outcome('not_connected', {
        code: 'unauthorized',
        message: 'the /jc/mcp edge rejected the credential: run `jace auth login` again',
      }));
    }
    if (body && typeof body.error === 'string' && body.error.startsWith('managed_authorization_')) {
      return new McpTransportError('refused', classifyEdgeRefusalBody(body));
    }
    if (status >= 500 && method !== undefined && !IDEMPOTENT_METHODS.has(method)) {
      return new McpTransportError('execution unknown', outcome('execution_unknown', {
        code: 'execution_unknown',
        message: redactSecrets(`${method} may have executed: the edge answered HTTP ${status}${body ? ` ${JSON.stringify(body).slice(0, 300)}` : ''}. Verify its effects before re-running it.`),
        retryable: false,
      }));
    }
    return new McpTransportError(`HTTP ${status}`, outcome('managed_authorization_unavailable', {
      code: `edge_http_${status}`,
      message: redactSecrets(body ? JSON.stringify(body).slice(0, 300) : `edge answered HTTP ${status}`),
      retryable: status >= 500,
    }));
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const { status, body } = await this.postWithRetry({
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
    await this.postWithRetry({ jsonrpc: '2.0', method: 'notifications/initialized' });
    this.initialized = true;
  }

  async listTools(): Promise<Array<Record<string, unknown>>> {
    await this.initialize();
    const initial = await this.postWithRetry({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/list', params: {} });
    let { status, body } = initial;
    const { sentSession } = initial;
    if (status === 404 && sentSession) {
      await this.reinitialize();
      ({ status, body } = await this.postWithRetry({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/list', params: {} }));
    }
    if (status !== 200 || !body) throw this.refusal(status, body);
    if ('error' in body) throw new McpTransportError('tools/list failed', classifyJsonRpcError(body.error as Record<string, unknown>));
    return ((body.result as { tools?: Array<Record<string, unknown>> } | undefined)?.tools) ?? [];
  }

  /** Calls one tool and classifies the outcome. Never throws for a refusal. */
  async callTool(name: string, args: Record<string, unknown>): Promise<JcCallOutcome> {
    try {
      await this.initialize();
      const initial = await this.postWithRetry({
        jsonrpc: '2.0',
        id: this.nextId++,
        method: 'tools/call',
        params: { name, arguments: args },
      });
      let { status, body } = initial;
      const { sentSession } = initial;
      if (status === 404 && sentSession) {
        await this.reinitialize();
        ({ status, body } = await this.postWithRetry({
          jsonrpc: '2.0',
          id: this.nextId++,
          method: 'tools/call',
          params: { name, arguments: args },
        }));
      }
      const unusable = (detail: string): JcCallOutcome => outcome('execution_unknown', {
        code: 'execution_unknown',
        message: `tools/call may have executed: the edge answered HTTP 200 with ${detail}. Verify its effects before re-running it.`,
        retryable: false,
      });
      if (status === 200 && !body) return unusable('an unparseable body');
      if (status !== 200 || !body) throw this.refusal(status, body, 'tools/call');
      if ('error' in body) {
        const rpcError = body.error;
        if (typeof rpcError === 'string' && rpcError.startsWith('managed_authorization_')) throw this.refusal(status, body, 'tools/call');
        if (!rpcError || typeof rpcError !== 'object') return unusable('a malformed JSON-RPC error');
        return classifyJsonRpcError(rpcError as Record<string, unknown>);
      }
      const result = body.result;
      if (!result || typeof result !== 'object' || Array.isArray(result)) return unusable('no tool result');
      return classifyToolResult(result as Record<string, unknown>);
    } catch (error) {
      if (error instanceof McpTransportError) return error.outcome;
      throw error;
    }
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    const auth = await this.auth.getAuthHeaders({ method: 'DELETE', url: this.options.url }).catch(() => undefined);
    await this.fetchImpl(this.options.url, {
      method: 'DELETE',
      headers: {
        'mcp-session-id': this.sessionId,
        ...(auth && auth.ok ? auth.headers : {}),
      },
    }).catch(() => undefined);
    this.sessionId = undefined;
  }
}
