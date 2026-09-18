import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createBridgeAuthorizationAad, openBridgeAuthorization } from "@agent-control-stack/vercel-bridge-contract";
import { createOauthBearerAuthorizer } from "./oauth.js";

const context = {
  requestId: "req_oauth",
  resultTopic: "acs-mcp-result-req_oauth",
  expiresAt: "2026-09-18T18:00:00.000Z"
};

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return {
    privateKeyPem: String(privateKey.export({ type: "pkcs8", format: "pem" })),
    publicKeyPem: String(publicKey.export({ type: "spki", format: "pem" }))
  };
}

describe("OAuth ingress authorizer", () => {
  it("verifies then encrypts the bearer token for local ACS", async () => {
    const { privateKeyPem, publicKeyPem } = keys();
    const verifyToken = vi.fn(async (_token: string) => undefined);
    const authorizer = createOauthBearerAuthorizer({
      issuer: "https://issuer.example",
      audience: "https://acs.example/mcp",
      jwksUri: "https://issuer.example/jwks",
      resourceMetadataUrl: "https://acs.example/.well-known/oauth-protected-resource/mcp",
      bridgePublicKeyPem: publicKeyPem,
      verifyToken
    });
    const result = await authorizer(
      new Request("https://acs.example/mcp", {
        headers: { authorization: "Bearer jwt-token-value" }
      }),
      context
    );

    expect(result.ok).toBe(true);
    expect(verifyToken).toHaveBeenCalledWith("jwt-token-value");
    if (!result.ok || !result.auth) throw new Error("missing encrypted auth");
    const aad = createBridgeAuthorizationAad(context);
    expect(openBridgeAuthorization(result.auth, privateKeyPem, aad)).toBe("Bearer jwt-token-value");
    expect(JSON.stringify(result.auth)).not.toContain("jwt-token-value");
  });

  it("returns MCP OAuth discovery challenge when bearer is missing", async () => {
    const { publicKeyPem } = keys();
    const authorizer = createOauthBearerAuthorizer({
      issuer: "https://issuer.example",
      audience: "https://acs.example/mcp",
      jwksUri: "https://issuer.example/jwks",
      resourceMetadataUrl: "https://acs.example/.well-known/oauth-protected-resource/mcp",
      bridgePublicKeyPem: publicKeyPem,
      verifyToken: vi.fn()
    });

    const result = await authorizer(new Request("https://acs.example/mcp"), context);

    expect(result).toEqual({
      ok: false,
      wwwAuthenticate: 'Bearer resource_metadata="https://acs.example/.well-known/oauth-protected-resource/mcp"'
    });
  });
  it("rejects an invalid JWT without leaking verifier details", async () => {
    const { publicKeyPem } = keys();
    const authorizer = createOauthBearerAuthorizer({
      issuer: "https://issuer.example",
      audience: "https://acs.example/mcp",
      jwksUri: "https://issuer.example/jwks",
      resourceMetadataUrl: "https://acs.example/.well-known/oauth-protected-resource/mcp",
      bridgePublicKeyPem: publicKeyPem,
      verifyToken: vi.fn(async () => {
        throw new Error("sensitive verifier detail");
      })
    });

    const result = await authorizer(
      new Request("https://acs.example/mcp", {
        headers: { authorization: "Bearer bad-token" }
      }),
      context
    );

    expect(result).toEqual({
      ok: false,
      wwwAuthenticate:
        'Bearer resource_metadata="https://acs.example/.well-known/oauth-protected-resource/mcp", error="invalid_token"'
    });
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });
});
