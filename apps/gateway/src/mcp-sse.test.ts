import { describe, expect, it } from "vitest";
import { buildGateway } from "./server.js";

describe("classic authenticated MCP SSE transport", () => {
  it("opens an authenticated SSE session and publishes its message endpoint", async () => {
    const app = buildGateway({
      logger: false,
      auth: { token: "dashboard", actor: "user" },
      mcpAuth: { localBearerToken: "mcp-token" }
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("gateway did not bind a TCP port");
    const controller = new AbortController();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/sse`, {
        headers: { authorization: "Bearer mcp-token" },
        signal: controller.signal
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("SSE response has no body");
      const first = await reader.read();
      const text = new TextDecoder().decode(first.value);
      expect(text).toMatch(/^event: endpoint\ndata: \/messages\?sessionId=[0-9a-f-]+\n\n$/u);
      await reader.cancel();
    } finally {
      controller.abort();
      await app.close();
    }
  });

  it("rejects an unauthenticated SSE session", async () => {
    const app = buildGateway({ logger: false, mcpAuth: { localBearerToken: "mcp-token" } });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("gateway did not bind a TCP port");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/sse`);
      expect(response.status).toBe(401);
    } finally {
      await app.close();
    }
  });
});
