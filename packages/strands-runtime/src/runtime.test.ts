import { describe, expect, it, vi } from "vitest";
import { InterruptResponseContent } from "@strands-agents/sdk";
import { createAcsAgent } from "./agent.js";
import {
  AcsClient,
  AcsError,
  type AcsApi,
  type DispatchOutcome,
  type InvocationRequest,
  type WorkItem
} from "./acs-client.js";
import { createModel } from "./models.js";
import { ScriptedToolModel } from "./test-model.js";

type Status = WorkItem["status"];
function fixture(
  status: Status = "approved",
  name = "list_directory",
  args = { path: "/repo" } as Record<string, unknown>,
  options: { bridgeCompletes?: boolean } = {}
) {
  const bridgeCompletes = options.bridgeCompletes ?? true;
  let item: WorkItem | undefined;
  let clock = 0;
  const api = {
    createInvocation: vi.fn(async (input: InvocationRequest) => {
      const correlationId = `strands:${input.sessionId}:${input.invocationId}`;
      item ??= {
        id: "wrk_test",
        status,
        metadata: { correlationId },
        requestedActions: [{ kind: "fs.list", params: { tool: input.tool } }]
      };
      return { workItemId: item.id, status: item.status, correlationId: item.metadata.correlationId };
    }),
    dispatch: vi.fn(async (): Promise<DispatchOutcome> => {
      if (item!.status === "needs_approval") return "require_approval";
      if (item!.status !== "approved") return "not_dispatchable";
      if (bridgeCompletes) item!.status = "succeeded"; // the managed bridge executes once
      return "dispatched";
    }),
    get: vi.fn(async () => structuredClone(item!)),
    result: vi.fn(async () => ({
      workItemId: "wrk_test",
      resultId: "res_test",
      leaseId: "lease_test",
      workerId: "acs-dc-bridge",
      actionHash: "hash",
      payloadHash: "hash",
      outcome: "succeeded" as const,
      output: "agent-control-stack",
      executionMode: "desktop_commander" as const,
      toolName: name,
      requestId: "request_test",
      invocationFingerprint: "hash",
      audit: {
        authorizationEventId: "evt-auth",
        capabilityEventId: "evt-cap",
        completionEventId: "evt-done",
        policyDecisionHash: "hash",
        attemptId: "attempt",
        runtimeId: "runtime",
        capabilityRequestHash: "hash",
        keyId: "key"
      }
    }))
  } satisfies AcsApi;
  const model = new ScriptedToolModel(name, args);
  const timing = {
    pollMs: 10,
    waitMs: 100,
    redispatchMs: 1_000,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    }
  };
  const agent = createAcsAgent({ api, model, sessionId: "session-test", timing });
  return {
    api,
    model,
    agent,
    timing,
    setStatus: (s: Status) => {
      item!.status = s;
    },
    corrupt: () => {
      item!.metadata.correlationId = "wrong";
    }
  };
}
const responses = (result: Awaited<ReturnType<ReturnType<typeof createAcsAgent>["invoke"]>>) =>
  result.interrupts!.map((i) => new InterruptResponseContent({ interruptId: i.id, response: "approved" }));
const reasonCode = (result: Awaited<ReturnType<ReturnType<typeof createAcsAgent>["invoke"]>>) =>
  (result.interrupts![0].reason as { code: string }).code;

