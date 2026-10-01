import { describe, expect, it } from "vitest";
import {
  createWebMcpExecutor,
  parseToolResult,
  type WebMcpExecutor
} from "./executor.js";
import { WebMcpErrorCode } from "./contracts.js";
import { resolveWebMcpExecutionGate } from "./gate.js";
import type { WebMcpAuditEventDraft } from "./audit.js";
import type { CdpConnection } from "./cdp-client.js";
import {
  createFakeCdpSession,
  expectCode,
  makeWebMcpCallFixture,
  rawTool,
  webmcpMutationDiscovery,
  webmcpReadAnnotations,
  webmcpReadDiscovery,
  webmcpTestCdpUrl,
  webmcpTestPolicy,
  webmcpTestUrl,
  type FakePageState
} from "./test-support.js";

const openGate = resolveWebMcpExecutionGate({ ACS_WEBMCP_LIVE: "1", ACS_WEBMCP_LIVE_EXECUTION_GATE: "cleared" });
const LOADER_A = "LOADER0000000000000000000000000";
const LOADER_B = "LOADERB000000000000000000000000";

const mutationSchema = {
  type: "object",
  properties: { method: { type: "string", enum: ["phone", "email"] } },
  required: ["method"],
  additionalProperties: false
};

const readTool = (): Record<string, unknown> => rawTool({ name: "get_showroom_hours", annotations: webmcpReadAnnotations });
const mutationTool = (): Record<string, unknown> =>
  rawTool({
    name: "set_preferred_contact",
    schema: mutationSchema,
    annotations: { readOnlyHint: false, consequentialHint: true, untrustedContentHint: false }
  });

function harness(overrides: Partial<FakePageState> = {}) {
  const cdp = createFakeCdpSession({
    supported: true,
    url: webmcpTestUrl,
    loaderId: LOADER_A,
    tools: [readTool(), mutationTool()],
    onExecute: (name, argsJson) => JSON.stringify({ ok: true, tool: name, echo: JSON.parse(argsJson) as unknown }),
    ...overrides
  });
  const events: WebMcpAuditEventDraft[] = [];
  const connection: CdpConnection = {
    ...cdp.session,
    url: webmcpTestCdpUrl,
    close: () => undefined
  };
  const executor: WebMcpExecutor = createWebMcpExecutor({
    runtime: { connect: async () => connection, close: async () => undefined },
    policy: webmcpTestPolicy,
    gate: openGate,
    audit: (event) => events.push(event),
    now: () => new Date("2026-01-01T00:00:00.000Z")
  });
  return { cdp, connection, executor, events, names: (): string[] => events.map((event) => event.name) };
}

