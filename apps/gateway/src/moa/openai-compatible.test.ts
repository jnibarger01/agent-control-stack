import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  registerOpenAiCompatibleGateway,
  type InferenceAuditEvent
} from "./openai-compatible.js";

interface CapturedCall {
  url: string;
  init?: RequestInit;
}

function testApp(options: { allowedModels?: ReadonlySet<string> | "*"; upstreamBody?: string; upstreamType?: string } = {}) {
  const calls: CapturedCall[] = [];
  const events: InferenceAuditEvent[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(options.upstreamBody ?? JSON.stringify({ id: "resp_test", object: "response", status: "completed" }), {
      status: 200,
      headers: {
        "content-type": options.upstreamType ?? "application/json",
        "x-request-id": "req_openai_test"
      }
    });
  }) as typeof fetch;
  const app = Fastify({ logger: false });
  registerOpenAiCompatibleGateway(app, {
    authenticate: async (request) => request.headers.authorization === "Bearer acs-token" ? { actor: "operator" } : null,
    apiKey: "upstream-secret",
    upstreamBaseUrl: "https://api.openai.com/v1",
    allowedModels: options.allowedModels ?? new Set(["gpt-5.6-sol"]),
    audit: { record: (event) => events.push(event) },
    fetchImpl,
    newRequestId: () => "inf_test"
  });
  return { app, calls, events };
}

describe("OpenAI-compatible inference gateway", () => {
  it("rejects unauthenticated inference before any upstream call", async () => {
    const { app, calls, events } = testApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: { model: "gpt-5.6-sol", input: "hello" }
    });
    expect(response.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
    expect(events.at(-1)?.type).toBe("request_denied");
    await app.close();
  });

  it("fails closed when the requested model is outside the configured allowlist", async () => {
    const { app, calls, events } = testApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer acs-token" },
      payload: { model: "not-allowed", input: "secret prompt text" }
    });
    expect(response.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "request_denied", model: "not-allowed", decision: "deny" });
    expect(JSON.stringify(events)).not.toContain("secret prompt text");
    await app.close();
  });

  it("proxies an allowed Responses API call with the ACS-held upstream credential", async () => {
    const { app, calls, events } = testApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer acs-token", accept: "application/json" },
      payload: { model: "gpt-5.6-sol", input: "hello", stream: false }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-acs-request-id"]).toBe("inf_test");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/responses");
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer upstream-secret");
    expect(headers.get("x-acs-inference-hop")).toBe("1");
    expect(events.some((event) => event.type === "upstream_completed" && event.upstreamStatus === 200)).toBe(true);
    await app.close();
  });

  it("preserves SSE response bodies and rejects recursive proxy hops", async () => {
    const streaming = testApp({ upstreamBody: "data: {\"type\":\"response.completed\"}\n\n", upstreamType: "text/event-stream" });
    const streamed = await streaming.app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer acs-token" },
      payload: { model: "gpt-5.6-sol", input: "hello", stream: true }
    });
    expect(streamed.statusCode).toBe(200);
    expect(streamed.headers["content-type"]).toContain("text/event-stream");
    expect(streamed.body).toContain("response.completed");
    await streaming.app.close();

    const recursive = testApp();
    const rejected = await recursive.app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer acs-token", "x-acs-inference-hop": "1" },
      payload: { model: "gpt-5.6-sol", input: "hello" }
    });
    expect(rejected.statusCode).toBe(508);
    expect(recursive.calls).toHaveLength(0);
    await recursive.app.close();
  });
});