describe("Strands ACS authority boundary", () => {
  it("pauses a mutation on require_approval, ignores the resume claim, and executes once after ACS approval", async () => {
    const f = fixture("needs_approval", "write_file", { path: "/repo/test.txt", content: "marker", mode: "rewrite" });
    let result = await f.agent.invoke("write marker");
    expect(result.stopReason).toBe("interrupt");
    expect(reasonCode(result)).toBe("require_approval");
    // Resuming does not approve anything: ACS still says needs_approval.
    result = await f.agent.invoke(responses(result));
    expect(result.stopReason).toBe("interrupt");
    expect(reasonCode(result)).toBe("require_approval");
    expect(f.api.result).not.toHaveBeenCalled();
    f.setStatus("approved"); // a human approved in ACS
    result = await f.agent.invoke(responses(result));
    expect(result.stopReason).toBe("endTurn");
    expect(f.api.createInvocation).toHaveBeenCalledTimes(1);
    // Dispatch is idempotent; exactly one call was actually handed to the executor.
    const outcomes = await Promise.all(f.api.dispatch.mock.results.map((r) => r.value));
    expect(outcomes.filter((o) => o === "dispatched")).toHaveLength(1);
    expect(f.api.result).toHaveBeenCalledTimes(1);
    expect(f.api.createInvocation.mock.calls[0][0]).toMatchObject({
      tool: "write_file",
      arguments: { content: "marker" }
    });
  });
  it("returns authorization denial rather than an approval or transport interrupt", async () => {
    const f = fixture();
    f.api.createInvocation.mockRejectedValue(new AcsError("acs_http_403"));
    const result = await f.agent.invoke("list /repo");
    expect(result.stopReason).toBe("endTurn");
    expect(JSON.stringify(f.model.seen[1])).toContain("acs_http_403");
    expect(f.api.dispatch).not.toHaveBeenCalled();
  });
  it("reads the same result after an unavailable result endpoint without submitting work again", async () => {
    const f = fixture();
    f.api.result.mockRejectedValueOnce(new AcsError("acs_http_404"));
    const paused = await f.agent.invoke("list /repo");
    expect(paused.stopReason).toBe("interrupt");
    expect(reasonCode(paused)).toBe("acs_result_unavailable");
    expect((await f.agent.invoke(responses(paused))).stopReason).toBe("endTurn");
    expect(f.api.createInvocation).toHaveBeenCalledTimes(1);
    expect(f.api.dispatch).toHaveBeenCalledTimes(1);
  });
  it("uses the real SDK loop and returns ACS/DC output to the model", async () => {
    const f = fixture();
    const result = await f.agent.invoke("list /repo");
    expect(result.stopReason).toBe("endTurn");
    expect(f.api.createInvocation).toHaveBeenCalledTimes(1);
    expect(f.api.dispatch).toHaveBeenCalledTimes(1);
    expect(f.model.advertised).toEqual(["list_directory", "read_file", "write_file"]);
    expect(JSON.stringify(f.model.seen[1])).toContain("agent-control-stack");
    expect(JSON.stringify(f.model.seen[1])).toContain("strands:session-test:");
  });
  it("bounds the execution wait and pauses instead of looping when no executor claims the item", async () => {
    const f = fixture("approved", "list_directory", { path: "/repo" }, { bridgeCompletes: false });
    const paused = await f.agent.invoke("list /repo");
    expect(paused.stopReason).toBe("interrupt");
    expect(reasonCode(paused)).toBe("awaiting_execution");
    expect(f.api.get.mock.calls.length).toBeLessThanOrEqual(12);
    expect(f.api.dispatch).toHaveBeenCalledTimes(1); // idempotent re-dispatch only after redispatchMs
    f.setStatus("succeeded");
    expect((await f.agent.invoke(responses(paused))).stopReason).toBe("endTurn");
    expect(f.api.result).toHaveBeenCalledTimes(1);
  });
  it.each(["blocked", "rejected", "failed", "cancelled", "unknown"] as const)(
    "returns structured %s without executing",
    async (status) => {
      const f = fixture(status);
      await f.agent.invoke("list /repo");
      expect(f.api.result).not.toHaveBeenCalled();
      expect(f.api.dispatch).not.toHaveBeenCalled();
      expect(JSON.stringify(f.model.seen[1])).toContain(`acs_${status}`);
    }
  );
  it("retries an ambiguous create only with the same idempotent invocation id", async () => {
    const f = fixture();
    f.api.createInvocation.mockRejectedValueOnce(new AcsError("acs_submission_unknown"));
    const paused = await f.agent.invoke("list /repo");
    expect(paused.stopReason).toBe("interrupt");
    expect(reasonCode(paused)).toBe("acs_submission_unknown");
    expect(f.api.dispatch).not.toHaveBeenCalled();
    expect((await f.agent.invoke(responses(paused))).stopReason).toBe("endTurn");
    const [first, second] = f.api.createInvocation.mock.calls.map((call) => call[0]);
    expect(second.invocationId).toBe(first.invocationId);
    expect(f.api.result).toHaveBeenCalledTimes(1);
  });
  it("rejects changed correlation on resume", async () => {
    const f = fixture("needs_approval");
    const paused = await f.agent.invoke("list /repo");
    f.corrupt();
    f.setStatus("succeeded");
    await f.agent.invoke(responses(paused));
    expect(f.api.result).not.toHaveBeenCalled();
    expect(JSON.stringify(f.model.seen.at(-1))).toContain("acs_binding_mismatch");
  });
  it("fails closed when ACS reports a dispatch binding mismatch", async () => {
    const f = fixture();
    f.api.dispatch.mockRejectedValue(new AcsError("acs_binding_mismatch"));
    await f.agent.invoke("list /repo");
    expect(f.api.result).not.toHaveBeenCalled();
    expect(JSON.stringify(f.model.seen.at(-1))).toContain("acs_binding_mismatch");
  });
  it.each(["shell", "read", "edit", "subagent", "python", "execute"])("does not expose %s", async (name) => {
    const f = fixture();
    const model = new ScriptedToolModel(name);
    const agent = createAcsAgent({ api: f.api, model, sessionId: "session" });
    await agent.invoke("try tool");
    expect(f.api.createInvocation).not.toHaveBeenCalled();
    expect(model.advertised).not.toContain(name);
  });
});

