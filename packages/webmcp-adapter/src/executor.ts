import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import {
  WebMcpError,
  WebMcpErrorCode,
  discoveryRecordSchema,
  type DiscoveryRecord,
  type PageIdentity
} from "./contracts.js";
import { assertJsonValue, type JsonValue } from "./json.js";
import {
  assertPageIdentity,
  deriveDiscoveryId,
  invocationFingerprint,
  normalizeRawTool,
  validateArguments
} from "./normalize.js";
import { resolveEffectivePolicy, type WebMcpPolicyTable } from "./policy.js";
import { requireLiveWebMcpGate, type WebMcpExecutionGate } from "./gate.js";
import { createCdpWebMcpPage, type CdpSession, type WebMcpPage } from "./cdp.js";
import type { ChromeRuntime } from "./chrome-runtime.js";
import {
  isWebMcpExecutionAuthorization,
  webmcpExecutionKey,
  type WebMcpExecutionAuthorization
} from "./execution-authorization.js";
import {
  WebMcpAuditEvent,
  approvalRequiredEvent,
  authorizationGrantedEvent,
  discoveryListedEvent,
  executionCompletedEvent,
  executionStartedEvent,
  replayRejectedEvent,
  staleBindingRejectedEvent,
  toolCalledEvent,
  toolOutcomeEvent,
  type WebMcpAuditEventDraft
} from "./audit.js";

/**
 * The only WebMCP execution surface.
 *
 * `execute` accepts a branded `WebMcpExecutionAuthorization` and nothing else:
 * there is no `execute(toolName, args)` shortcut, and no caller-supplied
 * authority callback. Every step re-reads live browser state and fails closed
 * on any session/page/origin/navigation/tool/schema/argument drift.
 */

export interface WebMcpDiscoveryResult {
  readonly supported: boolean;
  readonly sessionId: string;
  readonly pageId: string;
  readonly origin: string;
  readonly pageUrl: string;
  readonly navigationId: string;
  readonly tools: readonly DiscoveryRecord[];
  /** Tools the page exposed that ACS policy does not declare. Never invocable. */
  readonly undeclaredToolCount: number;
}

export interface WebMcpExecutionResult {
  readonly ok: true;
  readonly toolName: string;
  readonly discoveryId: string;
  readonly invocationFingerprint: string;
  readonly risk: "read_only" | "reversible_mutation";
  readonly result: JsonValue;
  readonly resultHash: string;
  readonly durationMs: number;
}

/**
 * Replay guard. `reserve` is permanent: an attempt that reached the browser
 * boundary can never be re-executed, even if it failed part-way. A retry of the
 * same work item is therefore rejected rather than double-applied.
 */
export interface WebMcpReplayGuard {
  reserve(key: string): Promise<boolean>;
}

export function createInMemoryWebMcpReplayGuard(limit = 10_000): WebMcpReplayGuard {
  const seen = new Set<string>();
  const order: string[] = [];
  return {
    async reserve(key: string): Promise<boolean> {
      if (seen.has(key)) return false;
      seen.add(key);
      order.push(key);
      while (order.length > limit) {
        const oldest = order.shift();
        if (oldest !== undefined) seen.delete(oldest);
      }
      return true;
    }
  };
}

export interface WebMcpExecutorOptions {
  runtime: Pick<ChromeRuntime, "connect" | "close">;
  policy: WebMcpPolicyTable;
  gate: WebMcpExecutionGate;
  replayGuard?: WebMcpReplayGuard;
  audit?: (event: WebMcpAuditEventDraft) => void;
  now?: () => Date;
  connectTimeoutMs?: number;
}

export interface WebMcpExecutor {
  discover(): Promise<WebMcpDiscoveryResult>;
  execute(request: { authorization: unknown; signal?: AbortSignal }): Promise<WebMcpExecutionResult>;
  close(): Promise<void>;
}

const IDENTITY_DIMENSIONS = [
  ["sessionId", WebMcpErrorCode.SessionChanged, "session"],
  ["pageId", WebMcpErrorCode.PageChanged, "page"],
  ["origin", WebMcpErrorCode.OriginChanged, "origin"],
  ["navigationId", WebMcpErrorCode.NavigationChanged, "navigation"]
] as const;

