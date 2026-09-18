import { afterEach, describe, expect, it, vi } from "vitest";
import healthApi from "../api/health.js";
import protectedResourceApi from "../api/oauth-protected-resource.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Vercel API entrypoints", () => {
  it("serves a no-store health response", async () => {
    const response = healthApi.fetch();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      status: "ok",
      transport: "vercel-queue"
    });
  });

  it("serves OAuth protected-resource metadata from env", async () => {
    vi.stubEnv("ACS_VERCEL_PUBLIC_AUTH_MODE", "oauth");
    vi.stubEnv("ACS_VERCEL_PUBLIC_RESOURCE_URL", "https://acs.example/mcp");
    vi.stubEnv("ACS_VERCEL_OAUTH_AUDIENCE", "https://acs.example/mcp");
    vi.stubEnv("ACS_VERCEL_OAUTH_ISSUER", "https://issuer.example");
    vi.stubEnv("ACS_VERCEL_OAUTH_AUTHORIZATION_SERVER", "https://issuer.example");
    vi.stubEnv("ACS_VERCEL_OAUTH_SCOPES", "acs:work:read,acs:work:create");

    const response = protectedResourceApi.fetch();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resource: "https://acs.example/mcp",
      authorization_servers: ["https://issuer.example"],
      scopes_supported: ["acs:work:read", "acs:work:create"]
    });
  });

  it("boots the MCP entrypoint and rejects missing static bearer auth", async () => {
    vi.stubEnv("ACS_VERCEL_PUBLIC_AUTH_MODE", "static_bearer");
    vi.stubEnv("ACS_VERCEL_MCP_TOKEN", "entrypoint-secret");
    vi.stubEnv("ACS_VERCEL_QUEUE_REGION", "iad1");
    vi.stubEnv("ACS_VERCEL_MCP_TIMEOUT_MS", "85000");

    const module = await import("../api/mcp.js");
    const response = await module.default.fetch(
      new Request("https://acs.example/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "ping"
        })
      })
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(module.config.maxDuration).toBe(120);
  });
});
