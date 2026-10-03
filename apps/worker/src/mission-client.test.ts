import { afterEach, describe, expect, it, vi } from "vitest";
import { createMissionRunnerClient, runConfiguredMission } from "./mission-client.js";

const config = {
  gatewayUrl: "http://127.0.0.1:3000",
  gatewayToken: "test-control-token",
  runtimes: { desktop_commander: { url: "http://127.0.0.1:8010/mcp", token: "test-runtime-token" } }
};
afterEach(() => vi.unstubAllGlobals());

describe("mission HTTP client", () => {
  it("separates control/runtime credentials and sends the permit through managed MCP", async () => {
    const sent: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init: RequestInit) => {
        sent.push({ url: String(url), init });
        if (String(url).includes("/work-items/")) return Response.json({ workItem: {} });
        if (init.method === "DELETE") return new Response(null, { status: 204 });
        const message = JSON.parse(String(init.body));
        if (!message.id) return new Response(null, { status: 202 });
        return Response.json(
          { jsonrpc: "2.0", id: message.id, result: {} },
          { headers: { "mcp-session-id": "test-session" } }
        );
      })
    );
    const client = createMissionRunnerClient(config);
    await client.ports.request("GET", "/work-items/mission");
    await client.ports.invoke(
      "desktop_commander",
      "write_file",
      { path: "/tmp/test-file", content: "bounded" },
      "test-permit"
    );
    await client.close();
    expect(new Headers(sent[0]!.init.headers).get("authorization")).toBe("Bearer test-control-token");
    for (const request of sent.slice(1)) {
      expect(new Headers(request.init.headers).get("authorization")).toBe("Bearer test-runtime-token");
      expect(request.init.redirect).toBe("error");
    }
    const call = sent.find((request) => String(request.init.body).includes('"tools/call"'))!;
    expect(JSON.parse(String(call.init.body)).params).toEqual({
      name: "write_file",
      arguments: { path: "/tmp/test-file", content: "bounded" },
      _meta: { acsOperationPermitId: "test-permit" }
    });
    expect(new Headers(call.init.headers).get("mcp-session-id")).toBe("test-session");
    expect(sent.at(-1)!.init.method).toBe("DELETE");
  });

  it("accepts the matching SSE response but refuses a malformed or failed tool result", async () => {
    let toolResponse = "valid";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, init: RequestInit) => {
        const message = JSON.parse(String(init.body));
        if (!message.id) return new Response(null, { status: 202 });
        const result = toolResponse === "failure" ? { isError: true } : {};
        const id = toolResponse === "wrong id" ? -1 : message.id;
        return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`, {
          headers: { "mcp-session-id": "test-session" }
        });
      })
    );
    const client = createMissionRunnerClient(config);
    await client.ports.invoke("desktop_commander", "read_file", { path: "/tmp/test-file" }, "test-permit");
    toolResponse = "wrong id";
    await expect(client.ports.invoke("desktop_commander", "read_file", {}, "test-permit")).rejects.toThrow(
      "expected protocol result"
    );
    toolResponse = "failure";
    await expect(client.ports.invoke("desktop_commander", "read_file", {}, "test-permit")).rejects.toThrow(
      "tool reported failure"
    );
  });

  it("rejects insecure endpoints, URL credentials, conflicts and missing configuration", async () => {
    expect(() => createMissionRunnerClient({ ...config, gatewayUrl: "http://remote.example" })).toThrow(
      "HTTPS or loopback"
    );
    expect(() =>
      createMissionRunnerClient({ ...config, gatewayUrl: "https://user:credential@remote.example" })
    ).toThrow("URL credentials");
    expect(() =>
      createMissionRunnerClient({ ...config, gatewayUrl: "https://remote.example?token=credential" })
    ).toThrow("URL credentials");
    expect(() => createMissionRunnerClient({ ...config, gatewayToken: "" })).toThrow("origin and credential");
    expect(() => createMissionRunnerClient({ ...config, requestTimeoutMs: 0 })).toThrow("timeout is invalid");
    expect(() =>
      createMissionRunnerClient({
        ...config,
        runtimes: { desktop_commander: { ...config.runtimes.desktop_commander, token: "" } }
      })
    ).toThrow("own credential");
    await expect(
      runConfiguredMission({ ACS_MISSION_GRANT_ID: "grant", ACS_MISSION_APPROVAL_ID: "approval" })
    ).rejects.toThrow("one mission authority");
    await expect(runConfiguredMission({ ACS_MISSION_ID: "mission" })).rejects.toThrow("ACS_MISSION_GATEWAY_URL");
  });

  it("fails closed without a configured runtime or on unauthorized or oversized responses", async () => {
    let oversized = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        oversized ? new Response("x".repeat(2 * 1024 * 1024 + 1)) : new Response("{}", { status: 403 })
      )
    );
    const client = createMissionRunnerClient(config);
    await expect(client.ports.invoke("jace_commander", "jc_status", {}, "test-permit")).rejects.toThrow(
      "not configured"
    );
    await expect(client.ports.invoke("desktop_commander", "read_file", {}, "test-permit")).rejects.toThrow(
      "runtime rejected"
    );
    await expect(client.ports.request("POST", "/execution-mode", {})).rejects.toThrow("governed mission routes");
    oversized = true;
    await expect(client.ports.request("GET", "/work-items/mission")).rejects.toThrow("bounded client limit");
  });
});