export function createWebMcpExecutor(options: WebMcpExecutorOptions): WebMcpExecutor {
  const replayGuard = options.replayGuard ?? createInMemoryWebMcpReplayGuard();
  const now = options.now ?? (() => new Date());
  const emit = (event: WebMcpAuditEventDraft): void => options.audit?.(event);

  async function withPage<T>(
    signal: AbortSignal | undefined,
    fn: (page: WebMcpPage, session: CdpSession) => Promise<T>
  ): Promise<T> {
    requireLiveWebMcpGate(options.gate);
    if (signal?.aborted) throw new WebMcpError(WebMcpErrorCode.Cancelled, "call was cancelled");
    const session = await options.runtime.connect();
    const page = createCdpWebMcpPage(session, {
      sessionId: sessionIdFor(session.url),
      pageId: "page-0",
      contextTimeoutMs: options.connectTimeoutMs ?? 5_000
    });
    try {
      return await fn(page, session);
    } finally {
      session.close();
    }
  }

  async function snapshotTools(
    page: WebMcpPage,
    signal?: AbortSignal
  ): Promise<{ identity: PageIdentity; tools: DiscoveryRecord[]; undeclared: number }> {
    const snapshot = await page.snapshot(signal);
    if (!snapshot.supported) {
      throw new WebMcpError(WebMcpErrorCode.Unsupported, "page does not expose document.modelContext");
    }
    const identity = assertPageIdentity(snapshot.identity);
    const tools: DiscoveryRecord[] = [];
    const seen = new Set<string>();
    let undeclared = 0;
    for (const raw of snapshot.tools) {
      if (typeof raw.name === "string" && seen.has(raw.name)) {
        throw new WebMcpError(WebMcpErrorCode.RegistrationInvalid, `duplicate tool registration: ${raw.name}`);
      }
      const tool = normalizeRawTool(raw, identity.origin);
      seen.add(tool.name);
      if (!options.policy.resolve(identity.origin, tool.name)) {
        // Deny by default: undeclared tools are visible only as a count.
        undeclared += 1;
        continue;
      }
      tools.push(
        discoveryRecordSchema.parse({
          discoveryId: deriveDiscoveryId(identity, tool),
          sessionId: identity.sessionId,
          pageId: identity.pageId,
          origin: identity.origin,
          pageUrl: identity.pageUrl,
          navigationId: identity.navigationId,
          tool,
          discoveredAt: now().toISOString()
        })
      );
    }
    return { identity, tools, undeclared };
  }

  return {
    async discover(): Promise<WebMcpDiscoveryResult> {
      return withPage(undefined, async (page) => {
        const { identity, tools, undeclared } = await snapshotTools(page);
        emit(
          discoveryListedEvent({
            sessionId: identity.sessionId,
            pageId: identity.pageId,
            origin: identity.origin,
            navigationId: identity.navigationId,
            toolCount: tools.length,
            actor: "acs:webmcp"
          })
        );
        return {
          supported: true,
          sessionId: identity.sessionId,
          pageId: identity.pageId,
          origin: identity.origin,
          pageUrl: identity.pageUrl,
          navigationId: identity.navigationId,
          tools,
          undeclaredToolCount: undeclared
        };
      });
    },

    async execute(request): Promise<WebMcpExecutionResult> {
      if (!isWebMcpExecutionAuthorization(request.authorization)) {
        throw new ControlStackError(
          "webmcp_authorization_required",
          "execute accepts only an ACS-issued WebMcpExecutionAuthorization"
        );
      }
      const auth = request.authorization;

      // Fail closed before any browser work: one execution per (work item,
      // attempt, exact invocation), permanently.
      const executionKey = webmcpExecutionKey(auth);
      if (!(await replayGuard.reserve(executionKey))) {
        emit(replayRejectedEvent(auth, executionKey));
        throw new WebMcpError(WebMcpErrorCode.ReplayRejected, "this invocation has already been executed");
      }

      const startedAt = Date.now();
      emit(executionStartedEvent(auth));
      emit(toolCalledEvent(auth));

      let result: JsonValue;
      try {
        result = await withPage(request.signal, async (page) => {
          const { identity, tools } = await snapshotTools(page, request.signal);
          assertStillBound(auth, identity, emit);

          const live = tools.find((record) => record.tool.name === auth.toolName);
          if (!live) {
            rejectStale(auth, WebMcpErrorCode.ToolNotFound, "tool", "tool is no longer registered", emit);
          }
          // Schema drift is reported before registration drift so a changed
          // contract is named precisely rather than as a generic change.
          if (live.tool.schemaHash !== auth.schemaHash) {
            rejectStale(auth, WebMcpErrorCode.SchemaChanged, "schema", "tool schema changed", emit);
          }
          if (live.tool.registrationHash !== auth.registrationHash) {
            rejectStale(auth, WebMcpErrorCode.ToolChanged, "tool", "tool registration changed", emit);
          }
          if (live.discoveryId !== auth.discoveryId) {
            rejectStale(auth, WebMcpErrorCode.StaleDiscovery, "tool", "discovery record is stale", emit);
          }

          // Re-derive the policy decision and the exact invocation from live
          // state; anything that drifted is refused rather than reconciled.
          const effective = resolveEffectivePolicy(options.policy, {
            origin: identity.origin,
            toolName: live.tool.name,
            annotations: live.tool.annotations
          });
          if (effective.requiresApproval && auth.approvalId === undefined) {
            emit(approvalRequiredEvent(auth));
            throw new WebMcpError(WebMcpErrorCode.ApprovalRequired, "ACS approval is required for this tool");
          }
          const revalidated = validateArguments({ ...auth.normalizedArguments }, live.tool.inputSchema) as Record<
            string,
            JsonValue
          >;
          const fingerprint = invocationFingerprint({
            identity,
            toolName: live.tool.name,
            registrationHash: live.tool.registrationHash,
            schemaHash: live.tool.schemaHash,
            arguments: revalidated
          });
          if (fingerprint !== auth.invocationFingerprint) {
            rejectStale(auth, WebMcpErrorCode.ArgumentsChanged, "arguments", "arguments changed", emit);
          }
          emit(authorizationGrantedEvent(auth));

          const raw = await page.execute(live.tool.name, JSON.stringify(revalidated), request.signal);
          const after = assertPageIdentity(await page.identity(request.signal));
          assertStillBound(auth, after, emit);

          const parsed = parseToolResult(raw);
          return parsed;
        });
      } catch (error) {
        const code = error instanceof WebMcpError ? error.code : "webmcp_execution_failed";
        emit(
          toolOutcomeEvent(auth, {
            ok: false,
            durationMs: Date.now() - startedAt,
            resultHash: stableHash({ error: code }),
            outcome: error instanceof WebMcpError && error.code === WebMcpErrorCode.Cancelled ? "aborted" : "failed",
            errorCode: code
          })
        );
        throw error;
      }

      const resultHash = stableHash(result);
      emit(toolOutcomeEvent(auth, { ok: true, durationMs: Date.now() - startedAt, resultHash, outcome: "succeeded" }));
      emit(executionCompletedEvent(auth, { ok: true, resultHash }));
      return {
        ok: true,
        toolName: auth.toolName,
        discoveryId: auth.discoveryId,
        invocationFingerprint: auth.invocationFingerprint,
        risk: auth.risk,
        result,
        resultHash,
        durationMs: Date.now() - startedAt
      };
    },

    async close(): Promise<void> {
      await options.runtime.close();
    }
  };
}