describe("provider configuration", () => {
  it.each(["openai/model", "anthropic/model", "gemini/model", "ollama/qwen3.5:9b"])(
    "constructs %s without ACS changes",
    (selection) => {
      const model = createModel(selection, {
        OPENAI_API_KEY: "test",
        ANTHROPIC_API_KEY: "test",
        GEMINI_API_KEY: "test"
      });
      expect(model.modelId).toBe(selection.slice(selection.indexOf("/") + 1));
    }
  );
  it("rejects unknown providers", () => expect(() => createModel("shell/bash")).toThrow("unsupported_model_provider"));
});

describe("ACS HTTP transport", () => {
  const req = { sessionId: "s", invocationId: "i", tool: "list_directory", arguments: { path: "/repo" } };
  it("never retries POST on ambiguous transport failure", async () => {
    const request = vi.fn().mockRejectedValue(new Error("secret transport detail"));
    const api = new AcsClient("http://127.0.0.1:3000", "secret", request);
    await expect(api.createInvocation(req)).rejects.toThrow("acs_submission_unknown");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1].redirect).toBe("error");
  });
  it.each(["http://remote.example", "https://user:password@example.com", "https://example.com/path"])(
    "rejects unsafe endpoint %s",
    (url) => {
      expect(() => new AcsClient(url, "secret")).toThrow("invalid_acs_configuration");
    }
  );
  it("distinguishes denial from transport ambiguity", async () => {
    const api = new AcsClient(
      "https://acs.example",
      "secret",
      vi.fn().mockResolvedValue(new Response("", { status: 403 }))
    );
    await expect(api.createInvocation(req)).rejects.toThrow("acs_http_403");
    const unknown = new AcsClient(
      "https://acs.example",
      "secret",
      vi.fn().mockResolvedValue(new Response("", { status: 502 }))
    );
    await expect(unknown.createInvocation(req)).rejects.toThrow("acs_submission_unknown");
  });
  it("maps dispatch outcomes without treating approval as failure", async () => {
    const reply = (status: number, body?: unknown) =>
      new AcsClient(
        "https://acs.example",
        "secret",
        vi.fn().mockResolvedValue(new Response(body === undefined ? null : JSON.stringify(body), { status }))
      );
    await expect(reply(202, {}).dispatch("wrk", req)).resolves.toBe("dispatched");
    await expect(reply(409, { code: "require_approval" }).dispatch("wrk", req)).resolves.toBe("require_approval");
    await expect(reply(409, { code: "invocation_binding_mismatch" }).dispatch("wrk", req)).rejects.toThrow(
      "acs_binding_mismatch"
    );
    await expect(reply(404, {}).dispatch("wrk", req)).rejects.toThrow("acs_binding_mismatch");
  });
});

describe("tool defaults", () => {
  it("sends an explicit shallow depth for list_directory so ACS authorizes exactly what runs", async () => {
    const api = {
      createInvocation: vi.fn(async () => {
        throw new AcsError("acs_http_403");
      }),
      dispatch: vi.fn(),
      get: vi.fn(),
      result: vi.fn()
    } as unknown as AcsApi;
    const model = new ScriptedToolModel("list_directory", { path: "/repo" });
    await createAcsAgent({ api, model, sessionId: "depth" }).invoke("list");
    expect((api.createInvocation as ReturnType<typeof vi.fn>).mock.calls[0][0].arguments).toEqual({
      path: "/repo",
      depth: 1
    });
  });
  it("uses Chat Completions for Ollama", () => {
    expect((createModel("ollama/qwen3.5:9b") as unknown as { _api: string })._api).toBe("chat");
  });
  it("passes an allowlisted reasoning effort and rejects anything else", () => {
    const model = createModel("ollama/qwen3.5:9b", { HARNESS_REASONING_EFFORT: "none" }) as unknown as {
      getConfig(): { params?: Record<string, unknown> };
    };
    expect(model.getConfig().params).toEqual({ reasoning_effort: "none" });
    expect(() => createModel("ollama/qwen3.5:9b", { HARNESS_REASONING_EFFORT: "max; rm -rf" })).toThrow(
      "invalid_HARNESS_REASONING_EFFORT"
    );
  });
});
