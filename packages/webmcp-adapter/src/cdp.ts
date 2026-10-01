import {
  WebMcpError,
  WebMcpErrorCode,
  pageIdentitySchema,
  type PageIdentity,
  type RawToolRecord
} from "./contracts.js";
import { assertJsonValue, type JsonValue } from "./json.js";

/**
 * CDP driver for the live Chrome WebMCP contract.
 *
 * Hard rules enforced here:
 *   - **Only fixed `Runtime.callFunctionOn` declarations.** No `Runtime.evaluate`,
 *     no page-supplied or caller-supplied expressions, ever. The execution
 *     context is resolved from `Runtime.executionContextCreated` events
 *     (`auxData.isDefault`) rather than by evaluating `document` in the page.
 *   - **JSON values only.** Everything crossing the boundary is proven to be a
 *     JSON value before it is hashed or returned.
 *   - **Loopback only.** The attached session must be a loopback CDP endpoint.
 */

export interface CdpSession {
  send(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  /** Subscribe to CDP events; returns an unsubscribe function. */
  subscribe(event: string, handler: (params: unknown) => void): () => void;
}

export interface WebMcpPageSnapshot {
  readonly identity: PageIdentity;
  readonly supported: boolean;
  readonly tools: readonly RawToolRecord[];
}

export interface WebMcpPage {
  identity(signal?: AbortSignal): Promise<PageIdentity>;
  snapshot(signal?: AbortSignal): Promise<WebMcpPageSnapshot>;
  execute(toolName: string, argsJson: string, signal?: AbortSignal): Promise<string>;
}

export interface CdpWebMcpPageOptions {
  sessionId: string;
  pageId: string;
  /** Milliseconds to wait for the default execution context after `Runtime.enable`. */
  contextTimeoutMs?: number;
}

/** Fixed declaration: discovery. Contains no caller or page input. */
const DISCOVER_DECLARATION = `function () {
  var m = this.document.modelContext;
  if (!m) return { supported: false, tools: [] };
  return Promise.resolve(m.getTools()).then(function (tools) {
    return {
      supported: true,
      tools: tools.map(function (tool) {
        return {
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations === undefined ? null : tool.annotations
        };
      })
    };
  });
}`;

/** Fixed declaration: execution. Arguments arrive as JSON values, never as code. */
const EXECUTE_DECLARATION = `function (toolName, argsJson) {
  var m = this.document.modelContext;
  if (!m) throw new Error("webmcp_unsupported");
  return Promise.resolve(m.getTools()).then(function (tools) {
    var matches = tools.filter(function (tool) { return tool.name === toolName; });
    if (matches.length !== 1) throw new Error("webmcp_registration_changed");
    return m.executeTool(matches[0], argsJson);
  });
}`;

/** CDP is only ever attached to the executor's own loopback debugging port. */
export function assertLoopbackEndpoint(websocketUrl: string): string {
  let url: URL;
  try {
    url = new URL(websocketUrl);
  } catch {
    throw new WebMcpError(WebMcpErrorCode.CdpFailure, "CDP endpoint is not a valid URL");
  }
  if (url.protocol !== "ws:") {
    throw new WebMcpError(WebMcpErrorCode.CdpFailure, "CDP endpoint must use ws:");
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") {
    throw new WebMcpError(WebMcpErrorCode.CdpFailure, "CDP endpoint must be loopback");
  }
  if (url.username || url.password) {
    throw new WebMcpError(WebMcpErrorCode.CdpFailure, "CDP endpoint must not carry credentials");
  }
  return websocketUrl;
}

interface ContextRecord {
  id: number;
  isDefault: boolean;
  destroyed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cdpError(value: unknown): WebMcpError {
  if (!isRecord(value)) return new WebMcpError(WebMcpErrorCode.CdpFailure, "CDP returned a malformed response");
  const message = typeof value.message === "string" ? value.message : "CDP request failed";
  if (/webmcp_unsupported/u.test(message)) {
    return new WebMcpError(WebMcpErrorCode.Unsupported, "page does not expose document.modelContext");
  }
  if (/webmcp_registration_changed/u.test(message)) {
    return new WebMcpError(WebMcpErrorCode.ToolChanged, "tool registration changed before execution");
  }
  return new WebMcpError(WebMcpErrorCode.CdpFailure, message);
}

function readResultValue(response: unknown, context: "discover" | "execute"): JsonValue {
  if (!isRecord(response)) throw new WebMcpError(WebMcpErrorCode.CdpFailure, "CDP response was not an object");
  if (response.error) throw cdpError(response.error);
  const result = response.result;
  if (!isRecord(result)) throw new WebMcpError(WebMcpErrorCode.CdpFailure, "CDP result was not an object");
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const text = isRecord(details) && typeof details.text === "string" ? details.text : "page threw during evaluation";
    if (/webmcp_unsupported/u.test(text)) throw cdpError({ message: text });
    if (/webmcp_registration_changed/u.test(text)) throw cdpError({ message: text });
    // The page's own tool body threw: a tool failure, not a transport failure.
    throw new WebMcpError(
      context === "execute" ? WebMcpErrorCode.ToolFailed : WebMcpErrorCode.DiscoveryInvalid,
      text
    );
  }
  const inner = result.result;
  if (!isRecord(inner)) throw new WebMcpError(WebMcpErrorCode.CdpFailure, "CDP result payload was not an object");
  if (inner.value === undefined) {
    throw new WebMcpError(WebMcpErrorCode.ResultInvalid, "CDP did not return a by-value result");
  }
  return assertJsonValue(inner.value, "CDP result");
}

export function createCdpWebMcpPage(session: CdpSession, options: CdpWebMcpPageOptions): WebMcpPage {
  const contexts = new Map<number, ContextRecord>();
  const contextWaiters: (() => void)[] = [];
  let enabled = false;

  const notify = (): void => {
    while (contextWaiters.length > 0) contextWaiters.shift()?.();
  };
  session.subscribe("Runtime.executionContextCreated", (params) => {
    if (!isRecord(params) || !isRecord(params.context)) return;
    const context = params.context;
    if (typeof context.id !== "number") return;
    const auxData = isRecord(context.auxData) ? context.auxData : undefined;
    contexts.set(context.id, {
      id: context.id,
      isDefault: auxData?.isDefault === true,
      destroyed: false
    });
    notify();
  });
  session.subscribe("Runtime.executionContextDestroyed", (params) => {
    if (!isRecord(params) || typeof params.executionContextId !== "number") return;
    const record = contexts.get(params.executionContextId);
    if (record) record.destroyed = true;
    notify();
  });
  session.subscribe("Runtime.executionContextsCleared", () => {
    for (const record of contexts.values()) record.destroyed = true;
    notify();
  });

  async function ensureEnabled(signal?: AbortSignal): Promise<void> {
    if (enabled) return;
    await session.send("Runtime.enable", {}, signal);
    await session.send("Page.enable", {}, signal);
    enabled = true;
  }

  async function defaultContextId(signal?: AbortSignal): Promise<number> {
    await ensureEnabled(signal);
    const deadline = Date.now() + (options.contextTimeoutMs ?? 5_000);
    for (;;) {
      if (signal?.aborted) throw new WebMcpError(WebMcpErrorCode.Cancelled, "call was cancelled");
      const live = [...contexts.values()].filter((record) => record.isDefault && !record.destroyed);
      const newest = live.at(-1);
      if (newest) return newest.id;
      if (Date.now() >= deadline) {
        throw new WebMcpError(WebMcpErrorCode.CdpFailure, "no default execution context became available");
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100);
        contextWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  async function callFixed(
    declaration: string,
    args: readonly JsonValue[],
    context: "discover" | "execute",
    signal?: AbortSignal
  ): Promise<JsonValue> {
    const executionContextId = await defaultContextId(signal);
    const response = await session.send(
      "Runtime.callFunctionOn",
      {
        executionContextId,
        functionDeclaration: declaration,
        awaitPromise: true,
        returnByValue: true,
        arguments: args.map((value) => ({ value }))
      },
      signal
    );
    return readResultValue(response, context);
  }

  async function frameIdentity(signal?: AbortSignal): Promise<PageIdentity> {
    const response = await session.send("Page.getFrameTree", {}, signal);
    if (!isRecord(response)) throw new WebMcpError(WebMcpErrorCode.CdpFailure, "CDP response was not an object");
    if (response.error) throw cdpError(response.error);
    const result = response.result;
    if (!isRecord(result) || !isRecord(result.frameTree) || !isRecord(result.frameTree.frame)) {
      throw new WebMcpError(WebMcpErrorCode.CdpFailure, "CDP did not return a frame tree");
    }
    const frame = result.frameTree.frame;
    if (typeof frame.url !== "string" || typeof frame.loaderId !== "string") {
      throw new WebMcpError(WebMcpErrorCode.CdpFailure, "CDP frame is missing url or loaderId");
    }
    let origin: string;
    try {
      origin = new URL(frame.url).origin;
    } catch {
      throw new WebMcpError(WebMcpErrorCode.OriginUntrusted, "frame URL is not a valid URL");
    }
    const parsed = pageIdentitySchema.safeParse({
      sessionId: options.sessionId,
      pageId: options.pageId,
      origin,
      pageUrl: frame.url,
      navigationId: frame.loaderId
    });
    if (!parsed.success) {
      throw new WebMcpError(WebMcpErrorCode.DiscoveryInvalid, "frame identity failed canonical validation");
    }
    return parsed.data;
  }

  return {
    async identity(signal) {
      return frameIdentity(signal);
    },
    async snapshot(signal) {
      const before = await frameIdentity(signal);
      const value = await callFixed(DISCOVER_DECLARATION, [], "discover", signal);
      if (!isRecord(value) || typeof value.supported !== "boolean" || !Array.isArray(value.tools)) {
        throw new WebMcpError(WebMcpErrorCode.DiscoveryInvalid, "getTools() returned an unexpected shape");
      }
      // Re-read the frame after discovery: a navigation during getTools() must
      // invalidate the snapshot rather than yield tools from a previous document.
      const after = await frameIdentity(signal);
      if (after.navigationId !== before.navigationId || after.pageUrl !== before.pageUrl) {
        throw new WebMcpError(WebMcpErrorCode.NavigationChanged, "page navigated during discovery");
      }
      return { identity: after, supported: value.supported, tools: value.tools as unknown as readonly RawToolRecord[] };
    },
    async execute(toolName, argsJson, signal) {
      const value = await callFixed(EXECUTE_DECLARATION, [toolName, argsJson], "execute", signal);
      if (typeof value !== "string") {
        throw new WebMcpError(WebMcpErrorCode.ResultInvalid, "executeTool did not return a JSON string");
      }
      return value;
    }
  };
}
