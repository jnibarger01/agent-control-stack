import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateMcpToolAllowlist,
  parseMcpToolAllowlistJson,
  resolveMcpToolAllowlist,
  resolveMcpToolAllowlistMode
} from "./mcp-tool-allowlist.js";
import { buildGateway } from "./server.js";

const oauthIssuer = "https://auth.example.test";
const oauthResource = "https://acs.example.test/mcp";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("MCP tool allowlist config", () => {
  it("treats missing config as feature-off (empty entries)", () => {
    const config = resolveMcpToolAllowlist({ env: {}, mode: "local" });
    expect(config.entries.size).toBe(0);
    expect(evaluateMcpToolAllowlist(config, "anyone", "create_work_item")).toEqual({ allowed: true });
  });

  it("parses identity → tool arrays from JSON", () => {
    const parsed = parseMcpToolAllowlistJson(
      JSON.stringify({
        "agent-a": ["get_work_item"],
        "agent-b": ["get_work_item", "list_work_items"]
      })
    );
    expect(parsed).toEqual({
      "agent-a": ["get_work_item"],
      "agent-b": ["get_work_item", "list_work_items"]
    });
  });

  it("denies a listed identity calling a tool off its list and allows another identity", () => {
    const config = resolveMcpToolAllowlist({
      mode: "local",
      allowlist: {
        "agent-a": ["list_work_items"],
        "agent-b": ["get_work_item", "list_work_items"]
      }
    });
    expect(evaluateMcpToolAllowlist(config, "agent-a", "get_work_item")).toEqual({
      allowed: false,
      reason: "MCP tool not allowed for identity agent-a: get_work_item"
    });
    expect(evaluateMcpToolAllowlist(config, "agent-b", "get_work_item")).toEqual({ allowed: true });
  });

  it("default-denies unknown identities in production mode when allowlist is configured", () => {
    expect(resolveMcpToolAllowlistMode({ NODE_ENV: "production" })).toBe("production");
    const config = resolveMcpToolAllowlist({
      mode: "production",
      allowlist: { "agent-b": ["get_work_item"] }
    });
    expect(config.defaultDenyUnknown).toBe(true);
    expect(evaluateMcpToolAllowlist(config, "unknown-agent", "get_work_item")).toEqual({
      allowed: false,
      reason: "MCP identity not in tool allowlist: unknown-agent"
    });
  });

  it("keeps the permissive local default for unknown identities", () => {
    const config = resolveMcpToolAllowlist({
      mode: "local",
      allowlist: { "agent-b": ["get_work_item"] }
    });
    expect(config.defaultDenyUnknown).toBe(false);
    expect(evaluateMcpToolAllowlist(config, "unknown-agent", "get_work_item")).toEqual({ allowed: true });
  });
});

describe("gateway MCP per-identity tool allowlist", () => {
  it("denies identity A and allows identity B for the same tool", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-mcp-allowlist-"));
    directories.push(directory);
    const oauth = createTestOAuth();
    const app = buildGateway({
      dbPath: join(directory, "control.db"),
      logger: false,
      auth: { token: "gateway-token", actor: "user", actorId: "user" },
      mcpAuth: { oauth: oauth.options },
      mcpToolAllowlist: {
        "agent-a": ["list_work_items"],
        "agent-b": ["get_work_item", "list_work_items"]
      },
      mcpToolAllowlistMode: "local",
      acpAdapter: false,
      moa: false
    });

    try {
      const denied = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${oauth.token({ sub: "agent-a", scope: "acs:work:read" })}` },
        payload: {
          jsonrpc: "2.0",
          id: "deny-a",
          method: "tools/call",
          params: { name: "get_work_item", arguments: { id: "wrk_missing" } }
        }
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error).toMatchObject({
        code: -32003,
        message: "MCP tool not allowed for identity agent-a: get_work_item"
      });

      const allowed = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${oauth.token({ sub: "agent-b", scope: "acs:work:read" })}` },
        payload: {
          jsonrpc: "2.0",
          id: "allow-b",
          method: "tools/call",
          params: { name: "get_work_item", arguments: { id: "wrk_missing" } }
        }
      });
      // Auth + allowlist passed; missing work item returns successfully with empty structured content.
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json().error).toBeUndefined();
      expect(allowed.json().result.content[0].text).toContain("get_work_item completed");
    } finally {
      await app.close();
    }
  });

  it("default-denies unknown identities in production mode", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-mcp-allowlist-prod-"));
    directories.push(directory);
    const oauth = createTestOAuth();
    const app = buildGateway({
      dbPath: join(directory, "control.db"),
      logger: false,
      auth: { token: "gateway-token", actor: "user", actorId: "user" },
      mcpAuth: { oauth: oauth.options },
      mcpToolAllowlist: { "agent-b": ["list_work_items"] },
      mcpToolAllowlistMode: "production",
      acpAdapter: false,
      moa: false
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer ${oauth.token({ sub: "unknown-agent", scope: "acs:work:read" })}`
        },
        payload: {
          jsonrpc: "2.0",
          id: "deny-unknown",
          method: "tools/call",
          params: { name: "list_work_items", arguments: {} }
        }
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toMatchObject({
        code: -32003,
        message: "MCP identity not in tool allowlist: unknown-agent"
      });
    } finally {
      await app.close();
    }
  });
});

function createTestOAuth() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "allowlist-test-key";
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" };
  const nowSeconds = Math.floor(Date.now() / 1000);
  const options = {
    issuer: oauthIssuer,
    audience: oauthResource,
    resource: oauthResource,
    jwks: { keys: [jwk] },
    authorizationServers: [oauthIssuer]
  };

  function token(overrides: Record<string, unknown> = {}): string {
    const header = { alg: "RS256", typ: "JWT", kid };
    const claims = {
      iss: oauthIssuer,
      sub: "user_123",
      aud: oauthResource,
      exp: nowSeconds + 300,
      iat: nowSeconds,
      scope: "acs:work:read",
      ...overrides
    };
    const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
    const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
    return `${signingInput}.${signature}`;
  }

  return { options, token };
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
