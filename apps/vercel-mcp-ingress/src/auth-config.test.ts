import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createIngressAuthorizerFromEnv, protectedResourceMetadataFromEnv } from "./auth-config.js";

function publicKeyPem(): string {
  const { publicKey } = generateKeyPairSync("x25519");
  return String(publicKey.export({ type: "spki", format: "pem" }));
}

describe("ingress auth configuration", () => {
  it("supports static bearer mode", async () => {
    const authorizer = createIngressAuthorizerFromEnv({
      ACS_VERCEL_PUBLIC_AUTH_MODE: "static_bearer",
      ACS_VERCEL_MCP_TOKEN: "shared-secret"
    });
    const result = await authorizer(
      new Request("https://acs.example/mcp", {
        headers: { authorization: "Bearer shared-secret" }
      }),
      {
        requestId: "req_1",
        resultTopic: "acs-mcp-result-req_1",
        expiresAt: "2026-09-18T18:00:00.000Z"
      }
    );
    expect(result).toEqual({ ok: true });
  });

  it("builds OAuth protected-resource metadata", () => {
    expect(
      protectedResourceMetadataFromEnv({
        ACS_VERCEL_PUBLIC_AUTH_MODE: "oauth",
        ACS_VERCEL_PUBLIC_RESOURCE_URL: "https://acs.example/mcp",
        ACS_VERCEL_OAUTH_AUDIENCE: "https://acs.example/mcp",
        ACS_VERCEL_OAUTH_ISSUER: "https://issuer.example",
        ACS_VERCEL_OAUTH_AUTHORIZATION_SERVER: "https://issuer.example",
        ACS_VERCEL_OAUTH_SCOPES: "acs:work:read,acs:work:create"
      })
    ).toEqual({
      resource: "https://acs.example/mcp",
      authorization_servers: ["https://issuer.example"],
      scopes_supported: ["acs:work:read", "acs:work:create"]
    });
  });

  it("fails closed when OAuth resource and audience drift", () => {
    expect(() =>
      createIngressAuthorizerFromEnv({
        ACS_VERCEL_PUBLIC_AUTH_MODE: "oauth",
        ACS_VERCEL_PUBLIC_RESOURCE_URL: "https://acs.example/mcp",
        ACS_VERCEL_OAUTH_AUDIENCE: "https://other.example/mcp",
        ACS_VERCEL_OAUTH_ISSUER: "https://issuer.example",
        ACS_VERCEL_OAUTH_JWKS_URI: "https://issuer.example/jwks",
        ACS_VERCEL_RESOURCE_METADATA_URL: "https://acs.example/.well-known/oauth-protected-resource/mcp",
        ACS_VERCEL_BRIDGE_AUTH_PUBLIC_KEY_PEM: publicKeyPem()
      })
    ).toThrow("must match");
  });
});
