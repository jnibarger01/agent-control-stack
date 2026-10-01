import { expect } from "vitest";
import {
  discoveryRecordSchema,
  type DiscoveryRecord
} from "./contracts.js";
import { assertPageIdentity, deriveDiscoveryId, invocationFingerprint, normalizeRawTool, validateArguments } from "./normalize.js";
import { defineWebMcpPolicy } from "./policy.js";
import {
  authorizeWebMcpExecution,
  webmcpActionBinding,
  type AuthorizeWebMcpExecutionInput,
  type WebMcpExecutionAuthorization
} from "./execution-authorization.js";
import { executionActionHash, type AttemptLease, type ClaimedWorkItem } from "@agent-control-stack/work-items";
import type { CdpSession } from "./cdp.js";
import type { JsonValue } from "./json.js";
import { sessionIdFor } from "./executor.js";

/**
 * Assert that a thunk throws an ACS error carrying an exact stable code.
 *
 * Codes — not messages — are the cross-boundary contract, so tests assert on
 * `error.code` rather than on prose.
 */
export function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected a throw with code ${code}`);
}

/**
 * Test support: an in-process fake of the live Chrome CDP surface.
 *
 * It emulates exactly the protocol shape the adapter depends on — the
 * `Runtime.executionContextCreated` default-context event, `Page.getFrameTree`
 * identity, and `Runtime.callFunctionOn` returning a by-value JSON result — so
 * unit tests exercise the real CDP driver rather than a stubbed page.
 */

export interface FakePageState {
  supported: boolean;
  url: string;
  loaderId: string;
  tools: unknown[];
  /** The page's own tool body. Return a JSON string (the live contract) or throw. */
  onExecute?: (name: string, argsJson: string) => unknown;
  /** Withhold the default execution context to exercise the context timeout. */
  withholdContext?: boolean;
  /** Force a CDP protocol-level error for a method. */
  protocolError?: (method: string) => { code: number; message: string } | undefined;
}

export interface FakeCdpHarness {
  session: CdpSession;
  state: FakePageState;
  /** Every executed tool call, in order: the page-side effect ledger. */
  executed: { name: string; argsJson: string }[];
  methods: string[];
  setState(patch: Partial<FakePageState>): void;
  /** Simulate a cross-document navigation: new loaderId and destroyed contexts. */
  navigate(url: string, loaderId: string): void;
  closed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createFakeCdpSession(initial: FakePageState): FakeCdpHarness {
  const state: FakePageState = { ...initial };
  const listeners = new Map<string, Set<(params: unknown) => void>>();
  const executed: { name: string; argsJson: string }[] = [];
  const methods: string[] = [];
  const harness = {
    state,
    executed,
    methods,
    closed: false,
    setState(patch: Partial<FakePageState>) {
      Object.assign(state, patch);
    },
    navigate(url: string, loaderId: string) {
      state.url = url;
      state.loaderId = loaderId;
      for (const handler of listeners.get("Runtime.executionContextsCleared") ?? []) handler({});
      contextCounter += 1;
      for (const handler of listeners.get("Runtime.executionContextCreated") ?? []) {
        handler({ context: { id: contextCounter, auxData: { isDefault: true } } });
      }
    }
  } as FakeCdpHarness;

  let contextCounter = 0;
  const emit = (event: string, params: unknown): void => {
    for (const handler of listeners.get(event) ?? []) handler(params);
  };

  harness.session = {
    async send(method, params) {
      methods.push(method);
      const forced = state.protocolError?.(method);
      if (forced) return { id: 0, error: forced };
      switch (method) {
        case "Runtime.enable":
          if (!state.withholdContext) {
            contextCounter += 1;
            const id = contextCounter;
            queueMicrotask(() => emit("Runtime.executionContextCreated", { context: { id, auxData: { isDefault: true } } }));
          }
          return { id: 0, result: {} };
        case "Page.enable":
          return { id: 0, result: {} };
        case "Page.getFrameTree":
          return { id: 0, result: { frameTree: { frame: { url: state.url, loaderId: state.loaderId } } } };
        case "Runtime.callFunctionOn": {
          const record = isRecord(params) ? params : {};
          const declaration = typeof record.functionDeclaration === "string" ? record.functionDeclaration : "";
          const args = Array.isArray(record.arguments)
            ? record.arguments.map((entry) => (isRecord(entry) ? entry.value : undefined))
            : [];
          if (declaration.includes("executeTool")) {
            const name = String(args[0] ?? "");
            const argsJson = String(args[1] ?? "");
            executed.push({ name, argsJson });
            try {
              const value = state.onExecute ? state.onExecute(name, argsJson) : undefined;
              return { id: 0, result: { result: { type: "string", value } } };
            } catch (error) {
              const text = error instanceof Error ? error.message : String(error);
              return { id: 0, result: { exceptionDetails: { text } } };
            }
          }
          return {
            id: 0,
            result: {
              result: {
                type: "object",
                value: { supported: state.supported, tools: state.tools }
              }
            }
          };
        }
        default:
          return { id: 0, result: {} };
      }
    },
    subscribe(event, handler) {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      listeners.set(event, set);
      return () => {
        set.delete(handler);
      };
    }
  };

  return harness;
}

/** Ready-to-use raw tool records matching the live `getTools()` shape. */
export const webmcpTestOrigin = "http://127.0.0.1:8799";

export const webmcpTestUrl = `${webmcpTestOrigin}/`;

/** The loopback CDP endpoint the fake/real executor session is bound to. */
export const webmcpTestCdpUrl = "ws://127.0.0.1:9333/devtools/page/TESTPAGE0000000";

/** Session identity the executor derives from that endpoint. */
export const webmcpTestSessionId = sessionIdFor(webmcpTestCdpUrl);

export function rawTool(input: {
  name: string;
  schema?: Record<string, unknown> | string;
  annotations?: unknown;
  title?: string;
  description?: string;
}): Record<string, unknown> {
  const schema =
    input.schema ??
    ({
      type: "object",
      properties: { day: { type: "string", enum: ["mon", "tue"] } },
      required: ["day"],
      additionalProperties: false
    } satisfies Record<string, unknown>);
  return {
    name: input.name,
    title: input.title ?? input.name,
    description: input.description ?? `${input.name} description`,
    origin: webmcpTestOrigin,
    window: {},
    inputSchema: typeof schema === "string" ? schema : JSON.stringify(schema),
    annotations: input.annotations === undefined ? null : input.annotations
  };
}

/** Build a canonical discovery record from a raw tool record. */
export function makeDiscovery(input: {
  tool: Record<string, unknown>;
  sessionId?: string;
  pageId?: string;
  origin?: string;
  pageUrl?: string;
  navigationId?: string;
  discoveredAt?: string;
}): DiscoveryRecord {
  const identity = {
    sessionId: input.sessionId ?? webmcpTestSessionId,
    pageId: input.pageId ?? "page-0",
    origin: input.origin ?? webmcpTestOrigin,
    pageUrl: input.pageUrl ?? webmcpTestUrl,
    navigationId: input.navigationId ?? "LOADER0000000000000000000000000"
  };
  const parsed = assertPageIdentity(identity);
  const tool = normalizeRawTool(input.tool as never, parsed.origin);
  return discoveryRecordSchema.parse({
    discoveryId: deriveDiscoveryId(parsed, tool),
    sessionId: parsed.sessionId,
    pageId: parsed.pageId,
    origin: parsed.origin,
    pageUrl: parsed.pageUrl,
    navigationId: parsed.navigationId,
    tool,
    discoveredAt: input.discoveredAt ?? "2026-01-01T00:00:00.000Z"
  });
}

/** Deterministic 64-hex digest for fixtures that only need a shape-valid hash. */
export function fakeHash(seed: string): string {
  return seed.repeat(64).slice(0, 64).replace(/[^a-f0-9]/gu, "a");
}

export const webmcpReadAnnotations = {
  readOnlyHint: true,
  consequentialHint: false,
  untrustedContentHint: false
};

export const webmcpTestPolicy = defineWebMcpPolicy([
  { origin: webmcpTestOrigin, toolName: "get_showroom_hours", risk: "read_only" },
  { origin: webmcpTestOrigin, toolName: "set_preferred_contact", risk: "reversible_mutation" }
]);

export const webmcpReadDiscovery = makeDiscovery({
  tool: rawTool({ name: "get_showroom_hours", annotations: webmcpReadAnnotations })
});

export const webmcpMutationDiscovery = makeDiscovery({
  tool: rawTool({
    name: "set_preferred_contact",
    schema: {
      type: "object",
      properties: { method: { type: "string", enum: ["phone", "email"] } },
      required: ["method"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, consequentialHint: true, untrustedContentHint: false }
  })
});

export interface WebMcpCallFixture {
  discovery: DiscoveryRecord;
  args: Record<string, unknown>;
  claimed: ClaimedWorkItem;
  trustedWorkItem: AuthorizeWebMcpExecutionInput["trustedWorkItem"];
  lease: AttemptLease;
  authorize(): WebMcpExecutionAuthorization;
}

export interface WebMcpCallFixtureOptions {
  discovery?: DiscoveryRecord;
  args?: Record<string, unknown>;
  /** Arguments the work item was approved for, when they differ from `args`. */
  bindingArgs?: Record<string, unknown>;
  status?: string;
  approvalId?: string;
  leaseOverrides?: Record<string, unknown>;
  claimedOverrides?: Record<string, unknown>;
  actionCount?: number;
  bindingDiscovery?: DiscoveryRecord;
  requestId?: string;
}

/**
 * Build one exact, authorizable WebMCP call: work item binding, claim, lease,
 * and the ACS-issued authorization object.
 */
export function makeWebMcpCallFixture(options: WebMcpCallFixtureOptions = {}): WebMcpCallFixture {
  const discovery = options.discovery ?? webmcpReadDiscovery;
  const args = options.args ?? { day: "mon" };
  const boundArguments = validateArguments(options.bindingArgs ?? args, discovery.tool.inputSchema) as Record<
    string,
    JsonValue
  >;
  const fingerprint = invocationFingerprint({
    identity: {
      sessionId: discovery.sessionId,
      pageId: discovery.pageId,
      origin: discovery.origin,
      pageUrl: discovery.pageUrl,
      navigationId: discovery.navigationId
    },
    toolName: discovery.tool.name,
    registrationHash: discovery.tool.registrationHash,
    schemaHash: discovery.tool.schemaHash,
    arguments: boundArguments
  });
  const bindingDiscovery = options.bindingDiscovery ?? discovery;
  const actions = Array.from({ length: options.actionCount ?? 1 }, () => ({
    kind: "webmcp.call_tool",
    description: "governed WebMCP call",
    params: webmcpActionBinding(bindingDiscovery, fingerprint, boundArguments)
  }));
  const trustedWorkItem = {
    id: "wi-webmcp-1",
    status: options.status ?? "running",
    requester: "agent",
    intent: "call a page tool",
    target: discovery.origin,
    requestedActions: actions,
    risk: "low"
  } as unknown as AuthorizeWebMcpExecutionInput["trustedWorkItem"];
  const planHash = fakeHash("b");
  const claimed = {
    ...trustedWorkItem,
    workItemId: trustedWorkItem.id,
    workerId: "worker-1",
    attemptId: "att-1",
    leaseId: "lease-1",
    planHash,
    inputHash: fakeHash("c"),
    fencingEpoch: 1,
    actionHash: executionActionHash(trustedWorkItem),
    ...options.claimedOverrides
  } as unknown as ClaimedWorkItem;
  const lease = {
    leaseId: "lease-1",
    attemptId: "att-1",
    workItemId: trustedWorkItem.id,
    admissionId: "adm-1",
    approvalId: options.approvalId,
    workerId: "worker-1",
    tokenHash: fakeHash("d"),
    planHash,
    inputHash: fakeHash("c"),
    fencingEpoch: 1,
    protocolVersion: "acs-worker.v1",
    policyVersion: "policy-2026-01",
    policyDecisionHash: fakeHash("e"),
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    maxExpiresAt: "2099-01-02T00:00:00.000Z",
    lastRenewedAt: "2026-01-01T00:00:00.000Z",
    status: "active",
    ...options.leaseOverrides
  } as unknown as AttemptLease;
  return {
    discovery,
    args,
    claimed,
    trustedWorkItem,
    lease,
    authorize: () =>
      authorizeWebMcpExecution({
        claimed,
        trustedWorkItem,
        lease,
        workerId: "worker-1",
        requestId: options.requestId ?? "req-1",
        discovery,
        arguments: args,
        policy: webmcpTestPolicy,
        now: new Date("2026-01-01T00:00:00.000Z")
      })
  };
}