function rejectStale(
  auth: WebMcpExecutionAuthorization,
  code: WebMcpErrorCode,
  dimension: "session" | "page" | "origin" | "navigation" | "tool" | "schema" | "arguments",
  message: string,
  emit: (event: WebMcpAuditEventDraft) => void
): never {
  emit(staleBindingRejectedEvent({ auth, code, dimension }));
  throw new WebMcpError(code, message);
}

function assertStillBound(
  auth: WebMcpExecutionAuthorization,
  identity: PageIdentity,
  emit: (event: WebMcpAuditEventDraft) => void
): void {
  for (const [field, code, dimension] of IDENTITY_DIMENSIONS) {
    if (identity[field] !== auth[field]) {
      rejectStale(auth, code, dimension, `${dimension} changed since the work item was approved`, emit);
    }
  }
  if (identity.pageUrl !== auth.pageUrl) {
    rejectStale(auth, WebMcpErrorCode.NavigationChanged, "navigation", "page URL changed", emit);
  }
}

/** `executeTool` returns a JSON string; anything else is a fail-closed error. */
export function parseToolResult(raw: string): JsonValue {
  if (raw.length === 0) {
    throw new WebMcpError(WebMcpErrorCode.ResultInvalid, "tool returned an empty result");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new WebMcpError(WebMcpErrorCode.ResultInvalid, "tool result is not valid JSON");
  }
  return assertJsonValue(parsed, "tool result");
}

/**
 * Session identity is derived from the loopback endpoint the browser is bound
 * to, so two connections to the same isolated Chrome share one session id and a
 * restarted browser yields a new one.
 */
export function sessionIdFor(websocketUrl: string): string {
  const digest = stableHash({ domain: "acs:webmcp-session:v1", websocketUrl });
  return `wms-${digest.slice(0, 32)}`;
}

export { WebMcpAuditEvent };