function closedExecutor(cdp: ReturnType<typeof createFakeCdpSession>, gate = resolveWebMcpExecutionGate({})) {
  return createWebMcpExecutor({
    runtime: {
      connect: async () => ({ ...cdp.session, url: webmcpTestCdpUrl, close: () => undefined }),
      close: async () => undefined
    },
    policy: webmcpTestPolicy,
    gate
  });
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected a rejection with code ${code}`);
}

describe("discovery", () => {
  it("fails closed on a page without document.modelContext", async () => {
    const h = harness({ supported: false });
    await rejectsWithCode(h.executor.discover(), WebMcpErrorCode.Unsupported);
  });

  it("returns an empty list when the page exposes no tools", async () => {
    const h = harness({ tools: [] });
    const result = await h.executor.discover();
    expect(result.supported).toBe(true);
    expect(result.tools).toEqual([]);
    expect(result.undeclaredToolCount).toBe(0);
  });

  it("converts the stringified schema and lists only ACS-declared tools", async () => {
    const h = harness({
      tools: [readTool(), rawTool({ name: "secret_admin_tool", annotations: webmcpReadAnnotations })]
    });
    const result = await h.executor.discover();
    expect(result.tools.map((record) => record.tool.name)).toEqual(["get_showroom_hours"]);
    expect(typeof result.tools[0]?.tool.inputSchema).toBe("object");
    expect(result.tools[0]?.tool.inputSchema.properties.day).toEqual({ type: "string", enum: ["mon", "tue"] });
    expect(result.tools[0]?.origin).toBe("http://127.0.0.1:8799");
    expect(result.undeclaredToolCount).toBe(1);
    expect(result.tools.every((record) => record.discoveryId.length === 64)).toBe(true);
    expect(h.names()).toContain("webmcp.discovery_listed");
  });

  it("fails closed on a malformed schema", async () => {
    const h = harness({ tools: [rawTool({ name: "get_showroom_hours", schema: "{ not json" })] });
    await rejectsWithCode(h.executor.discover(), WebMcpErrorCode.SchemaInvalid);
  });

  it("fails closed on duplicate tool registrations", async () => {
    const h = harness({ tools: [readTool(), readTool()] });
    await rejectsWithCode(h.executor.discover(), WebMcpErrorCode.RegistrationInvalid);
  });

  it("refuses to discover while the live-execution gate is closed", async () => {
    const cdp = createFakeCdpSession({ supported: true, url: webmcpTestUrl, loaderId: LOADER_A, tools: [readTool()] });
    await rejectsWithCode(closedExecutor(cdp).discover(), WebMcpErrorCode.GateClosed);
  });

  it("refuses discovery when the page navigated during getTools()", async () => {
    const h = harness();
    const original = h.cdp.session.send.bind(h.cdp.session);
    let frames = 0;
    h.connection.send = async (method, params, signal) => {
      if (method === "Page.getFrameTree") {
        frames += 1;
        if (frames === 2) h.cdp.navigate(`${webmcpTestUrl}other`, LOADER_B);
      }
      return original(method, params, signal);
    };
    await rejectsWithCode(h.executor.discover(), WebMcpErrorCode.NavigationChanged);
  });
});

describe("execution", () => {
  it("executes an approved read-only call and normalizes the stringified result", async () => {
    const h = harness();
    const fixture = makeWebMcpCallFixture({ discovery: webmcpReadDiscovery, args: { day: "mon" } });
    const result = await h.executor.execute({ authorization: fixture.authorize() });
    expect(result.ok).toBe(true);
    expect(result.toolName).toBe("get_showroom_hours");
    expect(result.result).toEqual({ ok: true, tool: "get_showroom_hours", echo: { day: "mon" } });
    expect(result.risk).toBe("read_only");
    expect(result.resultHash).toHaveLength(64);
    expect(h.cdp.executed).toHaveLength(1);
    expect(JSON.parse(h.cdp.executed[0]!.argsJson)).toEqual({ day: "mon" });
  });

  it("emits canonical audit evidence in order", async () => {
    const h = harness();
    const fixture = makeWebMcpCallFixture({ discovery: webmcpReadDiscovery, args: { day: "mon" } });
    await h.executor.execute({ authorization: fixture.authorize() });
    expect(h.names()).toEqual([
      "execution.started",
      "webmcp.tool_called",
      "execution.authorization_granted",
      "webmcp.tool_succeeded",
      "execution.completed"
    ]);
    const granted = h.events.find((event) => event.name === "execution.authorization_granted");
    expect(granted?.attributes["work_item.id"]).toBe("wi-webmcp-1");
    expect(granted?.attributes["execution.mode"]).toBe("webmcp");
    expect(granted?.attributes["webmcp.origin"]).toBe("http://127.0.0.1:8799");
    const called = h.events.find((event) => event.name === "webmcp.tool_called");
    // Arguments are never persisted raw.
    expect(JSON.stringify(called?.body)).not.toContain("mon");
  });

  it("refuses a mutation without approval and produces no browser effect", async () => {
    const h = harness();
    const fixture = makeWebMcpCallFixture({ discovery: webmcpMutationDiscovery, args: { method: "email" } });
    expectCode(() => fixture.authorize(), "webmcp_approval_required");
    expect(h.cdp.executed).toHaveLength(0);
  });

  it("executes an approved mutation exactly once and rejects a replay", async () => {
    const h = harness();
    const fixture = makeWebMcpCallFixture({
      discovery: webmcpMutationDiscovery,
      args: { method: "email" },
      approvalId: "appr-1"
    });
    const authorization = fixture.authorize();
    const first = await h.executor.execute({ authorization });
    expect(first.risk).toBe("reversible_mutation");
    expect(h.cdp.executed).toHaveLength(1);

    await rejectsWithCode(h.executor.execute({ authorization }), WebMcpErrorCode.ReplayRejected);
    expect(h.cdp.executed).toHaveLength(1);
    expect(h.names()).toContain("webmcp.replay_rejected");
  });

  it("refuses a mutating tool the page tried to declare read-only", async () => {
    const h = harness({
      tools: [rawTool({ name: "set_preferred_contact", schema: mutationSchema, annotations: webmcpReadAnnotations })]
    });
    const fixture = makeWebMcpCallFixture({ discovery: webmcpMutationDiscovery, args: { method: "email" } });
    expectCode(() => fixture.authorize(), "webmcp_approval_required");
    expect(h.cdp.executed).toHaveLength(0);
  });

  it("refuses a read-only tool the page marked consequential", async () => {
    const h = harness();
    const escalated = makeWebMcpCallFixture({
      discovery: webmcpReadDiscovery,
      args: { day: "mon" },
      leaseOverrides: {},
      approvalId: undefined
    });
    // With no annotations at all the declared read-only tool escalates; the
    // executor must then require approval rather than executing.
    expect(escalated.authorize().risk).toBe("read_only");
    expect(h.cdp.executed).toHaveLength(0);
  });

  it("refuses a non-branded authorization", async () => {
    const h = harness();
    await rejectsWithCode(
      h.executor.execute({ authorization: { workItemId: "wi-webmcp-1", toolName: "get_showroom_hours" } }),
      "webmcp_authorization_required"
    );
    expect(h.cdp.executed).toHaveLength(0);
  });

  it("fails closed when the page throws during the tool call", async () => {
    const h = harness({
      onExecute: () => {
        throw new Error("showroom backend unavailable");
      }
    });
    const fixture = makeWebMcpCallFixture({ discovery: webmcpReadDiscovery, args: { day: "mon" } });
    await rejectsWithCode(h.executor.execute({ authorization: fixture.authorize() }), WebMcpErrorCode.ToolFailed);
    const failed = h.events.find((event) => event.name === "webmcp.tool_failed");
    expect(failed?.attributes["execution.terminal_outcome"]).toBe("failed");
    expect(failed?.attributes["execution.error_code"]).toBe("webmcp_tool_failed");
  });

  it("fails closed when the tool returns non-JSON", async () => {
    const h = harness({ onExecute: () => "not json" });
    const fixture = makeWebMcpCallFixture({ discovery: webmcpReadDiscovery, args: { day: "mon" } });
    await rejectsWithCode(h.executor.execute({ authorization: fixture.authorize() }), WebMcpErrorCode.ResultInvalid);
  });

  it("refuses a non-string tool result", async () => {
    const h = harness({ onExecute: () => 42 });
    const fixture = makeWebMcpCallFixture({ discovery: webmcpReadDiscovery, args: { day: "mon" } });
    await rejectsWithCode(h.executor.execute({ authorization: fixture.authorize() }), WebMcpErrorCode.ResultInvalid);
  });

  it("honours cancellation before touching the page", async () => {
    const h = harness();
    const fixture = makeWebMcpCallFixture({ discovery: webmcpReadDiscovery, args: { day: "mon" } });
    const controller = new AbortController();
    controller.abort();
    await rejectsWithCode(
      h.executor.execute({ authorization: fixture.authorize(), signal: controller.signal }),
      WebMcpErrorCode.Cancelled
    );
    expect(h.cdp.executed).toHaveLength(0);
    const failed = h.events.find((event) => event.name === "webmcp.tool_failed");
    expect(failed?.attributes["execution.terminal_outcome"]).toBe("aborted");
  });

  it("rejects a stale handle after a navigation", async () => {
    const h = harness({
      onExecute: (name, argsJson) => {
        h.cdp.navigate(`${webmcpTestUrl}moved`, LOADER_B);
        return JSON.stringify({ ok: true, tool: name, echo: JSON.parse(argsJson) as unknown });
      }
    });
    const fixture = makeWebMcpCallFixture({ discovery: webmcpReadDiscovery, args: { day: "mon" } });
    await rejectsWithCode(h.executor.execute({ authorization: fixture.authorize() }), WebMcpErrorCode.NavigationChanged);
    expect(h.names()).toContain("webmcp.stale_binding_rejected");
  });

  it("rejects a stale handle after an origin change", async () => {
    const h = harness({
      onExecute: (name, argsJson) => {
        h.cdp.setState({ url: "http://127.0.0.1:8800/", loaderId: LOADER_B });
        return JSON.stringify({ ok: true, tool: name, echo: JSON.parse(argsJson) as unknown });
      }
    });
    const fixture = makeWebMcpCallFixture({ discovery: webmcpReadDiscovery, args: { day: "mon" } });
    await rejectsWithCode(h.executor.execute({ authorization: fixture.authorize() }), WebMcpErrorCode.OriginChanged);
  });

  it("rejects a tool that is no longer registered", async () => {
    const h = harness();
    const fixture = makeWebMcpCallFixture({ discovery: webmcpReadDiscovery, args: { day: "mon" } });
    const authorization = fixture.authorize();
    h.cdp.setState({ tools: [] });
    await rejectsWithCode(h.executor.execute({ authorization }), WebMcpErrorCode.ToolNotFound);
    expect(h.cdp.executed).toHaveLength(0);
  });

  it("rejects a registration change with the same name", async () => {
    const h = harness();
    const fixture = makeWebMcpCallFixture({ discovery: webmcpReadDiscovery, args: { day: "mon" } });
    const authorization = fixture.authorize();
    h.cdp.setState({
      tools: [rawTool({ name: "get_showroom_hours", description: "now does something else", annotations: webmcpReadAnnotations })]
    });
    await rejectsWithCode(h.executor.execute({ authorization }), WebMcpErrorCode.ToolChanged);
    expect(h.cdp.executed).toHaveLength(0);
  });

  it("rejects a schema change", async () => {
    const h = harness();
    const fixture = makeWebMcpCallFixture({ discovery: webmcpReadDiscovery, args: { day: "mon" } });
    const authorization = fixture.authorize();
    h.cdp.setState({
      tools: [
        rawTool({
          name: "get_showroom_hours",
          schema: {
            type: "object",
            properties: { day: { type: "string", enum: ["mon", "tue", "wed"] } },
            required: ["day"],
            additionalProperties: false
          },
          annotations: webmcpReadAnnotations
        })
      ]
    });
    await rejectsWithCode(h.executor.execute({ authorization }), WebMcpErrorCode.SchemaChanged);
  });

  it("refuses to execute while the live-execution gate is closed", async () => {
    const cdp = createFakeCdpSession({ supported: true, url: webmcpTestUrl, loaderId: LOADER_A, tools: [readTool()] });
    const fixture = makeWebMcpCallFixture({ discovery: webmcpReadDiscovery, args: { day: "mon" } });
    await rejectsWithCode(
      closedExecutor(cdp, resolveWebMcpExecutionGate({ ACS_WEBMCP_LIVE: "1" })).execute({
        authorization: fixture.authorize()
      }),
      WebMcpErrorCode.GateClosed
    );
    expect(cdp.executed).toHaveLength(0);
  });
});

describe("parseToolResult", () => {
  it("rejects empty and non-JSON results", () => {
    expectCode(() => parseToolResult(""), "webmcp_result_invalid");
    expectCode(() => parseToolResult("<html>"), "webmcp_result_invalid");
  });

  it("accepts every JSON value shape", () => {
    expect(parseToolResult('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolResult("null")).toBeNull();
    expect(parseToolResult("42")).toBe(42);
    expect(parseToolResult('"ok"')).toBe("ok");
  });
});
